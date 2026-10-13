import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHealthCapacity, HealthCapacityError, healthOriginConcurrency, type HealthCapacity } from '../lib/server/health-capacity';
import { verifyStream } from '../lib/server/health';
import type { SafeFetcher } from '../lib/server/outbound';

const transport = Buffer.alloc(188 * 3); transport[0] = transport[188] = transport[376] = 0x47;
const video = { duration: null, videoIndex: 0, videoCodec: 'h264', height: 720, audioTracks: [] };
const fetcher: SafeFetcher = async url => ({ url, status: 206, headers: {}, body: transport, truncated: true });
async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); }
afterEach(() => vi.restoreAllMocks());

describe('stream verification capacity', () => {
  it('protects each provider while allowing other providers to progress and releases in FIFO order', async () => {
    const capacity = createHealthCapacity();
    const held = await Promise.all(Array.from({ length: 4 }, () => capacity.acquireOrigin('https://one.example/movie')));
    const order: number[] = [];
    const first = capacity.acquireOrigin('https://one.example/next').then(release => { order.push(1); return release; });
    const second = capacity.acquireOrigin('https://one.example/later').then(release => { order.push(2); return release; });
    const other = await Promise.all(Array.from({ length: 4 }, () => capacity.acquireOrigin('https://two.example/movie')));
    expect(order).toEqual([]);
    held[0](); const firstRelease = await first; expect(order).toEqual([1]);
    held[0](); await flush(); expect(order).toEqual([1]); // Release is idempotent.
    firstRelease(); const secondRelease = await second; expect(order).toEqual([1, 2]);
    [...held.slice(1), ...other, secondRelease].forEach(release => release());
    const next = await capacity.acquireOrigin('https://one.example/movie'); next();
  });

  it('caps expensive probes at four without rejecting eight concurrent verifications', async () => {
    const capacity = createHealthCapacity();
    const releases: Array<() => void> = []; let active = 0; let maximum = 0; let calls = 0;
    const probe = async () => {
      calls++; active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--; return video;
    };
    const checks = Array.from({ length: 8 }, (_, n) => verifyStream(`https://provider-${n % 2}.example/movie-${n}`, 'unknown', fetcher, probe, capacity));
    await flush(); expect(calls).toBe(4); expect(active).toBe(4);
    releases.splice(0).forEach(resolve => resolve());
    await flush(); expect(calls).toBe(8); expect(active).toBe(4);
    releases.splice(0).forEach(resolve => resolve());
    const results = await Promise.all(checks);
    expect(maximum).toBe(4); expect(results.every(result => result.ok && !result.retryable)).toBe(true);
  });

  it('excludes local queue time from both the source deadline and measured source latency', async () => {
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const capacity: HealthCapacity = {
      acquireOrigin: async () => { now += 60000; return () => {}; },
      acquireProbe: async () => { now += 45000; return () => {}; },
    };
    const probe = vi.fn(async () => { now += 500; return video; });
    const result = await verifyStream('https://one.example/movie', 'unknown', async (...args) => { now += 1000; return fetcher(...args); }, probe, capacity);
    expect(probe).toHaveBeenCalledWith('https://one.example/movie', { timeoutMs: 29000 });
    expect(result).toMatchObject({ ok: true, latencyMs: 1500 });
  });

  it('still rejects a probe that exceeds its active verification budget and releases its slots', async () => {
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const capacity = createHealthCapacity(1);
    const result = await verifyStream('https://one.example/slow', 'unknown', fetcher, async () => { now += 30001; return video; }, capacity);
    expect(result).toMatchObject({ ok: false, error: 'Stream verification timeout' });
    expect(result.retryable).toBeUndefined();
    expect(await verifyStream('https://one.example/working', 'unknown', fetcher, async () => video, capacity)).toMatchObject({ ok: true });
  });

  it('treats a full local queue as retryable rather than marking a source unavailable', async () => {
    const capacity = createHealthCapacity(1);
    const held = await capacity.acquireOrigin('https://one.example/held');
    const waiting = Array.from({ length: 128 }, () => capacity.acquireOrigin('https://one.example/waiting'));
    await expect(capacity.acquireOrigin('https://one.example/overflow')).rejects.toBeInstanceOf(HealthCapacityError);
    expect(await verifyStream('https://one.example/movie', 'unknown', fetcher, async () => video, capacity)).toMatchObject({ ok: false, retryable: true, latencyMs: 0 });
    held();
    for (const queued of waiting) (await queued)();
    expect(await verifyStream('https://one.example/movie', 'unknown', fetcher, async () => video, capacity)).toMatchObject({ ok: true });
  });

  it('bounds configurable provider limits separately from the fixed probe limit', () => {
    for (const value of ['', 'NaN', 'Infinity']) expect(healthOriginConcurrency(value)).toBe(4);
    expect(healthOriginConcurrency('1')).toBe(1);
    expect(healthOriginConcurrency('2.5')).toBe(2);
    expect(healthOriginConcurrency('100')).toBe(16);
  });
});
