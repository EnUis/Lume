import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleWorkerLanes, workerInterval } from '../lib/server/worker-lifecycle';
import { openDatabase } from '../lib/server/db';
import { enqueue, finishJob, leaseJob } from '../lib/server/jobs';
import { heartbeatWorker } from '../lib/server/import-status';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.useRealTimers(); });

describe('worker shutdown lifecycle', () => {
  it('keeps an active job owned and renewable after another lane fails, then closes after its durable completion', async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.now());
    const db = await openDatabase(':memory:'); const release = deferred(); const fatal = deferred(); const expectedError = new Error('Consumer database failure');
    let stopping = false; let closed = false; let failure: unknown; let persisted: Record<string, unknown> | undefined;
    const timerErrors: unknown[] = [];
    await enqueue(db, 'health', { sourceId: 'long-check' }); const job = (await leaseJob(db, 'worker'))!;
    await heartbeatWorker(db, 'worker');
    const heartbeat = workerInterval(() => heartbeatWorker(db, 'worker'), 15000, error => timerErrors.push(error));
    const renew = workerInterval(() => db.run("UPDATE jobs SET lease_until=? WHERE id=? AND lease_owner=? AND status='running'", [Date.now() + 120000, job.id, 'worker']), 30000, error => timerErrors.push(error));
    const draining = settleWorkerLanes([
      async () => { try { await release.promise; await finishJob(db, job, 'worker', { ok: true }); persisted = await db.get('SELECT status,lease_owner,report FROM jobs WHERE id=?', [job.id]); } finally { await renew.stop(); } },
      async () => { await fatal.promise; throw expectedError; },
    ], () => { stopping = true; }).catch(error => { failure = error; }).finally(async () => {
      await heartbeat.stop(); await db.run('DELETE FROM worker_heartbeats WHERE owner=?', ['worker']); await db.close(); closed = true;
    });
    fatal.resolve(); await vi.advanceTimersByTimeAsync(30000);
    expect(stopping).toBe(true); expect(closed).toBe(false); expect(failure).toBeUndefined();
    const active = (await db.get('SELECT status,lease_owner,lease_until FROM jobs WHERE id=?', [job.id]))!;
    expect(active).toMatchObject({ status: 'running', lease_owner: 'worker' }); expect(active.lease_until).toBeGreaterThan(job.lease_until);
    expect(await db.get('SELECT owner FROM worker_heartbeats WHERE owner=?', ['worker'])).toMatchObject({ owner: 'worker' });
    release.resolve(); await draining;
    expect(failure).toBe(expectedError); expect(closed).toBe(true); expect(timerErrors).toEqual([]);
    expect(persisted).toMatchObject({ status: 'completed', lease_owner: null }); expect(JSON.parse(persisted!.report as string)).toEqual({ ok: true });
  });

  it('reports fatal lanes immediately, drains every lane, and preserves the first failure by arrival order', async () => {
    const firstLane = deferred(); const secondLane = deferred(); const firstError = new Error('First arriving failure'); const laterError = new Error('Later failure');
    const reports: unknown[] = []; let stopped = 0; let settled = false; let rejected: unknown;
    const result = settleWorkerLanes([() => firstLane.promise, () => secondLane.promise], () => { stopped++; }, error => reports.push(error)).catch(error => { rejected = error; }).finally(() => { settled = true; });
    secondLane.reject(firstError); await Promise.resolve(); await Promise.resolve();
    expect(stopped).toBe(1); expect(reports).toEqual([firstError]); expect(settled).toBe(false);
    firstLane.reject(laterError); await result;
    expect(stopped).toBe(2); expect(reports).toEqual([firstError, laterError]); expect(rejected).toBe(firstError);
  });

  it('prevents overlapping background writes and waits for a pending write when its timer stops', async () => {
    vi.useFakeTimers(); const write = deferred(); let calls = 0; let stopped = false; const errors: unknown[] = [];
    const timer = workerInterval(async () => { calls++; await write.promise; }, 10, error => errors.push(error));
    await vi.advanceTimersByTimeAsync(100); expect(calls).toBe(1);
    const closing = timer.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(100); expect(calls).toBe(1);
    write.resolve(); await closing; expect(stopped).toBe(true); expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(100); expect(calls).toBe(1);
  });

  it('handles asynchronous timer errors without abandoning the stop wait or emitting unhandled rejections', async () => {
    vi.useFakeTimers(); const write = deferred(); const failed = new Error('Renewal connection refused'); const errors: unknown[] = [];
    const timer = workerInterval(() => write.promise, 10, error => errors.push(error));
    await vi.advanceTimersByTimeAsync(10); const closing = timer.stop(); write.reject(failed); await closing;
    expect(errors).toEqual([failed]);
  });

  it('returns successful one-shot lane results without requesting a stop', async () => {
    let stopped = false;
    expect(await settleWorkerLanes([async () => false, async () => true], () => { stopped = true; })).toEqual([false, true]);
    expect(stopped).toBe(false);
  });
});
