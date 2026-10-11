import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { handleApi } from '../lib/server/api';
import { catalog, playbackSources, titleDetails } from '../lib/server/catalog';
import { publicCollection } from '../lib/server/collection';
import { discovery } from '../lib/server/discovery';
import { nextHealth } from '../lib/server/health';
import { playlistImportStates } from '../lib/server/import-status';
import { checkSource, synchronizePlaylist } from '../lib/server/pipeline';
import { encrypt, hash, id } from '../lib/server/security';
import type { Source } from '../lib/types';
import type { SafeFetcher } from '../lib/server/outbound';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { vi.restoreAllMocks(); await db.close(); });
const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
const media: SafeFetcher = async url => ({ status: 206, body: bytes, headers: {}, url, truncated: true });
function request(path: string, method = 'GET', data?: unknown, cookie?: string) {
  const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
  return new Request(`${origin}/api/${path}`, { method, headers: { ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
}
async function api(path: string, method = 'GET', data?: unknown, cookie?: string) { return handleApi(request(path, method, data, cookie), db); }
async function imported(alternatives = 1, episodic = false) {
  const playlistId = id();
  const content = '#EXTM3U\n' + Array.from({ length: alternatives }, (_, index) => `#EXTINF:-1 type="${episodic ? 'series' : 'movie'}",${episodic ? `The Show S01E0${index + 1}` : 'A Film (2020)'}\nhttps://media.example/${index}.mp4`).join('\n');
  await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,?)', [playlistId, 'Strict visibility fixture', encrypt(content), Date.now()]);
  await synchronizePlaylist(db, playlistId);
  const sources = await db.all('SELECT * FROM sources WHERE playlist_id=? ORDER BY created_at,id', [playlistId]);
  for (const source of sources) await checkSource(db, source.id, media);
  const titleId = sources[0].title_id; await db.run('UPDATE titles SET featured=1 WHERE id=?', [titleId]);
  return { playlistId, titleId, sources };
}
async function attempt(titleId: string, episodeId?: string) {
  const result = await api(`playback/${titleId}${episodeId ? `?episodeId=${episodeId}` : ''}`); expect(result.status).toBe(200);
  const sources = (await result.json()).sources as Source[]; return sources[0];
}
function report(source: Source) { return { sourceId: source.id, playbackAttemptToken: source.playbackAttemptToken }; }
async function signedIn() {
  const userId = id(), session = id() + id();
  await db.run('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)', [userId, `${userId}@example.test`, 'Viewer', 'fixture', Date.now()]);
  await db.run('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)', [hash(session), userId, Date.now() + 86400000, Date.now()]);
  return { userId, cookie: `luma_session=${session}` };
}

describe('strict public availability and browser playback evidence', () => {
  it('issues opaque short-lived attempts and disables public catalog caching', async () => {
    const { titleId } = await imported(); const source = await attempt(titleId);
    expect(source.playbackAttemptToken).toBeTruthy(); expect(source.playbackAttemptToken).not.toContain(source.url);
    expect(source.playbackAttemptExpiresAt! - Date.now()).toBeGreaterThan(14 * 60000);
    expect(source.playbackAttemptExpiresAt! - Date.now()).toBeLessThanOrEqual(15 * 60000);
    expect((await api('catalog')).headers.get('cache-control')).toBe('no-store');
  });

  it('hides a browser-failed only source immediately from catalog, discovery, details, collection and playback', async () => {
    const { titleId, playlistId } = await imported(); const source = await attempt(titleId);
    const failure = await api('playback/failure', 'POST', report(source)); expect(failure.status).toBe(200); expect(await failure.json()).toMatchObject({ blocked: true, queued: true });
    expect(await db.get('SELECT health,playback_blocked,failures FROM sources WHERE id=?', [source.id])).toMatchObject({ health: 'unavailable', playback_blocked: 1, failures: 1 });
    expect((await catalog(db, new URLSearchParams())).total).toBe(0); expect(await titleDetails(db, titleId)).toBeNull();
    expect(await publicCollection(db, [titleId])).toEqual([]); expect(await playbackSources(db, titleId)).toEqual([]);
    const feeds = await discovery(db); expect(feeds.featured).toEqual([]); expect(feeds.recent).toEqual([]);
    const states = await playlistImportStates(db, await db.all('SELECT * FROM playlists WHERE id=?', [playlistId]));
    expect(states.get(playlistId)).toMatchObject({ playableSourceCount: 0, unavailableSourceCount: 1, visibleTitleCount: 0 });
    expect((await api(`titles/${titleId}`)).status).toBe(404);
  });

  it('retains a title when a different verified unblocked server works', async () => {
    const { titleId } = await imported(2); const first = await attempt(titleId);
    await api('playback/failure', 'POST', report(first));
    const alternatives = await playbackSources(db, titleId); expect(alternatives).toHaveLength(1); expect(alternatives[0].id).not.toBe(first.id);
    expect((await catalog(db, new URLSearchParams())).total).toBe(1); expect((await discovery(db)).featured.map(title => title.id)).toEqual([titleId]);
  });

  it('blocks every identical URL across playlists and languages while requiring source-specific fresh recovery', async () => {
    const first = await imported(); const second = await imported();
    await db.run("UPDATE sources SET language='en' WHERE id=?", [first.sources[0].id]);
    await db.run("UPDATE sources SET language='de' WHERE id=?", [second.sources[0].id]);
    const initial = (await (await api(`playback/${first.titleId}`)).json()).sources as Source[];
    expect(initial).toHaveLength(2); const english = initial.find(source => source.language === 'en')!, german = initial.find(source => source.language === 'de')!;
    expect(english.url).toBe(german.url); expect(english.id).not.toBe(german.id);
    expect((await api('playback/failure', 'POST', report(english))).status).toBe(200);
    const blocked = await db.all('SELECT id,health,playback_blocked,playback_blocked_at,failures FROM sources ORDER BY id');
    expect(blocked).toHaveLength(2); expect(blocked.every(source => source.health === 'unavailable' && source.playback_blocked === 1 && source.failures === 1 && source.playback_blocked_at !== null)).toBe(true);
    expect(await db.get('SELECT COUNT(*) AS total FROM source_health_history WHERE error LIKE ?', ['Browser playback failed%'])).toMatchObject({ total: 2 });
    expect((await catalog(db, new URLSearchParams())).total).toBe(0); expect((await discovery(db)).recent).toEqual([]);
    for (const source of initial) {
      await checkSource(db, source.id, media);
      expect((await api('playback/success', 'POST', report(source))).status).toBe(409);
    }
    expect(await playbackSources(db, first.titleId)).toEqual([]);
    const englishRetry = (await (await api('playback/attempt', 'POST', report(english))).json()).source as Source;
    const germanRetry = (await (await api('playback/attempt', 'POST', report(german))).json()).source as Source;
    expect((await api('playback/success', 'POST', { ...report(englishRetry), sourceId: german.id })).status).toBe(403);
    expect((await api('playback/success', 'POST', report(englishRetry))).status).toBe(200);
    expect((await playbackSources(db, first.titleId)).map(source => source.id)).toEqual([english.id]);
    expect(await db.get('SELECT health,playback_blocked FROM sources WHERE id=?', [german.id])).toMatchObject({ health: 'unavailable', playback_blocked: 1 });
    // A later failure invalidates the fresh recovery token of every URL reference too.
    expect((await api('playback/failure', 'POST', report(englishRetry))).status).toBe(200);
    expect((await api('playback/success', 'POST', report(germanRetry))).status).toBe(409);
    const nextGermanRetry = (await (await api('playback/attempt', 'POST', report(germanRetry))).json()).source as Source;
    expect((await api('playback/success', 'POST', report(nextGermanRetry))).status).toBe(200);
    expect((await playbackSources(db, first.titleId)).map(source => source.id)).toEqual([german.id]);
  });

  it('keeps browser blocks sticky after successful container checks, including an in-flight check race', async () => {
    const { titleId } = await imported(); const source = await attempt(titleId);
    let release!: () => void; let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    const running = checkSource(db, source.id, async url => { began(); await new Promise<void>(resolve => { release = resolve; }); return media(url); });
    await started; await api('playback/failure', 'POST', report(source)); release(); await running;
    await checkSource(db, source.id, media);
    expect(await db.get('SELECT health,playback_blocked,error FROM sources WHERE id=?', [source.id])).toMatchObject({ health: 'unavailable', playback_blocked: 1 });
    expect((await catalog(db, new URLSearchParams())).total).toBe(0); expect(await playbackSources(db, titleId)).toEqual([]);
  });

  it('requires a fresh recovery attempt and real playing report to restore a blocked source', async () => {
    const { titleId } = await imported(); const original = await attempt(titleId);
    await api('playback/failure', 'POST', report(original));
    expect((await api('playback/success', 'POST', report(original))).status).toBe(409);
    const recoveryResponse = await api('playback/attempt', 'POST', report(original)); expect(recoveryResponse.status).toBe(200);
    const recovery = (await recoveryResponse.json()).source as Source;
    expect(recovery).toMatchObject({ id: original.id, health: 'unavailable', playbackBlocked: true, playbackRetry: true });
    expect((await catalog(db, new URLSearchParams())).total).toBe(0);
    const success = await api('playback/success', 'POST', report(recovery)); expect(success.status).toBe(200); expect(await success.json()).toEqual({ ok: true, restored: true });
    expect(await db.get('SELECT health,playback_blocked,playback_blocked_at FROM sources WHERE id=?', [original.id])).toMatchObject({ health: 'healthy', playback_blocked: 0, playback_blocked_at: null });
    expect((await catalog(db, new URLSearchParams())).total).toBe(1);
  });

  it('rejects success from a recovery attempt superseded by another failure in the same millisecond', async () => {
    const { titleId } = await imported(); const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    const original = await attempt(titleId); await api('playback/failure', 'POST', report(original));
    const recovery = (await (await api('playback/attempt', 'POST', report(original))).json()).source as Source;
    await api('playback/failure', 'POST', report(recovery));
    expect((await api('playback/success', 'POST', report(recovery))).status).toBe(409);
    expect((await catalog(db, new URLSearchParams())).total).toBe(0);
  });

  it('rejects stale failure, success and renewal tokens after the source URL changes', async () => {
    const { titleId } = await imported(); const source = await attempt(titleId);
    const replacement = 'https://media.example/replacement.mp4';
    await db.run('UPDATE sources SET url_encrypted=?,url_hash=? WHERE id=?', [encrypt(replacement), hash(replacement), source.id]);
    for (const endpoint of ['failure', 'success', 'attempt']) expect((await api(`playback/${endpoint}`, 'POST', report(source))).status).toBe(409);
    expect(await db.get('SELECT health,playback_blocked FROM sources WHERE id=?', [source.id])).toMatchObject({ health: 'healthy', playback_blocked: 0 });
  });

  it('allows expired-token renewal with the URL binding while requiring fresh reports', async () => {
    const { titleId } = await imported(); const source = await attempt(titleId);
    vi.spyOn(Date, 'now').mockReturnValue(source.playbackAttemptExpiresAt! + 1);
    for (const endpoint of ['failure', 'success']) expect((await api(`playback/${endpoint}`, 'POST', report(source))).status).toBe(403);
    const renewal = await api('playback/attempt', 'POST', report(source)); expect(renewal.status).toBe(200);
    const renewed = (await renewal.json()).source as Source; expect(renewed.playbackAttemptExpiresAt).toBeGreaterThan(source.playbackAttemptExpiresAt!);
    expect((await api('playback/failure', 'POST', report(renewed))).status).toBe(200);
  });

  it('rejects missing, tampered, mismatched-source and different-viewer attempt reports', async () => {
    const { titleId } = await imported(2); const source = await attempt(titleId); const sources = await playbackSources(db, titleId);
    const viewer = await signedIn();
    expect((await api('playback/failure', 'POST', { sourceId: source.id })).status).toBe(403);
    expect((await api('playback/failure', 'POST', { ...report(source), playbackAttemptToken: source.playbackAttemptToken! + 'bad' })).status).toBe(403);
    expect((await api('playback/failure', 'POST', { ...report(source), sourceId: sources.find(entry => entry.id !== source.id)!.id })).status).toBe(403);
    expect((await api('playback/failure', 'POST', report(source), viewer.cookie)).status).toBe(403);
    expect((await catalog(db, new URLSearchParams())).total).toBe(1);
  });

  it('applies strict health eligibility to episodes and does not expose degraded sources', async () => {
    const { titleId, sources } = await imported(2, true);
    const source = await attempt(titleId, sources[0].episode_id); await api('playback/failure', 'POST', report(source));
    const title = (await titleDetails(db, titleId))!; expect(title.episodes!.find(episode => episode.id === source.episodeId)!.available).toBe(false);
    expect(title.episodes!.filter(episode => episode.available)).toHaveLength(1);
    await db.run("UPDATE sources SET health='degraded' WHERE id=?", [sources[1].id]);
    expect((await catalog(db, new URLSearchParams())).total).toBe(0); expect(await titleDetails(db, titleId)).toBeNull();
    expect(nextHealth('healthy', 0, false)).toBe('unavailable'); expect(nextHealth('unknown', 0, false, 50)).toBe('unavailable');
  });

  it('keeps saved-account metadata but marks a blocked title unavailable', async () => {
    const { titleId } = await imported(); const viewer = await signedIn();
    await api('list', 'POST', { titleId }, viewer.cookie); const source = await attempt(titleId); await api('playback/failure', 'POST', report(source));
    const result = await api('library', 'GET', undefined, viewer.cookie);
    expect((await result.json()).titles).toEqual([expect.objectContaining({ id: titleId, available: false })]);
  });

  it('resolves old title aliases for details, playback, guest collections and registered writes', async () => {
    const { titleId } = await imported(); const aliasId = id();
    await db.run('INSERT INTO title_redirects(alias_id,title_id,created_at) VALUES(?,?,?)', [aliasId, titleId, Date.now()]);
    expect((await titleDetails(db, aliasId))!.id).toBe(titleId); expect((await playbackSources(db, aliasId))[0].titleId).toBe(titleId);
    expect((await publicCollection(db, [aliasId, titleId])).map(title => title.id)).toEqual([titleId]);
    expect((await (await api(`titles/${aliasId}`)).json()).title.id).toBe(titleId);
    const viewer = await signedIn();
    expect((await api('list', 'POST', { titleId: aliasId }, viewer.cookie)).status).toBe(200);
    expect((await api('progress', 'POST', { titleId: aliasId, position: 5, duration: 100 }, viewer.cookie)).status).toBe(200);
    expect(await db.get('SELECT title_id FROM watchlist WHERE user_id=?', [viewer.userId])).toMatchObject({ title_id: titleId });
    expect(await db.get('SELECT title_id FROM playback_progress WHERE user_id=?', [viewer.userId])).toMatchObject({ title_id: titleId });
  });

  it('does not issue recovery URLs for disabled or unpublished sources', async () => {
    const { titleId } = await imported(); const source = await attempt(titleId); await api('playback/failure', 'POST', report(source));
    await db.run('UPDATE sources SET enabled=0 WHERE id=?', [source.id]); expect((await api('playback/attempt', 'POST', report(source))).status).toBe(404);
    await db.run('UPDATE sources SET enabled=1 WHERE id=?', [source.id]); await db.run('UPDATE titles SET published=0 WHERE id=?', [titleId]);
    expect((await api('playback/attempt', 'POST', report(source))).status).toBe(404);
  });

  it('preserves a browser block on same-URL administrator edits and resets only an actual URL replacement', async () => {
    const { titleId } = await imported(); const source = await attempt(titleId); await api('playback/failure', 'POST', report(source));
    const before = (await db.get('SELECT health,playback_blocked,playback_blocked_at,error FROM sources WHERE id=?', [source.id]))!;
    const administrator = await signedIn(); await db.run("UPDATE users SET role='admin' WHERE id=?", [administrator.userId]);
    const same = await api(`admin/sources/${source.id}`, 'PATCH', { url: source.url, name: 'Edited server label', enabled: true }, administrator.cookie);
    expect(same.status).toBe(200); expect(await db.get('SELECT health,playback_blocked,playback_blocked_at,error FROM sources WHERE id=?', [source.id])).toEqual(before);
    await checkSource(db, source.id, media); expect((await catalog(db, new URLSearchParams())).total).toBe(0);
    const replacement = await api(`admin/sources/${source.id}`, 'PATCH', { url: 'https://media.example/new-rendition.mp4' }, administrator.cookie);
    expect(replacement.status).toBe(200); expect(await db.get('SELECT health,playback_blocked,playback_blocked_at FROM sources WHERE id=?', [source.id])).toMatchObject({ health: 'unknown', playback_blocked: 0, playback_blocked_at: null });
    expect((await catalog(db, new URLSearchParams())).total).toBe(0); expect((await api('playback/failure', 'POST', report(source))).status).toBe(409);
    await checkSource(db, source.id, media); expect((await catalog(db, new URLSearchParams())).total).toBe(1);
  });

  it('inherits a known URL block on manual source creation and URL replacement without republishing it', async () => {
    const { titleId } = await imported(2); const initial = (await (await api(`playback/${titleId}`)).json()).sources as Source[];
    const failed = initial[0], alternative = initial[1]; expect(failed.url).not.toBe(alternative.url);
    expect((await api('playback/failure', 'POST', report(failed))).status).toBe(200);
    const originalBlock = (await db.get('SELECT playback_blocked_at,error FROM sources WHERE id=?', [failed.id]))!;
    const administrator = await signedIn(); await db.run("UPDATE users SET role='admin' WHERE id=?", [administrator.userId]);
    const created = await api('admin/sources', 'POST', { titleId, name: 'Manual Turkish reference', language: 'tr', url: failed.url }, administrator.cookie);
    expect(created.status).toBe(201); const duplicate = (await created.json()).source as Source;
    expect(duplicate).toMatchObject({ health: 'unavailable', playbackBlocked: true, language: 'tr' });
    expect(await db.get('SELECT playback_blocked_at,error FROM sources WHERE id=?', [duplicate.id])).toEqual(originalBlock);
    await checkSource(db, duplicate.id, media); expect((await playbackSources(db, titleId)).map(source => source.id)).toEqual([alternative.id]);
    const changed = await api(`admin/sources/${alternative.id}`, 'PATCH', { url: failed.url }, administrator.cookie);
    expect(changed.status).toBe(200); expect((await changed.json()).source).toMatchObject({ health: 'unavailable', playbackBlocked: true });
    expect(await db.get('SELECT playback_blocked_at,error FROM sources WHERE id=?', [alternative.id])).toEqual(originalBlock);
    await checkSource(db, alternative.id, media); expect((await catalog(db, new URLSearchParams())).total).toBe(0);
    expect((await api('playback/success', 'POST', report(alternative))).status).toBe(409);
    const recovery = (await (await api('playback/attempt', 'POST', { sourceId: duplicate.id })).json()).source as Source;
    expect((await api('playback/success', 'POST', report(recovery))).status).toBe(200);
    expect((await playbackSources(db, titleId)).map(source => source.id)).toEqual([duplicate.id]);
  });
});
