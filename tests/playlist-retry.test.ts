import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { enqueue, failJob, finishJob, leaseJob, scheduleDueJobs } from '../lib/server/jobs';
import { playlistImportStates, workerStatus } from '../lib/server/import-status';
import { describePlaylistError, PlaylistFetchError, playlistRetryAt } from '../lib/server/playlist-errors';
import { synchronizePlaylist } from '../lib/server/pipeline';
import { encrypt, id } from '../lib/server/security';
import type { SafeFetcher } from '../lib/server/outbound';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
async function playlist() {
  const playlistId = id();
  await db.run('INSERT INTO playlists(id,name,url_encrypted,interval_hours,next_sync,created_at) VALUES(?,?,?,1,0,?)', [playlistId, 'Retry fixture', encrypt('http://provider.example.test:8080/library.m3u'), Date.now()]);
  return playlistId;
}
async function state(playlistId: string) { return (await playlistImportStates(db, await db.all('SELECT * FROM playlists WHERE id=?', [playlistId]))).get(playlistId)!; }
const content = '#EXTM3U\n#EXTINF:-1 type="movie",Saved Film (2020)\nhttp://media.example.test/movie/1.mp4';
const response = (status: number, body = '', headers: Record<string, string> = {}): SafeFetcher => async url => ({ url, status, body: Buffer.from(body), headers, truncated: false });

describe('truthful playlist refresh and retry state', () => {
  it('distinguishes an initial queue from an attempted retry and retains safe last-error details', async () => {
    const playlistId = await playlist(), jobId = await enqueue(db, 'sync', { playlistId }, { dedupeKey: `sync:${playlistId}` });
    expect(await state(playlistId)).toMatchObject({ importStatus: 'queued', latestSyncJob: { id: jobId, attempts: 0, maxAttempts: 4 } });
    const job = (await leaseJob(db, 'worker', ['sync']))!;
    await failJob(db, job, 'worker', new Error('Playlist HTTP 404 https://provider.example.test/user/privatepass?token=secret'));
    const retry = await state(playlistId);
    expect(retry).toMatchObject({ importStatus: 'retrying', latestSyncJob: { id: jobId, status: 'queued', attempts: 1 }, playlistError: { code: 'playlist_not_found', httpStatus: 404 } });
    expect(retry.latestSyncJob!.runAfter).toBeGreaterThanOrEqual(Date.now() + 3599000);
    expect(JSON.stringify(retry)).not.toMatch(/provider\.example|privatepass|token=secret/);
    expect(await leaseJob(db, 'another-worker', ['sync'])).toBeNull();
  });

  it('preserves a saved import on provider 404 and 885 without inventing what 885 means', async () => {
    const playlistId = await playlist(); await synchronizePlaylist(db, playlistId, response(200, content));
    const sources = await db.all('SELECT * FROM sources ORDER BY id'), versions = await db.all('SELECT * FROM playlist_versions ORDER BY id');
    for (const status of [404, 885]) {
      const jobId = await enqueue(db, 'sync', { playlistId }, { dedupeKey: `sync:${playlistId}`, expedite: true });
      const job = (await leaseJob(db, 'worker', ['sync']))!; expect(job.id).toBe(jobId);
      let failure: unknown; try { await synchronizePlaylist(db, playlistId, response(status)); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(PlaylistFetchError); await failJob(db, job, 'worker', failure);
      const current = await state(playlistId);
      expect(current).toMatchObject({ importStatus: 'retrying', sourceCount: 1, playlistError: { httpStatus: status } });
      expect(current.latestSyncJob!.runAfter).toBeGreaterThanOrEqual(Date.now() + 3599000);
      expect(await db.all('SELECT * FROM sources ORDER BY id')).toEqual(sources);
      expect(await db.all('SELECT * FROM playlist_versions ORDER BY id')).toEqual(versions);
      if (status === 885) expect(JSON.stringify(current.playlistError)).not.toMatch(/auth|credential|expir|block/i);
    }
  });

  it('honors bounded provider Retry-After values and falls back safely for malformed headers', () => {
    const now = 1000000;
    expect(playlistRetryAt(new PlaylistFetchError(429, '120', now), 1, now, 0)).toBe(now + 120000);
    expect(playlistRetryAt(new PlaylistFetchError(503, new Date(now + 300000).toUTCString(), now), 1, now, 0)).toBe(now + 300000);
    expect(playlistRetryAt(new PlaylistFetchError(429, '99999999999', now), 1, now, 0)).toBe(now + 86400000);
    for (const header of ['invalid', '-10', '']) expect(playlistRetryAt(new PlaylistFetchError(429, header, now), 1, now, 0)).toBe(now + 60000);
    expect(describePlaylistError('Playlist HTTP 885')).toMatchObject({ code: 'playlist_provider_response', httpStatus: 885 });
  });

  it('does not immediately recreate an exhausted sync failure during periodic scheduling', async () => {
    const playlistId = await playlist(), jobId = await enqueue(db, 'sync', { playlistId }, { dedupeKey: `sync:${playlistId}` });
    await db.run('UPDATE jobs SET attempts=3 WHERE id=?', [jobId]);
    const job = (await leaseJob(db, 'worker', ['sync']))!;
    await failJob(db, job, 'worker', new PlaylistFetchError(404));
    expect(await state(playlistId)).toMatchObject({ importStatus: 'failed', latestSyncJob: { status: 'failed', attempts: 4 } });
    await scheduleDueJobs(db);
    expect((await db.get("SELECT COUNT(*) AS n FROM jobs WHERE type='sync'"))?.n).toBe(1);
    expect((await db.get('SELECT next_sync FROM playlists WHERE id=?', [playlistId]))?.next_sync).toBeGreaterThan(Date.now());
  });

  it('expedites a queued retry only for an explicit request and keeps running leases intact', async () => {
    const playlistId = await playlist(), jobId = await enqueue(db, 'sync', { playlistId }, { dedupeKey: `sync:${playlistId}` });
    const first = (await leaseJob(db, 'worker', ['sync']))!; await failJob(db, first, 'worker', new PlaylistFetchError(404));
    const delayed = (await db.get('SELECT * FROM jobs WHERE id=?', [jobId]))!;
    await enqueue(db, 'sync', { playlistId }, { dedupeKey: `sync:${playlistId}` });
    expect((await db.get('SELECT run_after FROM jobs WHERE id=?', [jobId]))?.run_after).toBe(delayed.run_after);
    await enqueue(db, 'sync', { playlistId, versionId: 'selected-snapshot' }, { dedupeKey: `sync:${playlistId}`, expedite: true });
    const expedited = (await db.get('SELECT * FROM jobs WHERE id=?', [jobId]))!;
    expect(expedited.run_after).toBeLessThanOrEqual(Date.now()); expect(expedited.error).toBe(delayed.error);
    expect(JSON.parse(expedited.payload)).toEqual({ playlistId, versionId: 'selected-snapshot' });
    const running = (await leaseJob(db, 'worker', ['sync']))!;
    await enqueue(db, 'sync', { playlistId, versionId: 'another-snapshot' }, { dedupeKey: `sync:${playlistId}`, expedite: true });
    expect(await db.get('SELECT * FROM jobs WHERE id=?', [jobId])).toEqual(running);
  });

  it('does not let a stale attempt complete or fail a newer lease owned by the same worker', async () => {
    const playlistId = await playlist(), jobId = await enqueue(db, 'sync', { playlistId }, { dedupeKey: `sync:${playlistId}` });
    const first = (await leaseJob(db, 'worker', ['sync']))!;
    await db.run('UPDATE jobs SET lease_until=0 WHERE id=?', [jobId]);
    const newer = (await leaseJob(db, 'worker', ['sync']))!;
    await failJob(db, first, 'worker', new PlaylistFetchError(404)); await finishJob(db, first, 'worker', {});
    expect(await db.get('SELECT * FROM jobs WHERE id=?', [jobId])).toEqual(newer);
    expect((await db.get('SELECT next_sync FROM playlists WHERE id=?', [playlistId]))?.next_sync).toBe(0);
  });

  it('reports an exhausted legacy queue as failed and permits a fresh explicit attempt', async () => {
    const playlistId = await playlist(), jobId = await enqueue(db, 'sync', { playlistId }, { dedupeKey: `sync:${playlistId}` });
    await db.run("UPDATE jobs SET attempts=4,error='Playlist HTTP 404' WHERE id=?", [jobId]);
    expect(await state(playlistId)).toMatchObject({ importStatus: 'failed', latestSyncJob: { status: 'failed' } });
    expect((await workerStatus(db)).unclaimedJobs).toBe(0);
    const fresh = await enqueue(db, 'sync', { playlistId }, { dedupeKey: `sync:${playlistId}`, expedite: true });
    expect(fresh).not.toBe(jobId); expect((await leaseJob(db, 'worker', ['sync']))?.id).toBe(fresh);
  });

  it('skips a superseded fetch before mutation and does not overwrite the newly edited playlist error state', async () => {
    const playlistId = await playlist(); await synchronizePlaylist(db, playlistId, response(200, content));
    const sources = await db.all('SELECT * FROM sources'), versions = await db.all('SELECT * FROM playlist_versions');
    for (const status of [200, 404]) {
      const changed: SafeFetcher = async url => {
        await db.run("UPDATE playlists SET url_encrypted=?,health='unknown',error=NULL,next_sync=0 WHERE id=?", [encrypt(`http://new-provider.example.test/${status}/library.m3u`), playlistId]);
        return { url, status, body: Buffer.from(content.replace('Saved Film', 'Obsolete Film')), headers: {}, truncated: false };
      };
      expect(await synchronizePlaylist(db, playlistId, changed)).toMatchObject({ skipped: true, reason: expect.stringContaining('configuration changed') });
      expect(await db.get('SELECT health,error,next_sync FROM playlists WHERE id=?', [playlistId])).toEqual({ health: 'unknown', error: null, next_sync: 0 });
      expect(await db.all('SELECT * FROM sources')).toEqual(sources); expect(await db.all('SELECT * FROM playlist_versions')).toEqual(versions);
    }
  });
});
