import { describe, expect, it } from 'vitest';
import { createWorkerMaintenance, transientWorkerError, workerRetryDelay } from '../lib/server/worker-maintenance';

describe('independent worker maintenance', () => {
  it('backs off a timed-out stage while healthy scheduling and existing consumers continue', async () => {
    let time = 0, checks = 0, metadata = 0, consumed = 0;
    const errors: string[] = [], timeout = Object.assign(new Error('Statement timed out'), { code: '57014' });
    const maintenance = createWorkerMaintenance([
      { name: 'checks', run: async () => { checks++; if (checks < 3) throw timeout; } },
      { name: 'metadata', run: async () => { metadata++; } },
    ], name => errors.push(name), { now: () => time, intervalMs: 60, retryMs: 10, maxRetryMs: 40 });
    await maintenance.tick(); consumed++; expect([checks, metadata, consumed]).toEqual([1, 1, 1]);
    time = 9; await maintenance.tick(); expect(checks).toBe(1);
    time = 10; await maintenance.tick(); consumed++; expect(checks).toBe(2);
    time = 29; await maintenance.tick(); expect(checks).toBe(2);
    time = 30; await maintenance.tick(); expect(checks).toBe(3);
    time = 60; await maintenance.tick(); expect([checks, metadata, consumed]).toEqual([3, 2, 2]);
    time = 90; await maintenance.tick(); expect(checks).toBe(4);
    expect(errors).toEqual(['checks', 'checks']); await maintenance.stop();
  });

  it('does not overlap passes and drains a pending stage before shutdown', async () => {
    let release!: () => void, checks = 0, metadata = 0, closed = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const maintenance = createWorkerMaintenance([
      { name: 'checks', run: async () => { checks++; await gate; } },
      { name: 'metadata', run: async () => { metadata++; } },
    ], () => {});
    const first = maintenance.tick(); const second = maintenance.tick();
    expect(first).toBe(second); expect(checks).toBe(1);
    maintenance.requestStop();
    const stopping = maintenance.stop().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release(); await stopping; await first;
    expect(metadata).toBe(0); expect(closed).toBe(true);
    await maintenance.tick(); expect(checks).toBe(1);
  });

  it('continues checks when the metadata stage repeatedly fails and bounds retry delay', async () => {
    let time = 0, checks = 0, metadata = 0;
    const maintenance = createWorkerMaintenance([
      { name: 'checks', run: async () => { checks++; } },
      { name: 'metadata', run: async () => { metadata++; throw new Error('Unavailable'); } },
    ], () => {}, { now: () => time, intervalMs: 10, retryMs: 10, maxRetryMs: 20 });
    for (time = 0; time <= 60; time += 10) await maintenance.tick();
    expect(checks).toBe(7); expect(metadata).toBe(4); await maintenance.stop();
  });

  it('recognizes temporary database errors without retrying programming or permission failures', () => {
    for (const code of ['57014', '55P03', '53300', '57P01', '08006', 'ECONNRESET', 'ETIMEDOUT']) expect(transientWorkerError(Object.assign(new Error('Temporary'), { code }))).toBe(true);
    expect(transientWorkerError(new Error('Wrapped', { cause: { code: '57014' } }))).toBe(true);
    for (const error of [{ code: '42501' }, { code: '42P01' }, new TypeError('Programming error')]) expect(transientWorkerError(error)).toBe(false);
    const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic; expect(transientWorkerError(cyclic)).toBe(false);
    expect([1, 2, 3, 10].map(workerRetryDelay)).toEqual([1000, 2000, 4000, 30000]);
  });
});
