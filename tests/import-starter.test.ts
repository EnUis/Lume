import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB, type Row } from '../lib/server/db';
import { checkSource, STARTER_VERIFICATION_VERSION, synchronizePlaylist } from '../lib/server/pipeline';
import { catalog } from '../lib/server/catalog';
import { M3U_IMPORT_VERSION } from '../lib/server/m3u';
import { encrypt, id } from '../lib/server/security';
import { leaseJob } from '../lib/server/jobs';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
const entry = (name: string, type: string, extension: string, number: number) => `#EXTINF:-1,${name}\nhttps://provider.example/${type}/account/key/${number}.${extension}\n`;
async function playlist(content: string) { const playlistId = id(); await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,?)', [playlistId, 'Starter fixture', encrypt(content), Date.now()]); return playlistId; }

describe('representative starter verification', () => {
  it('leases a bounded representative quota ahead of an older bulk queue using the active dedupe index', async () => {
    const olderRunAfter = Date.now() - 100000; const count = 3000;
    await db.transaction(async tx => { for (let n = 0; n < count; n++) await tx.run("INSERT INTO jobs(id,type,payload,status,run_after,created_at,dedupe_key) VALUES(?,'health','{}','queued',?,?,?)", [`old-${n}`, olderRunAfter, n, `old-check:${n}`]); });
    let content = '#EXTM3U\n'; let number = 0;
    for (const type of ['movie', 'series', 'live']) for (const extension of ['mp4', 'm3u8', 'mpd', 'webm']) for (let n = 0; n < 5; n++) {
      const name = `${type} ${extension} ${n}${type === 'series' ? ' S1 E1' : ''}`; content += entry(name, type, type === 'live' && extension === 'm3u8' ? 'm3u' : extension, number++);
    }
    const playlistId = await playlist(content); const boosts: Array<{ sql: string; values: unknown[] }> = [];
    const traced: DB = { ...db, transaction: fn => db.transaction(tx => fn({ ...tx, get: async <T extends Row>(sql: string, values: unknown[] = []) => { if (sql.startsWith('UPDATE jobs SET run_after=')) boosts.push({ sql, values }); return tx.get<T>(sql, values); } })) };
    expect(await synchronizePlaylist(traced, playlistId)).toMatchObject({ added: 60, starterChecks: 36, starterVerificationVersion: STARTER_VERIFICATION_VERSION });
    expect(boosts).toHaveLength(36);
    for (const { sql, values } of boosts.slice(0, 1)) {
      const plan = (await db.all('EXPLAIN QUERY PLAN ' + sql, values)).map(row => row.detail).join('\n');
      expect(plan).toContain('jobs_active_dedupe'); expect(plan).not.toContain('SCAN jobs');
    }
    const buckets = new Map<string, number>();
    for (let n = 0; n < 36; n++) {
      const job = (await leaseJob(db, 'starter-consumer', ['health']))!; expect(job.id.startsWith('old-')).toBe(false);
      const source = (await db.get('SELECT s.playlist_id,s.format,t.type FROM sources s JOIN titles t ON t.id=s.title_id WHERE s.id=?', [JSON.parse(job.payload).sourceId]))!;
      expect(source.playlist_id).toBe(playlistId); const bucket = `${source.type}:${source.format}`; buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
      if (n === 0) {
        const media = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
        expect(await checkSource(db, JSON.parse(job.payload).sourceId, async url => ({ status: 206, headers: {}, body: media, truncated: false, url }))).toMatchObject({ ok: true, health: 'healthy', format: 'mp4' });
        expect((await catalog(db, new URLSearchParams())).total).toBe(1);
      }
    }
    expect(buckets.size).toBe(12); expect([...buckets.values()]).toEqual(Array(12).fill(3));
    expect((await leaseJob(db, 'normal-consumer', ['health']))?.id).toBe('old-0');
    expect((await db.get("SELECT COUNT(*) AS n FROM jobs WHERE id LIKE 'old-%' AND run_after=?", [olderRunAfter]))?.n).toBe(count);
    expect((await db.get("SELECT COUNT(*) AS n FROM sources WHERE playlist_id=? AND health='unknown'", [playlistId]))?.n).toBe(59);
    expect((await db.get('SELECT COUNT(*) AS n FROM sources WHERE playlist_id=?', [playlistId]))?.n).toBe(60);
  }, 20000);

  it('applies the policy to previous snapshots while preserving checked failures, attempted retries, leases and hidden titles', async () => {
    const names = ['Checked failure', 'Attempted task', 'Currently running', 'Already verified', 'Never checked Alpha', 'Never checked Beta', 'Never checked Gamma', 'Administrator hidden'];
    const content = '#EXTM3U\n' + names.map((name, n) => entry(name, 'movie', 'mp4', n)).join('') + entry('Series without coordinates', 'series', 'mp4', 99);
    const playlistId = await playlist(content); await synchronizePlaylist(db, playlistId); const sources = await db.all('SELECT s.id,s.title_id,t.name FROM sources s JOIN titles t ON t.id=s.title_id WHERE s.playlist_id=?', [playlistId]);
    const source = (name: string) => sources.find(row => row.name === name)!; const future = Date.now() + 600000;
    await db.run("UPDATE jobs SET run_after=? WHERE type='health'", [future]);
    await db.run('UPDATE sources SET last_checked=?,failures=1 WHERE id=?', [Date.now(), source('Checked failure').id]);
    await db.run('UPDATE jobs SET attempts=1 WHERE dedupe_key=?', [`health:${source('Checked failure').id}`]);
    await db.run('UPDATE jobs SET attempts=1 WHERE dedupe_key=?', [`health:${source('Attempted task').id}`]);
    await db.run("UPDATE jobs SET status='running',attempts=1,lease_owner='other-worker',lease_until=? WHERE dedupe_key=?", [future, `health:${source('Currently running').id}`]);
    await db.run("UPDATE sources SET health='healthy',last_checked=?,last_success=? WHERE id=?", [Date.now(), Date.now(), source('Already verified').id]);
    await db.run('UPDATE titles SET published=0 WHERE id=?', [source('Administrator hidden').title_id]);
    await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,?)', [source('Administrator hidden').title_id, Date.now()]);
    await db.run('UPDATE playlist_versions SET report=? WHERE playlist_id=?', [JSON.stringify({ importVersion: M3U_IMPORT_VERSION }), playlistId]);
    expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ added: 0, updated: 0, starterChecks: 3, contentChanged: true });
    for (const name of names.slice(0, 4).concat('Administrator hidden')) expect((await db.get('SELECT run_after FROM jobs WHERE dedupe_key=?', [`health:${source(name).id}`]))?.run_after).toBe(future);
    expect((await db.get('SELECT run_after FROM jobs WHERE dedupe_key=?', [`health:${source('Series without coordinates').id}`]))?.run_after).toBe(future);
    expect(await db.get('SELECT status,lease_owner,lease_until FROM jobs WHERE dedupe_key=?', [`health:${source('Currently running').id}`])).toMatchObject({ status: 'running', lease_owner: 'other-worker', lease_until: future });
    expect((await db.get('SELECT published FROM titles WHERE id=?', [source('Administrator hidden').title_id]))?.published).toBe(0);
    expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ contentChanged: false, starterChecks: 0 });
  });
});
