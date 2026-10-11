import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { enqueue, finishJob, leaseJob, scheduleDueJobs } from '../lib/server/jobs';
import { createTitle } from '../lib/server/pipeline';

let db: DB;
const indexDefinitions = [
  "CREATE INDEX IF NOT EXISTS jobs_ready_type ON jobs(type,run_after,created_at) WHERE status='queued' AND attempts<max_attempts",
  "CREATE INDEX IF NOT EXISTS jobs_running_type ON jobs(type,run_after,created_at,lease_until) WHERE status='running' AND attempts<max_attempts",
  "CREATE INDEX IF NOT EXISTS jobs_expired_terminal ON jobs(lease_until) WHERE status='running' AND attempts>=max_attempts",
  "CREATE INDEX IF NOT EXISTS jobs_ready_order ON jobs(run_after,created_at) WHERE status='queued' AND attempts<max_attempts",
  "CREATE INDEX IF NOT EXISTS jobs_running_order ON jobs(run_after,created_at,lease_until) WHERE status='running' AND attempts<max_attempts",
];
beforeEach(async () => { db = await openDatabase(':memory:'); for (const sql of indexDefinitions) await db.run(sql); });
afterEach(async () => { await db.close(); });
async function job(id: string, type: string, runAfter: number, createdAt: number, extra: { status?: string; attempts?: number; leaseUntil?: number; owner?: string } = {}) {
  await db.run('INSERT INTO jobs(id,type,payload,status,run_after,created_at,attempts,lease_until,lease_owner) VALUES(?,?,?,?,?,?,?,?,?)', [id, type, '{}', extra.status || 'queued', runAfter, createdAt, extra.attempts || 0, extra.leaseUntil ?? null, extra.owner ?? null]);
}

describe('indexed durable queue claims', () => {
  it('preserves global due-time and creation ordering across job types and expired leases', async () => {
    const now = Date.now();
    await job('health-later', 'health', now - 20, 2);
    await job('metadata-tie-later', 'metadata', now - 30, 3);
    await job('sync-tie-first', 'sync', now - 30, 1);
    await job('expired-oldest', 'health', now - 40, 4, { status: 'running', attempts: 1, leaseUntil: now - 1, owner: 'crashed' });
    await job('unsupported-oldest', 'future-job-type', now - 50, 5);
    await job('future', 'sync', now + 60000, 0);
    const expected = ['unsupported-oldest', 'expired-oldest', 'sync-tie-first', 'metadata-tie-later', 'health-later'];
    for (const id of expected) {
      const claimed = await leaseJob(db, 'worker'); expect(claimed?.id).toBe(id);
      expect(claimed?.lease_owner).toBe('worker'); expect(claimed?.status).toBe('running');
      await finishJob(db, claimed!, 'worker', {});
    }
    expect(await leaseJob(db, 'worker')).toBeNull();
  });

  it('filters worker lanes, excludes current leases, and cleans terminal expired attempts', async () => {
    const now = Date.now();
    await job('sync-first', 'sync', now - 100, 1);
    await job('leased-health', 'health', now - 90, 2, { status: 'running', leaseUntil: now + 60000, owner: 'other' });
    await job('terminal-health', 'health', now - 80, 3, { status: 'running', attempts: 4, leaseUntil: now - 1, owner: 'dead' });
    await job('exhausted-queued', 'health', now - 70, 4, { attempts: 4 });
    await job('ready-metadata', 'metadata', now - 60, 5);
    expect((await leaseJob(db, 'health-lane', ['health', 'metadata']))?.id).toBe('ready-metadata');
    expect(await db.get('SELECT status,lease_owner,lease_until,error FROM jobs WHERE id=?', ['terminal-health'])).toMatchObject({ status: 'failed', lease_owner: null, lease_until: null, error: 'Worker lease expired after maximum attempts' });
    expect((await db.get('SELECT lease_owner FROM jobs WHERE id=?', ['leased-health']))?.lease_owner).toBe('other');
    expect((await leaseJob(db, 'import-lane', ['sync', 'sync']))?.id).toBe('sync-first');
    expect(await leaseJob(db, 'health-lane', ['health'])).toBeNull();
  });

  it('claims each job once when concurrent SQLite workers compete', async () => {
    const now = Date.now(); for (let n = 0; n < 8; n++) await job(`health-${n}`, 'health', now - 1, n);
    const claimed = await Promise.all(Array.from({ length: 12 }, (_, n) => leaseJob(db, `worker-${n}`, ['health'])));
    expect(claimed.filter(Boolean)).toHaveLength(8); expect(new Set(claimed.filter(Boolean).map(row => row!.id)).size).toBe(8);
    expect((await db.get('SELECT SUM(attempts) AS n FROM jobs'))?.n).toBe(8);
  });

  it('uses ordered partial indexes without sorting a 20,000-job queue', async () => {
    const now = Date.now();
    await db.transaction(async tx => {
      for (let n = 0; n < 20000; n++) await tx.run("INSERT INTO jobs(id,type,payload,status,run_after,created_at,attempts) VALUES(?,'health','{}','queued',?,?,?)", [`bulk-${n}`, now - 10000 + n, n, n < 5000 ? 4 : 0]);
    });
    await job('sync-older', 'sync', now - 9000, 2);
    const queries = [
      { sql: "SELECT id,run_after,created_at FROM jobs WHERE status='queued' AND type=? AND run_after<=? AND attempts<max_attempts ORDER BY run_after,created_at LIMIT 1", index: 'jobs_ready_type' },
      { sql: "SELECT id,run_after,created_at FROM jobs WHERE status='running' AND type=? AND lease_until<? AND attempts<max_attempts ORDER BY run_after,created_at LIMIT 1", index: 'jobs_running_type' },
    ];
    for (const { sql, index } of queries) {
      const plan = await db.all('EXPLAIN QUERY PLAN ' + sql, ['health', now]); const details = plan.map(row => row.detail).join('\n');
      expect(details).toContain(index); expect(details).not.toContain('TEMP B-TREE');
    }
    expect((await leaseJob(db, 'worker'))?.id).toBe('sync-older');
    expect((await leaseJob(db, 'health-worker', ['health']))?.id).toBe('bulk-5000');
    for (const status of ['queued', 'running']) {
      const index = status === 'queued' ? 'jobs_ready_order' : 'jobs_running_order';
      const condition = status === 'queued' ? 'run_after<=?' : 'lease_until<?';
      const details = (await db.all(`EXPLAIN QUERY PLAN SELECT id,run_after,created_at FROM jobs INDEXED BY ${index} WHERE status='${status}' AND ${condition} AND attempts<max_attempts ORDER BY run_after,created_at LIMIT 1`, [now])).map(row => row.detail).join('\n');
      expect(details).toContain(index); expect(details).not.toContain('TEMP B-TREE');
    }
  }, 20000);

  it('retains PostgreSQL skip-locked claims and guarded ownership updates', async () => {
    const statements: string[] = []; const now = Date.now();
    const adapter: DB = {
      dialect: 'postgres',
      all: async () => [],
      get: async <T extends Record<string, any>>(sql: string, values: unknown[] = []) => {
        statements.push(sql);
        if (sql.includes("status='queued'") && values[0] === 'health') return { id: 'pg-ready', run_after: now - 1, created_at: 1 } as unknown as T;
        if (sql.includes('lease_owner=?')) return { id: 'pg-ready', lease_owner: values[1], attempts: 1 } as unknown as T;
        return undefined;
      },
      run: async sql => { statements.push(sql); },
      transaction: async fn => fn(adapter), close: async () => {},
    };
    expect((await leaseJob(adapter, 'postgres-worker', ['health', 'metadata']))?.id).toBe('pg-ready');
    const candidates = statements.filter(sql => sql.startsWith('SELECT id,run_after'));
    expect(candidates).toHaveLength(4); for (const sql of candidates) expect(sql).toContain('LIMIT 1 FOR UPDATE SKIP LOCKED');
    expect(statements.find(sql => sql.startsWith('UPDATE jobs SET status=\'running\''))).toContain('attempts<max_attempts');
  });
});

describe('bounded health scheduling', () => {
  async function source(titleId: string, sourceId: string, health = 'unknown', checked: number | null = null, failures = 0) {
    await db.run('INSERT INTO sources(id,title_id,entry_key,name,url_encrypted,url_hash,health,last_checked,failures,created_at) VALUES(?,?,?,?,?,?,?,?,?,1)', [sourceId, titleId, sourceId, 'Fixture', 'fixture', sourceId, health, checked, failures]);
  }

  it('queues a fixed batch with constant round trips and advances past already queued sources', async () => {
    const titleId = await createTitle(db, { name: 'Scheduler Fixture' });
    for (let index = 0; index < 240; index++) await source(titleId, `source-${index}`);
    let statements = 0;
    const counted = (database: DB): DB => ({ ...database,
      all: (sql, values) => { statements++; return database.all(sql, values); },
      get: (sql, values) => { statements++; return database.get(sql, values); },
      run: (sql, values) => { statements++; return database.run(sql, values); },
      transaction: fn => database.transaction(tx => fn(counted(tx))),
    });
    expect(await scheduleDueJobs(counted(db))).toMatchObject({ healthQueued: 100 });
    expect(statements).toBeLessThanOrEqual(8);
    expect(await scheduleDueJobs(db)).toMatchObject({ healthQueued: 100 });
    expect(await scheduleDueJobs(db)).toMatchObject({ healthQueued: 40 });
    expect(await scheduleDueJobs(db)).toMatchObject({ healthQueued: 0 });
    expect((await db.get("SELECT COUNT(*) AS n FROM jobs WHERE type='health'"))?.n).toBe(240);
  });

  it('preserves queued backoff and running leases, revives exhausted attempts, and filters source cooldowns before LIMIT', async () => {
    const titleId = await createTitle(db, { name: 'Retry Scheduler Fixture' }), now = Date.now();
    for (const name of ['queued', 'running', 'exhausted', 'fresh']) await source(titleId, name);
    const queued = await enqueue(db, 'health', { sourceId: 'queued' }, { dedupeKey: 'health:queued', runAfter: now + 3600000 });
    const running = await enqueue(db, 'health', { sourceId: 'running' }, { dedupeKey: 'health:running' });
    await db.run("UPDATE jobs SET status='running',lease_owner='fixture',lease_until=? WHERE id=?", [now + 120000, running]);
    const exhausted = await enqueue(db, 'health', { sourceId: 'exhausted' }, { dedupeKey: 'health:exhausted' });
    await db.run('UPDATE jobs SET attempts=max_attempts WHERE id=?', [exhausted]);
    for (let index = 0; index < 110; index++) await source(titleId, `cooldown-${index}`, 'unavailable', now - 3600000, 6);
    await source(titleId, 'due-failure', 'unavailable', now - 360001, 1);
    await source(titleId, 'healthy-recent', 'healthy', now - 3600000);
    expect(await scheduleDueJobs(db)).toMatchObject({ healthQueued: 3 });
    expect((await db.get('SELECT run_after FROM jobs WHERE id=?', [queued]))?.run_after).toBe(now + 3600000);
    expect(await db.get('SELECT status,lease_owner FROM jobs WHERE id=?', [running])).toEqual({ status: 'running', lease_owner: 'fixture' });
    expect((await db.get('SELECT status FROM jobs WHERE id=?', [exhausted]))?.status).toBe('failed');
    expect((await db.get("SELECT COUNT(*) AS n FROM jobs WHERE dedupe_key='health:exhausted' AND status='queued'"))?.n).toBe(1);
    expect((await db.get("SELECT COUNT(*) AS n FROM jobs WHERE dedupe_key LIKE 'health:cooldown-%'"))?.n).toBe(0);
  });
});
