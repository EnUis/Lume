import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { heartbeatWorker, playlistImportStates, workerStatus } from '../lib/server/import-status';
import { enqueue, finishJob, leaseJob } from '../lib/server/jobs';
import { checkSource, createTitle, synchronizePlaylist } from '../lib/server/pipeline';
import { encrypt, id } from '../lib/server/security';
import type { SafeFetcher } from '../lib/server/outbound';
let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
const media: SafeFetcher = async url => ({ url, status: 200, headers: {}, body: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]), truncated: false });
const broken: SafeFetcher = async url => ({ url, status: 404, headers: {}, body: Buffer.from('missing'), truncated: false });
async function imported(name = 'A Film (2020)', extra = 'type="movie"') {
  const playlistId = id(); await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,?)', [playlistId, 'Import status fixture', encrypt(`#EXTM3U\n#EXTINF:-1 ${extra},${name}\nhttp://localhost:8080/media.mp4`), Date.now()]);
  await synchronizePlaylist(db, playlistId);
  return { playlistId, source: (await db.get('SELECT * FROM sources WHERE playlist_id=?', [playlistId]))! };
}
async function state(playlistId: string) { return (await playlistImportStates(db, (await db.all('SELECT * FROM playlists WHERE id=?', [playlistId])))).get(playlistId)!; }
describe('import visibility and worker monitoring', () => {
  it('reports an unclaimed queue offline and distinguishes live from stale heartbeats', async () => {
    await enqueue(db, 'sync', { playlistId: 'pending' });
    const now = Date.now();
    expect(await workerStatus(db, now + 1)).toMatchObject({ online: false, lastHeartbeat: null, unclaimedJobs: 1 });
    await heartbeatWorker(db, 'worker', now);
    expect(await workerStatus(db, now + 15000)).toMatchObject({ online: true, lastHeartbeat: now });
    expect((await workerStatus(db, now + 60001)).online).toBe(false);
  });
  it('separates a successfully parsed playlist from verified homepage availability', async () => {
    const { playlistId, source } = await imported();
    expect(await state(playlistId)).toMatchObject({ importStatus: 'awaiting_verification', sourceCount: 1, pendingSourceCount: 1, visibleTitleCount: 0 });
    await checkSource(db, source.id, media);
    expect(await state(playlistId)).toMatchObject({ importStatus: 'ready', playableSourceCount: 1, pendingSourceCount: 0, visibleTitleCount: 1 });
    for (let attempt = 0; attempt < 3; attempt++) await checkSource(db, source.id, broken);
    expect(await state(playlistId)).toMatchObject({ importStatus: 'failed', unavailableSourceCount: 1, visibleTitleCount: 0 });
  });
  it('shows classification review rather than declaring a healthy unpublished title ready', async () => {
    const { playlistId, source } = await imported('Unidentified programme', ''); await checkSource(db, source.id, media);
    expect(await state(playlistId)).toMatchObject({ importStatus: 'needs_review', playableSourceCount: 1, visibleTitleCount: 0, reviewCount: 1 });
  });
  it('counts verified channels in admin visibility after separate Live TV browsing is enabled', async () => {
    const { playlistId, source } = await imported('Fixture channel', 'type="live"');
    await checkSource(db, source.id, media);
    expect(await state(playlistId)).toMatchObject({ importStatus: 'ready', sourceCount: 1, playableSourceCount: 1, visibleTitleCount: 1 });
    const content = '#EXTM3U\n#EXTINF:-1 type="live",Fixture channel\nhttp://localhost:8080/media.mp4\n#EXTINF:-1 type="movie",Fixture movie (2020)\nhttp://localhost:8080/movie.mp4';
    await db.run('UPDATE playlists SET content_encrypted=? WHERE id=?', [encrypt(content), playlistId]);
    await synchronizePlaylist(db, playlistId);
    const movie = await db.get("SELECT s.id FROM sources s JOIN titles t ON t.id=s.title_id WHERE s.playlist_id=? AND t.type='movie'", [playlistId]);
    expect(movie).toBeDefined(); await checkSource(db, movie!.id, media);
    expect(await state(playlistId)).toMatchObject({ importStatus: 'ready', sourceCount: 2, playableSourceCount: 2, visibleTitleCount: 2 });
  });
  it('reconciles verified links with visible cards and unpublished or misplaced sources', async () => {
    const playlistId = id(), now = Date.now();
    await db.run('INSERT INTO playlists(id,name,created_at) VALUES(?,?,?)', [playlistId, 'Visibility breakdown', now]);
    const movie = await createTitle(db, { name: 'Visible movie', type: 'movie' });
    const series = await createTitle(db, { name: 'Visible series', type: 'series' });
    const unpublished = await createTitle(db, { name: 'Review title', type: 'movie', published: false });
    const misplaced = await createTitle(db, { name: 'Unplaced series', type: 'series' });
    const seasonId = id(); await db.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,?)', [seasonId, series, 1]);
    const add = async (titleId: string, episodeId: string | null = null, enabled = 1, blocked = 0, checked = now) => {
      const sourceId = id();
      await db.run('INSERT INTO sources(id,title_id,episode_id,playlist_id,entry_key,name,url_encrypted,url_hash,health,enabled,playback_blocked,last_checked,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [sourceId, titleId, episodeId, playlistId, id(), 'Fixture source', encrypt('https://example.test/media.mp4'), id(), 'healthy', enabled, blocked, checked, now]);
      return sourceId;
    };
    await add(movie); await add(movie);
    for (const number of [1, 2]) {
      const episodeId = id(); await db.run('INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES(?,?,?,?,?,?)', [episodeId, series, seasonId, 1, number, `Episode ${number}`]);
      await add(series, episodeId);
    }
    const reviewSource = await add(unpublished); await add(unpublished);
    await db.run('INSERT INTO review_queue(id,source_id,title_id,reason,status,created_at) VALUES(?,?,?,?,?,?)', [id(), reviewSource, unpublished, 'Review classification', 'pending', now]);
    await add(misplaced); await add(movie, null, 0); await add(movie, null, 1, 1, now - 600001);
    const result = await state(playlistId);
    expect(result).toMatchObject({ sourceCount: 9, playableSourceCount: 7, visibleTitleCount: 2, reviewCount: 1, unavailableSourceCount: 1, disabledSourceCount: 1, recentlyCheckedSourceCount: 8,
      visibilityBreakdown: { catalogSourceCount: 4, groupedSourceCount: 2, hiddenVerifiedSourceCount: 3, unpublishedSourceCount: 2, unpublishedTitleCount: 1, misplacedSourceCount: 1, movies: 1, series: 1, channels: 0 } });
    expect(result.playableSourceCount).toBe(result.visibilityBreakdown.catalogSourceCount + result.visibilityBreakdown.hiddenVerifiedSourceCount);
    expect(result.visibilityBreakdown.catalogSourceCount).toBe(result.visibleTitleCount + result.visibilityBreakdown.groupedSourceCount);
    expect(result.sourceCount).toBe(result.playableSourceCount + result.pendingSourceCount + result.unavailableSourceCount + result.disabledSourceCount);
    await db.run('UPDATE playlists SET enabled=0 WHERE id=?', [playlistId]);
    expect(await state(playlistId)).toMatchObject({ importStatus: 'disabled', visibleTitleCount: 0, playableSourceCount: 0, visibilityBreakdown: { catalogSourceCount: 0, hiddenVerifiedSourceCount: 0 } });
  });

  it('keeps media checks claimable while an import is running in another worker lane', async () => {
    const syncId = await enqueue(db, 'sync', { playlistId: 'large' });
    expect(await leaseJob(db, 'health-lane', ['health', 'metadata'])).toBeNull();
    const sync = await leaseJob(db, 'import-lane', ['sync']); expect(sync?.id).toBe(syncId);
    const checkId = await enqueue(db, 'health', { sourceId: 'committed-batch-source' });
    const check = await leaseJob(db, 'health-lane', ['health', 'metadata']); expect(check?.id).toBe(checkId);
    await finishJob(db, check!, 'health-lane', { checked: true });
    expect((await db.get('SELECT status FROM jobs WHERE id=?', [syncId]))?.status).toBe('running');
  });
});
