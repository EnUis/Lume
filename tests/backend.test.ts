import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../lib/server/db';
import { openDatabase } from '../lib/server/db';
import { parseM3U, normalizeTitle } from '../lib/server/m3u';
import { isPublicIp, validateSourceUrl, type SafeFetcher } from '../lib/server/outbound';
import { encrypt, decrypt, id, passwordHash, rateLimit, sameOrigin } from '../lib/server/security';
import { checkSource, synchronizePlaylist } from '../lib/server/pipeline';
import { catalog, playbackSources, titleDetails } from '../lib/server/catalog';
import { verifyStream } from '../lib/server/health';
import { enqueue, leaseJob, finishJob, failJob } from '../lib/server/jobs';
import { mergeTitles, splitSource } from '../lib/server/management';
import { handleApi } from '../lib/server/api';
import { requestPlaybackGrant, authorizePlaybackSources } from '../lib/server/playback-access';
import type { Source } from '../lib/types';
import { createCipheriv } from 'node:crypto';

let db: DB;
const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
const media: SafeFetcher = async url => ({ status: 206, body: bytes, headers: { 'content-type': 'video/mp4' }, url, truncated: false });
const broken: SafeFetcher = async url => ({ status: 404, body: Buffer.from('missing'), headers: {}, url, truncated: false });
async function playlist(content: string, name = 'Authorized test playlist') { const playlistId = id(); await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,?)', [playlistId, name, encrypt(content), Date.now()]); return playlistId; }
function m3u(name = 'A Film (2020)', url = 'https://media.example.com/movie.mp4', extra = '') { return `#EXTM3U\n#EXTINF:-1 type="movie" group-title="Movies" ${extra},${name}\n${url}\n`; }
async function imported(content = m3u()) { const playlistId = await playlist(content); await synchronizePlaylist(db, playlistId); const sources = await db.all('SELECT * FROM sources WHERE playlist_id=?', [playlistId]); return { playlistId, sources, titleId: sources[0].title_id }; }
function request(path: string, method = 'GET', data?: unknown, cookie?: string) { const origin = process.env.APP_ORIGIN || 'http://localhost:3000'; return new Request(`${origin}/api/${path}`, { method, headers: { ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); }
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });

describe('request origin validation', () => {
  function environment(mode: string, configuredOrigin: string | undefined, fn: () => void) {
    const mutableEnvironment = process.env as Record<string, string | undefined>;
    const previousMode = mutableEnvironment.NODE_ENV; const previousOrigin = mutableEnvironment.APP_ORIGIN;
    mutableEnvironment.NODE_ENV = mode; if (configuredOrigin === undefined) delete mutableEnvironment.APP_ORIGIN; else mutableEnvironment.APP_ORIGIN = configuredOrigin;
    try { fn(); } finally { if (previousMode === undefined) delete mutableEnvironment.NODE_ENV; else mutableEnvironment.NODE_ENV = previousMode; if (previousOrigin === undefined) delete mutableEnvironment.APP_ORIGIN; else mutableEnvironment.APP_ORIGIN = previousOrigin; }
  }
  const mutation = (host: string, origin: string, forwardedHost?: string) => new Request('http://localhost:3000/api/auth/register', { method: 'POST', headers: { host, origin, 'content-type': 'application/json', ...(forwardedHost ? { 'x-forwarded-host': forwardedHost } : {}) }, body: '{}' });
  it('uses the actual development Host when Next rewrites Request.url to localhost', () => { environment('development', undefined, () => { expect(() => sameOrigin(mutation('127.0.0.1:3000', 'http://127.0.0.1:3000'))).not.toThrow(); expect(() => sameOrigin(mutation('localhost:3000', 'http://localhost:3000'))).not.toThrow(); }); });
  it('rejects hostile origins, malformed hosts and untrusted forwarded origins', () => { environment('development', undefined, () => { expect(() => sameOrigin(mutation('127.0.0.1:3000', 'https://evil.example'))).toThrow(); expect(() => sameOrigin(mutation('127.0.0.1:3000', 'https://evil.example', 'evil.example'))).toThrow(); expect(() => sameOrigin(mutation('localhost:3000@evil.example', 'https://evil.example'))).toThrow(); }); });
  it('requires an explicit production APP_ORIGIN and checks it independently of Host', () => { environment('production', undefined, () => { expect(() => sameOrigin(mutation('127.0.0.1:3000', 'http://127.0.0.1:3000'))).toThrow('Application origin is not configured'); }); environment('production', 'https://luma.example', () => { expect(() => sameOrigin(mutation('internal:3000', 'https://luma.example'))).not.toThrow(); expect(() => sameOrigin(mutation('internal:3000', 'https://evil.example'))).toThrow(); }); });
});

describe('M3U parsing and identities', () => {
  it('parses quoted commas, attributes, BOM, CRLF, year and quality suffixes', () => {
    const parsed = parseM3U('\uFEFF#EXTM3U\r\n#EXTINF:-1 tvg-id="id1" tvg-name="Original" tvg-logo="https://img.example.com/p.jpg" group-title="Movies, Drama",A Film (2020) 1080p\r\nhttps://media.example.com/v.mp4\r\n');
    expect(parsed.entries).toHaveLength(1); expect(parsed.entries[0]).toMatchObject({ title: 'A Film', year: 2020, type: 'movie', format: 'mp4', group: 'Movies, Drama' }); expect(parsed.errors).toEqual([]);
  });
  it('groups SxxExx and NxN episodes, while preserving live classification', () => {
    const result = parseM3U('#EXTM3U\n#EXTINF:-1,Series S02E04 — Night\nhttps://media.example.com/ep.mp4\n#EXTINF:-1,Series 2x05\nhttps://media.example.com/ep5.m3u8\n#EXTINF:-1 group-title="Live News",News Channel\nhttps://media.example.com/live.m3u8');
    expect(result.entries[0]).toMatchObject({ title: 'Series', season: 2, episode: 4, type: 'series' }); expect(result.entries[1].episode).toBe(5); expect(result.entries[2].type).toBe('live');
  });
  it('deduplicates identical entries and keeps alternate servers', () => {
    const content = `${m3u()}${m3u().replace('#EXTM3U\n', '')}${m3u('A Film (2020)', 'https://other.example.com/v.mp4').replace('#EXTM3U\n', '')}`;
    const result = parseM3U(content); expect(result.entries).toHaveLength(2); expect(new Set(result.entries.map(e => e.key)).size).toBe(2);
  });
  it('reports malformed entries without exposing URLs and rejects non-playlists', () => { expect(() => parseM3U('<html>error</html>')).toThrow(); const parsed = parseM3U('#EXTM3U\n#EXTINF:-1,A\nfile:///secret\n#EXTINF:-1,B'); expect(parsed.entries).toHaveLength(0); expect(parsed.errors.join()).not.toContain('secret'); });
  it('normalizes case, accents and punctuation', () => { expect(normalizeTitle('  À Film: Part II!')).toBe('a film part ii'); });
  it('preserves numeric movie names, single-quoted comma attributes and explicit movie classification', () => {
    const result = parseM3U("#EXTM3U\n#EXTINF:-1 type='movie' group-title='Movies, News',2001: A Space Odyssey (1968)\nhttps://example.com/movie.mp4");
    expect(result.entries[0]).toMatchObject({ title: '2001: A Space Odyssey', year: 1968, type: 'movie', group: 'Movies, News' });
  });
});

describe('outbound security and verification', () => {
  it('rejects private, link-local, mapped, multicast and reserved addresses', () => { for (const ip of ['127.0.0.1', '10.0.1.1', '172.16.0.2', '192.168.1.2', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1']) expect(isPublicIp(ip), ip).toBe(false); expect(isPublicIp('8.8.8.8')).toBe(true); expect(isPublicIp('2606:4700::1111')).toBe(true); });
  it('accepts administrator media URLs with local/private hosts, credentials and custom ports; rejects malformed and non-HTTP URLs', () => { for (const value of ['http://localhost:8080/video', 'http://10.1.1.1:9999/a', 'https://u:p@example.com:8443/a', 'https://example.com:65535/video']) expect(() => validateSourceUrl(value)).not.toThrow(); for (const value of ['file:///etc/passwd', 'ftp://example.com/video', 'not a URL', 'https://example.com:65536/video']) expect(() => validateSourceUrl(value)).toThrow(); });
  it('encrypts source URLs and detects tampering', () => { const secret = 'https://example.com/v?token=secret'; const ciphertext = encrypt(secret); expect(ciphertext).not.toContain('secret'); expect(decrypt(ciphertext)).toBe(secret); expect(() => decrypt(`${ciphertext}changed`)).toThrow(); });
  it('never interprets a 200 HTML error page as playable', async () => { const fetcher: SafeFetcher = async url => ({ status: 200, body: Buffer.from('<html>login required</html>'), headers: {}, url, truncated: false }); expect((await verifyStream('https://example.com/a.mp4', 'mp4', fetcher)).ok).toBe(false); });
  it('checks HLS master, media manifest and actual segments', async () => {
    const calls: string[] = []; const fetcher: SafeFetcher = async url => { calls.push(url); const path = new URL(url).pathname; const body = path === '/master.m3u8' ? Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nmedia.m3u8') : path === '/media.m3u8' ? Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.mp4\n#EXT-X-ENDLIST') : bytes; return { status: 200, body, headers: {}, url, truncated: false }; };
    expect(await verifyStream('https://example.com/master.m3u8', 'hls', fetcher)).toMatchObject({ ok: true, format: 'hls', quality: '720p' }); expect(calls).toContain('https://example.com/segment.mp4');
  });
  it('rejects an HLS manifest with missing segments', async () => { const fetcher: SafeFetcher = async url => url.endsWith('.m3u8') ? { status: 200, body: Buffer.from('#EXTM3U\n#EXTINF:4,\nbroken.ts'), headers: {}, url, truncated: false } : broken(url); expect((await verifyStream('https://example.com/a.m3u8', 'hls', fetcher)).ok).toBe(false); });
  it('decrypts AES-128 HLS sample blocks before claiming playable media', async () => {
    const key = Buffer.alloc(16, 2); const iv = Buffer.alloc(16); const cipher = createCipheriv('aes-128-cbc', key, iv); const encryptedBytes = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const fetcher: SafeFetcher = async url => ({ status: 200, body: url.endsWith('.m3u8') ? Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nsegment.ts') : url.endsWith('key.bin') ? key : encryptedBytes, headers: {}, url, truncated: false });
    expect((await verifyStream('https://example.com/a.m3u8', 'hls', fetcher)).ok).toBe(true);
    const invalid: SafeFetcher = async (url, options) => url.endsWith('segment.ts') ? { status: 200, body: Buffer.alloc(64), headers: {}, url, truncated: false } : fetcher(url, options); expect((await verifyStream('https://example.com/a.m3u8', 'hls', invalid)).ok).toBe(false);
  });
  it('checks DASH initialization and a real media segment; DRM stays unverified', async () => {
    const fetcher: SafeFetcher = async url => ({ status: 200, body: url.endsWith('.mpd') ? Buffer.from('<MPD><Period><AdaptationSet><SegmentTemplate initialization="init.mp4" media="chunk-$Number$.mp4" startNumber="3"/><Representation id="v" height="720" bandwidth="123"/></AdaptationSet></Period></MPD>') : bytes, headers: {}, url, truncated: false });
    expect(await verifyStream('https://example.com/a.mpd', 'dash', fetcher)).toMatchObject({ ok: true, quality: '720p' });
    const drm: SafeFetcher = async url => ({ status: 200, body: Buffer.from('<MPD><ContentProtection/><Representation id="a"/></MPD>'), headers: {}, url, truncated: false }); expect((await verifyStream('https://example.com/a.mpd', 'dash', drm)).ok).toBe(false);
  });
});

describe('persistent synchronization, grouping and availability', () => {
  it('imports to unknown, verifies per-item, then serves real playback URLs', async () => { const { sources, titleId } = await imported(); expect((await catalog(db, new URLSearchParams())).total).toBe(0); expect(await playbackSources(db, titleId)).toEqual([]); await checkSource(db, sources[0].id, media); expect((await catalog(db, new URLSearchParams())).total).toBe(1); expect((await playbackSources(db, titleId))[0].url).toBe('https://media.example.com/movie.mp4'); });
  it('merges equivalent known-year titles from different playlists; prevents remakes', async () => { await imported(m3u('A Film (2020) 1080p')); await imported(m3u('A FILM 2020', 'https://other.example.com/v.mp4')); await imported(m3u('A Film (1990)', 'https://third.example.com/v.mp4')); expect((await db.get('SELECT COUNT(*) AS n FROM titles'))!.n).toBe(2); expect((await db.get('SELECT COUNT(*) AS n FROM sources'))!.n).toBe(3); });
  it('routes uncertain missing-year matches to review instead of merging blindly', async () => { await imported(m3u('A Film (2020)')); await imported(m3u('A Film', 'https://other.example.com/v.mp4')); expect((await db.get('SELECT COUNT(*) AS n FROM titles'))!.n).toBe(2); expect((await db.get("SELECT COUNT(*) AS n FROM review_queue WHERE status='pending'"))!.n).toBe(1); });
  it('prevents merging distinct external identities with an identical name and year', async () => { await imported(m3u('A Film (2020)', 'https://example.com/a.mp4', 'imdb-id="tt1234567"')); await imported(m3u('A Film (2020)', 'https://example.com/b.mp4', 'imdb-id="tt1234568"')); expect((await db.get('SELECT COUNT(*) AS n FROM titles'))!.n).toBe(2); expect((await db.get("SELECT reason FROM review_queue WHERE status='pending'"))!.reason).toContain('conflicts'); });
  it('updates changed URLs in place and records recoverable snapshots', async () => { const { playlistId, sources } = await imported(); await db.run('UPDATE playlists SET content_encrypted=? WHERE id=?', [encrypt(m3u('A Film (2020)', 'https://media.example.com/replacement.mp4')), playlistId]); await synchronizePlaylist(db, playlistId); const changed = await db.get('SELECT * FROM sources WHERE id=?', [sources[0].id]); expect(decrypt(changed!.url_encrypted)).toContain('replacement'); expect(changed!.health).toBe('unknown'); expect((await db.get('SELECT COUNT(*) AS n FROM playlist_versions'))!.n).toBe(2); });
  it('failed fetch leaves imported sources and snapshots intact', async () => { const { playlistId, sources } = await imported(); await db.run('UPDATE playlists SET url_encrypted=? WHERE id=?', [encrypt('https://example.com/playlist.m3u'), playlistId]); await expect(synchronizePlaylist(db, playlistId, broken)).rejects.toThrow(); expect((await db.get('SELECT removed FROM sources WHERE id=?', [sources[0].id]))!.removed).toBe(0); expect((await db.get('SELECT COUNT(*) AS n FROM playlist_versions'))!.n).toBe(1); });
  it('valid refresh removes only absent servers and restoring a snapshot recovers them', async () => { const { playlistId, sources } = await imported(`${m3u()}${m3u('Other Film (2021)', 'https://example.com/other.mp4').replace('#EXTM3U\n', '')}`); const other = sources.find(s => decrypt(s.url_encrypted).includes('other.mp4'))!; const first = await db.get('SELECT * FROM playlist_versions WHERE playlist_id=?', [playlistId]); await db.run('UPDATE playlists SET content_encrypted=? WHERE id=?', [encrypt(m3u()), playlistId]); await synchronizePlaylist(db, playlistId); expect((await db.get('SELECT removed FROM sources WHERE id=?', [other.id]))!.removed).toBe(1); await synchronizePlaylist(db, playlistId, media, decrypt(first!.content_encrypted)); expect((await db.get('SELECT removed FROM sources WHERE id=?', [other.id]))!.removed).toBe(0); });
  it('hides a source immediately after one failed health check and restores after a successful check', async () => { const { sources, titleId } = await imported(); await checkSource(db, sources[0].id, media); await checkSource(db, sources[0].id, broken); expect((await db.get('SELECT health FROM sources WHERE id=?', [sources[0].id]))!.health).toBe('unavailable'); expect(await playbackSources(db, titleId)).toEqual([]); expect((await catalog(db, new URLSearchParams())).total).toBe(0); await checkSource(db, sources[0].id, media); expect((await catalog(db, new URLSearchParams())).total).toBe(1); });
  it('keeps a title with one working server and orders healthy fallbacks', async () => { const { sources, titleId } = await imported(`${m3u()}${m3u('A Film (2020)', 'https://other.example.com/v.mp4').replace('#EXTM3U\n', '')}`); await checkSource(db, sources[0].id, media); for (let i = 0; i < 3; i++) await checkSource(db, sources[1].id, broken); expect((await playbackSources(db, titleId)).map(s => s.id)).toEqual([sources[0].id]); await checkSource(db, sources[1].id, media); await db.run('UPDATE sources SET priority=100 WHERE id=?', [sources[1].id]); expect((await playbackSources(db, titleId)).map(s => s.id)).toEqual([sources[1].id, sources[0].id]); });
  it('handles series visibility at the episode level', async () => { const { sources, titleId } = await imported('#EXTM3U\n#EXTINF:-1,The Show S01E04\nhttps://example.com/e4.mp4\n#EXTINF:-1,The Show S01E05\nhttps://example.com/e5.mp4'); const fifth = sources.find(s => decrypt(s.url_encrypted).includes('e5.mp4'))!; await checkSource(db, fifth.id, media); const title = await titleDetails(db, titleId); expect(title!.episodes?.map(e => e.available)).toEqual([false, true]); expect((await catalog(db, new URLSearchParams())).total).toBe(1); });
  it('disabling a playlist removes its sources from public availability without deleting them', async () => { const { playlistId, sources, titleId } = await imported(); await checkSource(db, sources[0].id, media); await db.run('UPDATE playlists SET enabled=0 WHERE id=?', [playlistId]); expect(await playbackSources(db, titleId)).toEqual([]); expect((await db.get('SELECT COUNT(*) AS n FROM sources'))!.n).toBe(1); });
  it('manual splitting preserves source and manual merging preserves watchlists and progress', async () => { const { sources, titleId } = await imported(`${m3u()}${m3u('A Film (2020)', 'https://other.example.com/v.mp4').replace('#EXTM3U\n', '')}`); const secondId = await splitSource(db, sources[1].id, 'Different Film', 2021); const userId = id(); await db.run('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)', [userId, 'merge@test.dev', 'Test', passwordHash('valid-password-123'), Date.now()]); await db.run('INSERT INTO watchlist(user_id,title_id,created_at) VALUES(?,?,?)', [userId, secondId, Date.now()]); await db.run('INSERT INTO playback_progress(user_id,title_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [userId, secondId, secondId, 25, 100, Date.now()]); await mergeTitles(db, secondId, titleId); expect((await db.get('SELECT title_id FROM watchlist WHERE user_id=?', [userId]))!.title_id).toBe(titleId); expect((await db.get('SELECT title_id,position FROM playback_progress WHERE user_id=?', [userId]))).toMatchObject({ title_id: titleId, position: 25 }); });
});

describe('durable jobs, accounts and permissions', () => {
  it('atomically limits concurrent requests on a newly created rate bucket', async () => { const attempts = await Promise.allSettled([...Array(20)].map(() => rateLimit(db, 'shared-login', 3, 60000))); expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(3); expect(attempts.filter(a => a.status === 'rejected')).toHaveLength(17); });
  it('deduplicates work, leases exactly once and persists retries', async () => { const jobId = await enqueue(db, 'health', { sourceId: 'test' }, { dedupeKey: 'health:test' }); await enqueue(db, 'health', { sourceId: 'test' }, { dedupeKey: 'health:test' }); expect((await db.get('SELECT COUNT(*) AS n FROM jobs'))!.n).toBe(1); const first = await leaseJob(db, 'worker1'); expect(first!.id).toBe(jobId); expect(await leaseJob(db, 'worker2')).toBeNull(); await failJob(db, first!, 'worker1', new Error('test failure')); expect((await db.get('SELECT status,attempts FROM jobs WHERE id=?', [jobId]))).toMatchObject({ status: 'queued', attempts: 1 }); await db.run('UPDATE jobs SET run_after=0 WHERE id=?', [jobId]); const retry = await leaseJob(db, 'worker2'); await finishJob(db, retry!, 'worker2', { checked: true }); expect((await db.get('SELECT status FROM jobs WHERE id=?', [jobId]))!.status).toBe('completed'); });
  it('reclaims a crashed worker lease', async () => { const jobId = await enqueue(db, 'health', {}); await leaseJob(db, 'dead'); await db.run('UPDATE jobs SET lease_until=0 WHERE id=?', [jobId]); expect((await leaseJob(db, 'new'))!.lease_owner).toBe('new'); });
  it('requires same-origin mutations and privileged admin roles', async () => { const cross = new Request('http://localhost:3000/api/auth/register', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }); expect((await handleApi(cross, db)).status).toBe(403); expect((await handleApi(request('admin/overview'), db)).status).toBe(401); });
  it('enforces request body size while reading, including bodies without Content-Length', async () => { const origin = process.env.APP_ORIGIN || 'http://localhost:3000'; const large = new Request(`${origin}/api/auth/register`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: 'x'.repeat(11 * 1024 * 1024 + 1) }); expect((await handleApi(large, db)).status).toBe(413); });
  it('registers secure accounts, synchronizes progress, explicitly migrates guest progress and protects admin', async () => {
    const { titleId, sources } = await imported(); await checkSource(db, sources[0].id, media);
    const registered = await handleApi(request('auth/register', 'POST', { name: 'Viewer', email: 'viewer@test.dev', password: 'secure-password-123' }), db); expect(registered.status).toBe(201); const cookie = registered.headers.get('set-cookie')!.split(';')[0]; expect(registered.headers.get('set-cookie')).toContain('HttpOnly');
    const progress = await handleApi(request('progress', 'POST', { titleId, position: 72, duration: 100 }, cookie), db); expect(progress.status).toBe(200); expect((await (await handleApi(request('progress', 'GET', undefined, cookie), db)).json()).progress[0].position).toBe(72);
    const migration = await handleApi(request('progress/migrate', 'POST', { progress: [{ titleId, position: 90, duration: 100, updatedAt: Date.now() + 10 }] }, cookie), db); expect((await migration.json()).migrated).toBe(1);
    await handleApi(request('progress/migrate', 'POST', { progress: [{ titleId, position: 1, duration: 100, updatedAt: 1 }] }, cookie), db); const history = await (await handleApi(request('history', 'GET', undefined, cookie), db)).json(); expect(history.history[0].position).toBe(90);
    expect((await handleApi(request('admin/overview', 'GET', undefined, cookie), db)).status).toBe(403);
    await handleApi(request('auth/logout', 'POST', {}, cookie), db); expect((await (await handleApi(request('auth/me', 'GET', undefined, cookie), db)).json()).user).toBeNull();
  });
  it('preserves chosen password whitespace exactly during registration and login', async () => {
    const email = 'whitespace@test.dev'; const password = '  secure-password-123  ';
    expect((await handleApi(request('auth/register', 'POST', { name: 'Viewer', email, password }), db)).status).toBe(201);
    expect((await handleApi(request('auth/login', 'POST', { email, password: password.trim() }), db)).status).toBe(401);
    expect((await handleApi(request('auth/login', 'POST', { email, password }), db)).status).toBe(200);
  });
  it('provides end-to-end authorized import, worker verification, public playback and per-user list', async () => {
    const userId = id(); await db.run("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,'admin',?)", [userId, 'admin@test.dev', 'Admin', passwordHash('secure-password-123'), Date.now()]);
    const login = await handleApi(request('auth/login', 'POST', { email: 'admin@test.dev', password: 'secure-password-123' }), db); const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const added = await handleApi(request('admin/playlists', 'POST', { name: 'Licensed', content: m3u(), intervalHours: 5, authorized: true }, cookie), db); expect(added.status).toBe(201); const playlistId = (await added.json()).playlist.id; await synchronizePlaylist(db, playlistId); const source = await db.get('SELECT * FROM sources WHERE playlist_id=?', [playlistId]); await checkSource(db, source!.id, media);
    const feed = await handleApi(request('catalog'), db); const title = (await feed.json()).titles[0]; expect(title.name).toBe('A Film'); const play = await handleApi(request(`playback/${title.id}`), db); expect((await play.json()).sources[0].url).toBe('https://media.example.com/movie.mp4');
    expect((await handleApi(request('list', 'POST', { titleId: title.id }, cookie), db)).status).toBe(200); expect((await (await handleApi(request('list', 'GET', undefined, cookie), db)).json()).ids).toEqual([title.id]);
  });
  it('supports safe manual reclassification, episode creation and source reassignment', async () => {
    const { titleId, sources } = await imported(); await checkSource(db, sources[0].id, media); const userId = id(); await db.run("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,'admin',?)", [userId, 'classification@test.dev', 'Admin', passwordHash('secure-password-123'), Date.now()]);
    const login = await handleApi(request('auth/login', 'POST', { email: 'classification@test.dev', password: 'secure-password-123' }), db); const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const changed = await handleApi(request(`admin/titles/${titleId}`, 'PATCH', { type: 'series', published: true }, cookie), db); expect((await changed.json()).title.published).toBe(false); expect((await catalog(db, new URLSearchParams())).total).toBe(0);
    const episode = await handleApi(request('admin/episodes', 'POST', { titleId, season: 1, number: 1, name: 'Pilot', introStart: 0, introEnd: 5 }, cookie), db); expect(episode.status).toBe(201); const episodeId = (await episode.json()).episodeId;
    expect((await handleApi(request(`admin/sources/${sources[0].id}`, 'PATCH', { titleId, episodeId }, cookie), db)).status).toBe(200);
    await handleApi(request(`admin/titles/${titleId}`, 'PATCH', { published: true }, cookie), db); expect((await catalog(db, new URLSearchParams())).total).toBe(1); expect((await playbackSources(db, titleId, episodeId))).toHaveLength(1);
  });
});

describe('licensed playback signing', () => {
  const source: Source = { id: 'source', titleId: 'title', episodeId: null, name: 'Server', format: 'mp4', health: 'healthy', enabled: true, priority: 0, quality: null, lastChecked: Date.now(), lastSuccess: Date.now(), error: null, url: 'https://private-provider.example/video?token=long-lived-secret' };
  async function configured(fn: () => Promise<void>) {
    const old = [process.env.PLAYBACK_SIGNER_URL, process.env.PLAYBACK_SIGNER_API_KEY, process.env.REQUIRE_PLAYBACK_SIGNER];
    process.env.PLAYBACK_SIGNER_URL = 'https://signer.example/access'; process.env.PLAYBACK_SIGNER_API_KEY = 'server-secret';
    try { await fn(); } finally { for (const [i, name] of ['PLAYBACK_SIGNER_URL', 'PLAYBACK_SIGNER_API_KEY', 'REQUIRE_PLAYBACK_SIGNER'].entries()) { if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i]; } }
  }
  it('exchanges a private URL server-to-server and returns only a short-lived public grant', async () => { await configured(async () => {
    const fetcher: SafeFetcher = async (url, options) => { expect(options!.method).toBe('POST'); expect(options!.headers!.Authorization).toBe('Bearer server-secret'); expect(JSON.parse(options!.body!).url).toContain('long-lived-secret'); return { status: 200, body: Buffer.from(JSON.stringify({ url: 'https://cdn.example/video?signature=short-lived', expiresAt: Date.now() + 60000 })), headers: {}, url, truncated: false }; };
    const grants = await authorizePlaybackSources([source], fetcher, async () => {}); expect(grants[0].url).not.toContain('long-lived-secret'); expect(grants[0].url).toContain('short-lived');
  }); });
  it('fails closed on provider failure, private output, HTTP output or excessive expiry', async () => { await configured(async () => {
    await expect(requestPlaybackGrant(source, broken, async () => {})).rejects.toThrow();
    for (const grant of [{ url: 'https://127.0.0.1/video', expiresAt: Date.now() + 60000 }, { url: 'http://cdn.example/video', expiresAt: Date.now() + 60000 }, { url: 'https://cdn.example/video', expiresAt: Date.now() + 86400000 }]) {
      const fetcher: SafeFetcher = async url => ({ status: 200, body: Buffer.from(JSON.stringify(grant)), headers: {}, url, truncated: false }); await expect(requestPlaybackGrant(source, fetcher, async () => {})).rejects.toThrow();
    }
  }); });
  it('requires a configured signer when confidential-source policy is enabled', async () => { await configured(async () => { delete process.env.PLAYBACK_SIGNER_URL; delete process.env.PLAYBACK_SIGNER_API_KEY; process.env.REQUIRE_PLAYBACK_SIGNER = 'true'; await expect(authorizePlaybackSources([source])).rejects.toThrow(); }); });
  it('retains successfully signed servers in rank order when other grants fail, without leaking private URLs', async () => { await configured(async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const candidates = ['first', 'broken', 'second', 'broken-again', 'third'].map(id => ({ ...source, id }));
      const fetcher: SafeFetcher = async (url, options) => { const payload = JSON.parse(options!.body!); if (payload.sourceId.startsWith('broken')) throw new Error(`Signing failed for ${payload.url}`); return { status: 200, body: Buffer.from(JSON.stringify({ url: `https://cdn.example/${payload.sourceId}?signature=short-lived`, expiresAt: Date.now() + 60000 })), headers: {}, url, truncated: false }; };
      const grants = await authorizePlaybackSources(candidates, fetcher, async () => {});
      expect(grants.map(s => s.id)).toEqual(['first', 'second', 'third']); expect(JSON.stringify(grants)).not.toContain('long-lived-secret');
      expect(log).toHaveBeenCalledTimes(2); for (const call of log.mock.calls) { const entry = JSON.parse(call[0] as string); expect(entry.sourceId).toContain('broken'); expect(entry.error).toContain('[redacted source]'); expect(call[0]).not.toContain('private-provider.example'); }
    } finally { log.mockRestore(); }
  }); });
  it('returns503 when every grant fails and rejects invalid shared configuration before calling the signer', async () => { await configured(async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(authorizePlaybackSources([source, { ...source, id: 'other' }], broken, async () => {})).rejects.toMatchObject({ status: 503 });
      let calls = 0; const fetcher: SafeFetcher = async url => { calls++; return media(url); };
      delete process.env.PLAYBACK_SIGNER_API_KEY; await expect(authorizePlaybackSources([source], fetcher, async () => {})).rejects.toMatchObject({ status: 503 }); expect(calls).toBe(0);
      process.env.PLAYBACK_SIGNER_API_KEY = 'server-secret'; process.env.PLAYBACK_SIGNER_URL = 'http://signer.example/access'; await expect(authorizePlaybackSources([source], fetcher, async () => {})).rejects.toMatchObject({ status: 503 }); expect(calls).toBe(0);
    } finally { log.mockRestore(); }
  }); });
});
