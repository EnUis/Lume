import { describe, expect, it } from 'vitest';
import { createWorkerLogger, workerError } from '../lib/server/worker-log';
import { openDatabase } from '../lib/server/db';
import { enqueue, failJob, finishJob, leaseJob } from '../lib/server/jobs';

function capture(level = 'normal') {
  const output: string[] = []; const errors: string[] = []; let time = 0;
  const logger = createWorkerLogger({ level, now: () => time, output: line => output.push(line), error: line => errors.push(line) });
  return { logger, output, errors, advance: (value: number) => { time = value; } };
}

describe('quiet worker logging', () => {
  it('keeps all ordinary completions quiet, including failed health verification outcomes', () => {
    const { logger, output, errors } = capture();
    logger.completed({ id: 'check-1', type: 'health' }, { ok: true, health: 'healthy', format: 'mp4' });
    for (const status of [401, 403]) logger.completed({ id: `check-${status}`, type: 'health' }, { ok: false, health: 'unknown', error: `Upstream HTTP ${status} (authentication or authorization required)` });
    logger.completed({ id: 'import-1', type: 'sync' }, { added: 5000, processed: 5000 });
    logger.completed({ id: 'metadata-1', type: 'metadata' }, { skipped: true });
    expect(output).toEqual([]); expect(errors).toEqual([]);
  });

  it('quiets recognized provider access-denied failures while showing unexpected errors immediately', () => {
    const { logger, output, errors } = capture();
    logger.failed({ id: 'sync-1', type: 'sync' }, new Error('Playlist HTTP 401: authentication or authorization required'));
    logger.failed({ id: 'health-1', type: 'health' }, new Error('Upstream HTTP 403 (authentication or authorization required)'));
    logger.failed({ id: 'metadata-1', type: 'metadata' }, new Error('Licensed metadata provider returned HTTP 401'));
    expect(errors).toEqual([]);
    logger.failed({ id: 'sync-2', type: 'sync' }, new Error('SQLITE_BUSY: database is locked'));
    logger.failed({ id: 'sync-3', type: 'sync' }, new Error('Unexpected application error after HTTP 401'));
    logger.error('worker.heartbeat.failed', new Error('Heartbeat connection refused'));
    logger.error('worker.lease.failed', new Error('Lease update failed'));
    expect(output).toEqual([]); expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('database is locked'); expect(errors[2]).toContain('heartbeat'); expect(errors[3]).toContain('lease renewal');
  });

  it('sanitizes source/connection URLs, header credentials, JSON secrets and terminal controls', () => {
    const text = workerError(new Error('Connection failed postgresql://user:dbsecret@host/db and https://provider.test/movie/user/pass/1.mp4?token=secret Authorization: Bearer headersecret "api_key":"apikeysecret" password=plainsecret\n\u001b[31mretry later'));
    for (const secret of ['dbsecret', 'provider.test', 'headersecret', 'apikeysecret', 'plainsecret', '\n', '\u001b']) expect(text).not.toContain(secret);
    expect(text).toContain('Connection failed'); expect(text).toContain('retry later'); expect(text.length).toBeLessThanOrEqual(300);
  });

  it('summarizes repeated errors across jobs without delaying a different failure', () => {
    const { logger, errors, advance } = capture();
    logger.failed({ id: 'first', type: 'health' }, new Error('Database connection lost'));
    for (let index = 0; index < 100; index++) logger.failed({ id: `next-${index}`, type: 'health' }, new Error('Database connection lost'));
    expect(errors).toHaveLength(1);
    advance(59000); logger.flush(); expect(errors).toHaveLength(1);
    logger.failed({ id: 'different', type: 'health' }, new Error('Invalid encrypted payload')); expect(errors).toHaveLength(2);
    advance(60000); logger.flush(); expect(errors).toHaveLength(3); expect(errors[2]).toContain('100 repeated failures');
    logger.flush(); expect(errors).toHaveLength(3);
    logger.error('worker.heartbeat.failed', new Error('Database connection lost')); expect(errors).toHaveLength(4);
  });

  it('prints pending repeats on shutdown and always surfaces fatal startup errors', () => {
    const { logger, errors } = capture();
    logger.error('worker.heartbeat.failed', new Error('Database connection lost'));
    logger.error('worker.heartbeat.failed', new Error('Database connection lost'));
    logger.flush(true); expect(errors).toHaveLength(2); expect(errors[1]).toContain('1 repeated failures');
    logger.fatal(new Error('Playlist HTTP 401 during unexpected startup')); expect(errors).toHaveLength(3);
    expect(errors[2]).toContain('Background worker failed');
  });

  it('enables allowlisted sanitized JSON only with the explicit diagnostic setting', () => {
    const { logger, output, errors } = capture('diagnostic');
    const report = { ok: false, health: 'unknown', error: 'Upstream HTTP 401 https://provider.test/private', payload: { password: 'payloadsecret' }, url: 'https://private.test', token: 'tokensecret', nested: { arbitrary: 'nestedsecret' }, latencyMs: Infinity };
    logger.completed({ id: 'check', type: 'health' }, report);
    const entry = JSON.parse(output[0]); expect(entry).toMatchObject({ event: 'job.completed', type: 'health', report: { ok: false, health: 'unknown' } });
    for (const secret of ['provider.test', 'payloadsecret', 'private.test', 'tokensecret', 'nestedsecret']) expect(output[0]).not.toContain(secret);
    expect(entry.report).not.toHaveProperty('latencyMs'); expect(report.payload.password).toBe('payloadsecret');
    logger.failed({ id: 'import', type: 'sync' }, new Error('Playlist HTTP 401: authentication or authorization required'));
    logger.failed({ id: 'import', type: 'sync' }, new Error('Playlist HTTP 401: authentication or authorization required'));
    expect(errors).toHaveLength(2); expect(JSON.parse(errors[0]).event).toBe('job.failed');
    const invalid = capture('debug'); invalid.logger.completed({ id: 'health', type: 'health' }, { ok: true }); expect(invalid.output).toEqual([]);
  });

  it('retains durable health reports and provider-auth retry records when terminal output is quiet', async () => {
    const db = await openDatabase(':memory:'); const { logger, output, errors } = capture();
    try {
      await enqueue(db, 'health', { sourceId: 'sample' }); const health = (await leaseJob(db, 'test-worker'))!;
      const report = { ok: false, health: 'unknown', error: 'Upstream HTTP 401 (authentication or authorization required)' };
      await finishJob(db, health, 'test-worker', report); logger.completed({ id: health.id, type: health.type }, report);
      const stored = (await db.get('SELECT status,report FROM jobs WHERE id=?', [health.id]))!;
      expect(stored.status).toBe('completed'); expect(JSON.parse(stored.report)).toEqual(report);
      await enqueue(db, 'sync', { playlistId: 'provider' }); const sync = (await leaseJob(db, 'test-worker'))!; const denied = new Error('Playlist HTTP 403: authentication or authorization required');
      logger.failed({ id: sync.id, type: sync.type }, denied); await failJob(db, sync, 'test-worker', denied);
      expect(await db.get('SELECT status,error,attempts FROM jobs WHERE id=?', [sync.id])).toMatchObject({ status: 'queued', attempts: 1, error: denied.message });
      expect(output).toEqual([]); expect(errors).toEqual([]);
    } finally { await db.close(); }
  });
});
