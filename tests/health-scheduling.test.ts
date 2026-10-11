import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { createTitle } from '../lib/server/pipeline';
import { enqueue, finishJob, leaseJob } from '../lib/server/jobs';
import { createFirstTitleScheduler } from '../lib/server/health-scheduling';
import { workerJobLanes } from '../lib/server/worker-capacity';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { vi.restoreAllMocks(); await db.close(); });
async function source(titleId: string, sourceId: string, health = 'unknown', format = 'mp4') {
  await db.run('INSERT INTO sources(id,title_id,entry_key,name,url_encrypted,url_hash,health,format,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [sourceId, titleId, sourceId, 'Fixture', 'fixture', sourceId, health, format, Date.now()]);
  return enqueue(db, 'health', { sourceId }, { dedupeKey: `health:${sourceId}` });
}

describe('first title verification', () => {
  it('distinguishes old millisecond timestamp skew from deliberate priority and uses one enqueue timestamp', async () => {
    let now = Date.now() - 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    const titleId = await createTitle(db, { name: 'Clock skew movie' });
    const jobId = await source(titleId, 'clock-skew');
    const job = (await db.get('SELECT run_after,created_at FROM jobs WHERE id=?', [jobId]))!;
    expect(job.run_after).toBe(job.created_at);
    await db.run('UPDATE jobs SET run_after=created_at-1 WHERE id=?', [jobId]);
    expect(await createFirstTitleScheduler(db)()).toMatchObject({ promoted: 1 });
  });
  it('reaches unseen titles before extra languages and episodes, and allows unknown containers', async () => {
    const visible = await createTitle(db, { name: 'Already visible' });
    await source(visible, 'visible', 'healthy'); await source(visible, 'another-language');
    const first = await createTitle(db, { name: 'New movie' });
    await source(first, 'first-unknown', 'unknown', 'unknown'); await source(first, 'first-native');
    const mkv = await createTitle(db, { name: 'MKV movie' }); await source(mkv, 'mkv', 'unknown', 'unknown');
    const schedule = createFirstTitleScheduler(db);
    expect(await schedule()).toMatchObject({ promoted: 2 });
    const claimed = await Promise.all([leaseJob(db, 'one', ['health']), leaseJob(db, 'two', ['health'])]);
    expect(claimed.map(row => JSON.parse(row!.payload).sourceId).sort()).toEqual(['first-native', 'mkv']);
    await schedule(); // Wrap the title cursor.
    expect(await schedule()).toMatchObject({ promoted: 0 }); // Running titles do not get another slot.
    for (const job of claimed) await finishJob(db, job!, job!.lease_owner, {});
  });

  it('keeps hidden/blocked/disabled sources, incomplete episodes, retries and future deadlines in place', async () => {
    const saved: Array<{ id: string; time: number }> = [];
    for (const kind of ['hidden', 'blocked', 'disabled', 'removed', 'checked', 'retry', 'future', 'series']) {
      const titleId = await createTitle(db, { name: kind, published: kind !== 'hidden', type: kind === 'series' ? 'series' : 'movie' });
      const id = await source(titleId, kind);
      if (kind === 'blocked') await db.run('UPDATE sources SET playback_blocked=1 WHERE id=?', [kind]);
      if (kind === 'disabled') await db.run('UPDATE sources SET enabled=0 WHERE id=?', [kind]);
      if (kind === 'removed') await db.run('UPDATE sources SET removed=1 WHERE id=?', [kind]);
      if (kind === 'checked') await db.run('UPDATE sources SET last_checked=?,failures=1 WHERE id=?', [Date.now(), kind]);
      if (kind === 'retry') await db.run('UPDATE jobs SET attempts=1 WHERE id=?', [id]);
      if (kind === 'future') await db.run('UPDATE jobs SET run_after=? WHERE id=?', [Date.now() + 60000, id]);
      saved.push({ id, time: Number((await db.get('SELECT run_after FROM jobs WHERE id=?', [id]))!.run_after) });
    }
    expect(await createFirstTitleScheduler(db)()).toMatchObject({ promoted: 0 });
    for (const item of saved) expect(Number((await db.get('SELECT run_after FROM jobs WHERE id=?', [item.id]))!.run_after)).toBe(item.time);
  });

  it('bounds a pass to 100 promotions, without changing the rest of the queue', async () => {
    for (let n = 0; n < 125; n++) await source(await createTitle(db, { name: `Film ${n}` }), `source-${n}`);
    expect(await createFirstTitleScheduler(db)()).toEqual({ scanned: 125, promoted: 100 });
    expect((await db.get('SELECT COUNT(*) AS n FROM jobs WHERE run_after<created_at'))?.n).toBe(100);
  });
});

describe('dedicated checking capacity', () => {
  it('keeps all four health slots available while import and metadata jobs hold their leases', async () => {
    await enqueue(db, 'sync', {}); await enqueue(db, 'metadata', {});
    for (let n = 0; n < 5; n++) await enqueue(db, 'health', { sourceId: `source-${n}` });
    const jobs = await Promise.all(workerJobLanes('4').map((types, n) => leaseJob(db, `slot-${n}`, types)));
    expect(jobs.map(job => job!.type)).toEqual(['sync', 'metadata', 'health', 'health', 'health', 'health']);
    for (const job of jobs.filter(job => job!.type === 'health')) await finishJob(db, job!, job!.lease_owner, {});
    expect((await leaseJob(db, 'health-again', ['health']))?.type).toBe('health');
    expect((await db.get("SELECT COUNT(*) AS n FROM jobs WHERE type IN ('sync','metadata') AND status='running'"))?.n).toBe(2);
  });

  it('bounds invalid configuration to the media-probe capacity and preserves one-slot configuration', () => {
    for (const value of [undefined, '', 'NaN', 'Infinity', '20']) expect(workerJobLanes(value).filter(types => types[0] === 'health')).toHaveLength(4);
    expect(workerJobLanes('1')).toEqual([['sync'], ['metadata'], ['health']]);
    expect(workerJobLanes('2.5')).toHaveLength(4);
  });
});
