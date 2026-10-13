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

  it('resumes after a capped promotion batch without skipping the remaining unseen titles', async () => {
    for (let n = 0; n < 125; n++) await source(await createTitle(db, { name: `Film ${n}` }), `source-${n}`);
    const schedule = createFirstTitleScheduler(db, { maxPromotions: 100 });
    expect(await schedule()).toEqual({ scanned: 100, promoted: 100 });
    expect((await db.get('SELECT COUNT(*) AS n FROM jobs WHERE run_after<created_at'))?.n).toBe(100);
    expect(await schedule()).toEqual({ scanned: 25, promoted: 25 });
    expect((await db.get('SELECT COUNT(*) AS n FROM jobs WHERE run_after<created_at'))?.n).toBe(125);
  });

  it('crosses sparse title windows within one bounded pass and retains its cursor', async () => {
    const now = Date.now();
    await db.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<3001)
      INSERT INTO titles(id,name,normalized,type,published,created_at,updated_at)
      SELECT printf('%08d',x),'Fixture '||x,'fixture '||x,'movie',1,?,? FROM n`, [now, now]);
    await source('00003001', 'last-source');
    const schedule = createFirstTitleScheduler(db, { maxWindows: 2, timeBudgetMs: 1000 });
    expect(await schedule()).toEqual({ scanned: 2000, promoted: 0 });
    expect(await schedule()).toEqual({ scanned: 1001, promoted: 1 });
  });

  it('stops after one slow window rather than exceeding the maintenance time budget', async () => {
    await db.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001)
      INSERT INTO titles(id,name,normalized,type,published,created_at,updated_at)
      SELECT printf('%08d',x),'Fixture '||x,'fixture '||x,'movie',1,0,0 FROM n`);
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const select = db.all.bind(db);
    const all = vi.spyOn(db, 'all').mockImplementation((async (...args: Parameters<DB['all']>) => {
      const rows = await select(...args); elapsed += 251; return rows;
    }) as DB['all']);
    expect(await createFirstTitleScheduler(db)()).toEqual({ scanned: 1000, promoted: 0 });
    expect(all.mock.calls.filter(([sql]) => sql.startsWith('SELECT id FROM titles'))).toHaveLength(1);
    clock.mockRestore();
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

  it('defaults to eight bounded check slots and preserves explicit smaller configurations', () => {
    for (const value of [undefined, '', 'NaN', 'Infinity']) expect(workerJobLanes(value).filter(types => types[0] === 'health')).toHaveLength(8);
    expect(workerJobLanes('20').filter(types => types[0] === 'health')).toHaveLength(16);
    expect(workerJobLanes('1')).toEqual([['sync'], ['metadata'], ['health']]);
    expect(workerJobLanes('2.5')).toHaveLength(4);
  });
});
