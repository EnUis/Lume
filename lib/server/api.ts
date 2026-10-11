import type { DB, Row } from './db';
import type { Progress, Source, User } from '../types';
import { database, isSqliteBusy } from './db';
import { AppError, audit, clearCookie, currentUser, decrypt, encrypt, hash, id, passwordHash, rateLimit, requireUser, sameOrigin, sanitizeError, session, verifyPassword } from './security';
import { publicContentSQL, supportedContentSQL, accessibleTitleSQL, catalog, playbackSources, resolveTitleId, resolveEpisodeId, sourceRecord, titleDetails, titleRecord } from './catalog';
import { enqueue } from './jobs';
import { normalizeTitle, inferFormat } from './m3u';
import { createTitle, safeImage } from './pipeline';
import { validateSourceUrl } from './outbound';
import { mergeTitles, splitSource, updateEpisode } from './management';
import { authorizePlaybackSources } from './playback-access';
import { adminOverview } from './admin-overview';
import { existingPlaybackBlock, lockPlaybackUrl } from './playback-state';
import { startMediaSession, stopMediaSession, streamMedia, mediaSessionStatus, MediaRuntimeError } from './media-runtime';

const response = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const text = (value: unknown, name: string, max = 200, min = 1) => { if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new AppError(400, `${name} must contain ${min}–${max} characters`); return value.trim(); };
const requiredText = (value: unknown, name: string) => { if (typeof value !== 'string' || !value.trim()) throw new AppError(400, `${name} is required`); return value.trim(); };
const number = (value: unknown, name: string, min: number, max: number) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new AppError(400, `${name} must be between ${min} and ${max}`); return value; };
const boolean = (value: unknown, name: string) => { if (typeof value !== 'boolean') throw new AppError(400, `${name} must be true or false`); return value; };
async function body(request: Request, limit: number | null = 11 * 1024 * 1024) {
  if (limit !== null && Number(request.headers.get('content-length')) > limit) throw new AppError(413, 'Request is too large');
  const reader = request.body?.getReader(); if (!reader) throw new AppError(400, 'JSON body is required'); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (limit !== null && size > limit) { await reader.cancel(); throw new AppError(413, 'Request is too large'); } chunks.push(next.value); }
  const value = Buffer.concat(chunks).toString('utf8'); try { const data = JSON.parse(value); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data as Record<string, any>; } catch { throw new AppError(400, 'Invalid JSON body'); }
}
const attemptLifetime = 15 * 60000;
type PlaybackAttempt = { kind: 'playback-attempt-v1'; sourceId: string; urlHash: string; issuedAt: number; expiresAt: number; blockedAt: number | null; viewer: string };
async function playbackSourceRow(db: DB, sourceId: string, lock = false) {
  return db.get(`SELECT s.*,p.enabled AS playlist_enabled,t.published AS title_published,t.type AS title_type FROM sources s JOIN titles t ON t.id=s.title_id LEFT JOIN playlists p ON p.id=s.playlist_id WHERE s.id=?${lock && db.dialect === 'postgres' ? ' FOR UPDATE OF s' : ''}`, [sourceId]);
}
function eligiblePlaybackSource(source: Row | undefined) {
  return !!source && ['movie', 'series', 'live'].includes(source.title_type) && !!source.enabled && !source.removed && source.playlist_enabled !== 0 && !!source.title_published && (source.title_type === 'series' ? !!source.episode_id : !source.episode_id);
}
function attemptFields(source: Row, viewer: string) {
  const issuedAt = Math.max(Date.now(), Number(source.playback_blocked_at || 0)); const expiresAt = issuedAt + attemptLifetime;
  const attempt: PlaybackAttempt = { kind: 'playback-attempt-v1', sourceId: source.id, urlHash: source.url_hash, issuedAt, expiresAt, blockedAt: source.playback_blocked_at == null ? null : Number(source.playback_blocked_at), viewer };
  return { playbackAttemptToken: encrypt(JSON.stringify(attempt)), playbackAttemptExpiresAt: expiresAt };
}
function readAttempt(value: unknown, sourceId: string, viewer: string, allowExpired = false): PlaybackAttempt {
  if (typeof value !== 'string' || !value || value.length > 2000) throw new AppError(403, 'A valid playback attempt is required');
  let attempt: PlaybackAttempt;
  try { attempt = JSON.parse(decrypt(value)); } catch { throw new AppError(403, 'Invalid playback attempt'); }
  if (!attempt || attempt.kind !== 'playback-attempt-v1' || attempt.sourceId !== sourceId || attempt.viewer !== viewer || typeof attempt.urlHash !== 'string' || !Number.isSafeInteger(attempt.issuedAt) || !Number.isSafeInteger(attempt.expiresAt) || attempt.expiresAt - attempt.issuedAt !== attemptLifetime || attempt.blockedAt !== null && !Number.isSafeInteger(attempt.blockedAt)) throw new AppError(403, 'Invalid playback attempt');
  if (!allowExpired && attempt.expiresAt <= Date.now()) throw new AppError(403, 'Playback attempt expired; renew the attempt');
  return attempt;
}
function currentAttempt(attempt: PlaybackAttempt, source: Row) {
  if (attempt.urlHash !== source.url_hash) throw new AppError(409, 'The source changed; request a new playback attempt');
}
async function authorizedAttempts(db: DB, sources: Source[], viewer: string, explicitRetry = false) {
  if (!sources.length) return [];
  const originalHashes = new Map(sources.map(source => [source.id, hash(source.url!)]));
  const authorized = await authorizePlaybackSources(sources); const result: Source[] = [];
  for (const source of authorized) {
    const current = await playbackSourceRow(db, source.id);
    if (!eligiblePlaybackSource(current) || current!.url_hash !== originalHashes.get(source.id)) continue;
    if (!explicitRetry && (current!.health !== 'healthy' || current!.playback_blocked)) continue;
    result.push({ ...source, conversionRequired: source.format === 'unknown', health: current!.health, playbackBlocked: !!current!.playback_blocked, ...attemptFields(current!, viewer), ...(explicitRetry ? { playbackRetry: true } : {}) });
  }
  return result;
}
function playlistRecord(row: Row) { return { id: row.id, name: row.name, enabled: !!row.enabled, intervalHours: Number(row.interval_hours), lastSync: row.last_sync === null ? null : Number(row.last_sync), nextSync: row.next_sync === null ? null : Number(row.next_sync), health: row.health, error: row.error, entryCount: Number(row.entry_count), ...(row.url_encrypted ? { url: `${new URL(decrypt(row.url_encrypted)).origin}/…` } : {}) }; }
function progressRecord(row: Row): Progress { return { titleId: row.title_id, episodeId: row.episode_id, position: Number(row.position), duration: Number(row.duration), updatedAt: Number(row.updated_at) }; }
async function saveProgress(db: DB, userId: string, data: Record<string, any>, onlyNewer = false) {
  const originalTitleId = text(data.titleId, 'Title id', 64); const titleId = await resolveTitleId(db, originalTitleId);
  // Older imports saved split episodes as movie-level progress. A repair can
  // preserve that former title ID as both a title redirect and an episode alias.
  // Resolve the episode from the original ID before losing that distinction.
  const formerEpisode = !data.episodeId ? await db.get('SELECT episode_id FROM episode_redirects WHERE alias_id=?', [originalTitleId]) : null;
  const episodeId = data.episodeId ? await resolveEpisodeId(db, text(data.episodeId, 'Episode id', 64)) : formerEpisode ? await resolveEpisodeId(db, formerEpisode.episode_id) : null;
  const title = await db.get('SELECT type,duration FROM titles WHERE id=?', [titleId]); if (!title || !['movie', 'series'].includes(title.type)) throw new AppError(404, 'Title not found');
  if (title.type === 'series' && !episodeId || title.type !== 'series' && episodeId) throw new AppError(400, 'Progress must identify the correct episode');
  if (episodeId && !(await db.get('SELECT id FROM episodes WHERE id=? AND title_id=?', [episodeId, titleId]))) throw new AppError(400, 'Episode does not belong to title');
  const duration = number(data.duration, 'Duration', 1, 86400); const position = Math.min(number(data.position, 'Position', 0, 86400), duration);
  const updatedAt = onlyNewer && Number.isFinite(data.updatedAt) ? Math.min(Date.now(), Math.max(0, data.updatedAt)) : Date.now(); const itemKey = episodeId || titleId;
  if (onlyNewer) { const previous = await db.get('SELECT * FROM playback_progress WHERE user_id=? AND item_key=?', [userId, itemKey]); if (previous && Number(previous.updated_at) >= updatedAt) return progressRecord(previous); }
  await db.run(`INSERT INTO playback_progress(user_id,title_id,episode_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,item_key) DO UPDATE SET position=excluded.position,duration=excluded.duration,updated_at=excluded.updated_at ${onlyNewer ? 'WHERE excluded.updated_at>playback_progress.updated_at' : ''}`, [userId, titleId, episodeId, itemKey, position, duration, updatedAt]);
  const existing = await db.get('SELECT id FROM watch_history WHERE user_id=? AND title_id=? AND '+(episodeId ? 'episode_id=?' : 'episode_id IS NULL')+' ORDER BY updated_at DESC LIMIT 1', episodeId ? [userId, titleId, episodeId] : [userId, titleId]);
  if (existing) await db.run(`UPDATE watch_history SET position=?,duration=?,updated_at=? WHERE id=? ${onlyNewer ? 'AND updated_at<=?' : ''}`, onlyNewer ? [position, duration, updatedAt, existing.id, updatedAt] : [position, duration, updatedAt, existing.id]);
  else await db.run('INSERT INTO watch_history(id,user_id,title_id,episode_id,position,duration,updated_at) VALUES(?,?,?,?,?,?,?)', [id(), userId, titleId, episodeId, position, duration, updatedAt]);
  return { titleId, episodeId, position, duration, updatedAt };
}
function markerFields(data: Record<string, any>, existing: Row) {
  const fields: Record<string, unknown> = {};
  for (const [key, column] of Object.entries({ introStart: 'intro_start', introEnd: 'intro_end', recapStart: 'recap_start', recapEnd: 'recap_end' })) if (data[key] !== undefined) fields[column] = data[key] === null ? null : number(data[key], key, 0, 86400);
  for (const prefix of ['intro', 'recap']) { const start = fields[`${prefix}_start`] ?? existing[`${prefix}_start`]; const end = fields[`${prefix}_end`] ?? existing[`${prefix}_end`]; if (start !== null && start !== undefined && end !== null && end !== undefined && Number(end) <= Number(start)) throw new AppError(400, `${prefix} end must follow start`); }
  return fields;
}
async function updateTitle(db: DB, titleId: string, data: Record<string, any>) {
  const existing = await db.get('SELECT * FROM titles WHERE id=?', [titleId]); if (!existing) throw new AppError(404, 'Title not found');
  const fields: Record<string, unknown> = markerFields(data, existing);
  for (const [key, column, max] of [['name', 'name', 200], ['synopsis', 'synopsis', 10000], ['director', 'director', 200], ['ageRating', 'age_rating', 30], ['attribution', 'attribution', 4000]] as const) if (data[key] !== undefined) fields[column] = data[key] === null && key === 'ageRating' ? null : text(data[key], key, max, key === 'name' ? 1 : 0);
  if (data.name !== undefined) fields.normalized = normalizeTitle(data.name);
  for (const key of ['poster', 'backdrop', 'trailer']) if (data[key] !== undefined) { const value = text(data[key], key, 2000, 0); if (value && !safeImage(value)) throw new AppError(400, `${key} must be a public HTTPS or local image URL`); fields[key] = value; }
  for (const key of ['featured', 'published', 'demo']) if (data[key] !== undefined) fields[key] = boolean(data[key], key) ? 1 : 0;
  if (data.year !== undefined) fields.year = data.year === null ? null : number(data.year, 'Year', 1888, 2100);
  if (data.duration !== undefined) fields.duration = data.duration === null ? null : number(data.duration, 'Duration', 1, 86400);
  for (const [key, column] of [['genres', 'genres'], ['cast', 'cast_members']] as const) if (data[key] !== undefined) { if (!Array.isArray(data[key]) || data[key].length > 50) throw new AppError(400, `${key} must be an array`); fields[column] = JSON.stringify(data[key].map((value: unknown) => text(value, key, 200))); }
  if (data.type !== undefined && data.type !== existing.type) { if (!['movie', 'series', 'live'].includes(data.type)) throw new AppError(400, 'Invalid content type'); fields.type = data.type; fields.published = 0; }
  if (Object.keys(fields).length) await db.run(`UPDATE titles SET ${Object.keys(fields).map(key => `${key}=?`).join(',')},updated_at=? WHERE id=?`, [...Object.values(fields), Date.now(), titleId]);
  if (Object.keys(fields).some(key => !['featured', 'published', 'demo'].includes(key))) await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,?) ON CONFLICT(title_id) DO UPDATE SET updated_at=excluded.updated_at', [titleId, Date.now()]);
  if (data.alternateTitles !== undefined) { if (!Array.isArray(data.alternateTitles) || data.alternateTitles.length > 20) throw new AppError(400, 'alternateTitles must contain at most 20 titles'); await db.run('DELETE FROM title_aliases WHERE title_id=?', [titleId]); for (const alias of data.alternateTitles) { const name = text(alias, 'Alternate title', 200); await db.run('INSERT INTO title_aliases(id,title_id,name,normalized) VALUES(?,?,?,?) ON CONFLICT DO NOTHING', [id(), titleId, name, normalizeTitle(name)]); } }
}
export async function handleApi(request: Request, providedDB?: DB): Promise<Response> {
  try {
    sameOrigin(request); const db = providedDB || await database();
    const url = new URL(request.url); const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean); const method = request.method; const user = await currentUser(db, request);
    const identity = user?.id || (process.env.TRUST_PROXY === 'true' ? hash(request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'anonymous') : 'anonymous');
    if (!['GET', 'HEAD'].includes(method)) await rateLimit(db, `mutation:${identity}`, user ? 240 : 120, 60000);
    if (path[0] === 'health' && method === 'GET') { await db.get('SELECT 1 AS ok'); return response({ ok: true, database: 'connected' }); }
    if (path[0] === 'catalog' && method === 'GET') return response(await catalog(db, url.searchParams));
    if (path[0] === 'playback' && path[1] === 'prepare' && method === 'POST') {
      const data = await body(request, 8000); const sourceId = text(data.sourceId, 'Source id', 64);
      const attempt = readAttempt(data.playbackAttemptToken, sourceId, identity);
      await rateLimit(db, `prepare:${identity}`, 40, 60000);
      const row = await playbackSourceRow(db, sourceId); if (!eligiblePlaybackSource(row)) throw new AppError(404, 'Source is no longer available'); currentAttempt(attempt, row!);
      if (row!.playback_blocked && (attempt.blockedAt !== Number(row!.playback_blocked_at) || attempt.issuedAt < Number(row!.playback_blocked_at))) throw new AppError(409, 'Request a fresh playback attempt before retrying');
      const startAt = data.startAt === undefined ? 0 : number(data.startAt, 'Playback position', 0, 86400);
      if (row!.title_type === 'live' && startAt !== 0) throw new AppError(400, 'Live TV starts at the current broadcast and cannot seek to a saved position');
      const audioTrack = data.audioTrack === undefined ? undefined : number(data.audioTrack, 'Audio track', 0, 1024);
      if (audioTrack !== undefined && !Number.isInteger(audioTrack)) throw new AppError(400, 'Audio track must be an integer');
      const grants = await authorizePlaybackSources([sourceRecord(row!, true)]); if (!grants[0]?.url) throw new AppError(503, 'Playback access could not be issued');
      if (typeof data.previousSessionId === 'string') stopMediaSession(data.previousSessionId, identity);
      const conversion = await startMediaSession({ sourceId, url: grants[0].url, urlHash: row!.url_hash, viewer: identity, startAt, audioTrack, live: row!.title_type === 'live' });
      // Recheck permission and URL after probing, which may take several seconds.
      const current = await playbackSourceRow(db, sourceId);
      if (!eligiblePlaybackSource(current) || current!.url_hash !== row!.url_hash || current!.playback_blocked_at !== row!.playback_blocked_at) { stopMediaSession(conversion.sessionId, identity); throw new AppError(409, 'The source changed while preparing playback'); }
      const access = encrypt(JSON.stringify({ kind: 'converted-video-v1', sessionId: conversion.sessionId, sourceId, urlHash: row!.url_hash, viewer: identity, expiresAt: Date.now() + 8 * 3600000, blockedAt: attempt.blockedAt }));
      return response({ source: { ...grants[0], format: 'mp4', url: `/api/media/${conversion.sessionId}/stream.mp4?access=${encodeURIComponent(access)}`, conversionRequired: false, conversion, ...attemptFields(current!, identity) } });
    }
    if (path[0] === 'playback' && path[1] === 'release' && method === 'POST') { const data = await body(request, 2000); stopMediaSession(text(data.sessionId, 'Playback session', 64), identity); return response({ ok: true }); }
    if (path[0] === 'playback' && path[1] === 'session' && path[2] && method === 'GET') { const state = mediaSessionStatus(path[2], identity); return response({ status: state.status, classification: state.classification, error: state.error }); }
    if (path[0] === 'media' && path[1] && path[2] === 'stream.mp4' && ['GET', 'HEAD'].includes(method)) {
      let access: any; try { access = JSON.parse(decrypt(text(url.searchParams.get('access'), 'Playback access', 3000))); } catch { throw new AppError(403, 'Invalid playback access'); }
      if (access.kind !== 'converted-video-v1' || access.sessionId !== path[1] || access.viewer !== identity || !Number.isFinite(access.expiresAt) || access.expiresAt <= Date.now()) throw new AppError(403, 'Playback access expired');
      const row = await playbackSourceRow(db, access.sourceId);
      if (!eligiblePlaybackSource(row) || row!.url_hash !== access.urlHash || row!.playback_blocked && access.blockedAt !== Number(row!.playback_blocked_at)) throw new AppError(403, 'This source is no longer available');
      const session = mediaSessionStatus(path[1], identity);
      if (session.sourceId !== access.sourceId || session.urlHash !== access.urlHash) throw new AppError(403, 'Playback session does not match this source');
      const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none', 'X-Content-Type-Options': 'nosniff' };
      if (method === 'HEAD') return new Response(null, { headers });
      return new Response(await streamMedia(path[1], identity, request.signal), { headers });
    }
    if (path[0] === 'titles' && path[1] && method === 'GET') { const title = await titleDetails(db, path[1]); if (!title) throw new AppError(404, 'This title is currently unavailable'); const related = (await catalog(db, new URLSearchParams({ type: title.type, limit: '13' }))).titles.filter(t => t!.id !== title.id).slice(0, 12); return response({ title, related }); }
    if (path[0] === 'playback' && path[1] === 'attempt' && method === 'POST') {
      const data = await body(request, 8000); const sourceId = text(data.sourceId, 'Source id', 64); const previous = data.playbackAttemptToken === undefined ? null : readAttempt(data.playbackAttemptToken, sourceId, identity, true);
      await rateLimit(db, `attempt:${identity}:${sourceId}`, 20, 60000);
      const source = await playbackSourceRow(db, sourceId); if (!eligiblePlaybackSource(source)) throw new AppError(404, 'Source is not available for a playback attempt');
      if (previous) currentAttempt(previous, source!);
      if (!source!.playback_blocked && source!.health !== 'healthy' && !previous) throw new AppError(409, 'This source has not been verified for playback');
      const sources = await authorizedAttempts(db, [sourceRecord(source!, true)], identity, true); if (!sources.length) throw new AppError(409, 'The source changed; request a new playback attempt');
      return response({ source: sources[0] });
    }
    if (path[0] === 'playback' && ['failure', 'success'].includes(path[1]) && method === 'POST') {
      const data = await body(request, 8000); const sourceId = text(data.sourceId, 'Source id', 64); const attempt = readAttempt(data.playbackAttemptToken, sourceId, identity);
      await rateLimit(db, `${path[1]}:${identity}:${sourceId}`, path[1] === 'failure' ? 10 : 30, 60000);
      const now = Date.now(); const browserError = 'Browser playback failed; hidden until a new browser playback attempt succeeds';
      const restored = await db.transaction(async tx => {
        if (path[1] === 'failure') await lockPlaybackUrl(tx, attempt.urlHash);
        // Lock duplicate references in one order before touching the reporting row, so
        // concurrent failures for different references cannot lock each other out.
        const affected = path[1] === 'failure' ? await tx.all('SELECT id FROM sources WHERE url_hash=? ORDER BY id' + (tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), [attempt.urlHash]) : [];
        const source = await playbackSourceRow(tx, sourceId, path[1] !== 'failure'); if (!source) throw new AppError(404, 'Source not found'); currentAttempt(attempt, source);
        if (!eligiblePlaybackSource(source)) throw new AppError(409, 'This source is no longer available for playback');
        if (path[1] === 'failure') {
          if (!affected.some(reference => reference.id === sourceId)) throw new AppError(409, 'The source changed; request a new playback attempt');
          // Update only the rows already locked; imports inherit known URL blocks.
          // Every reference gets its own newer revision, invalidating old success tokens.
          for (let offset = 0; offset < affected.length; offset += 200) {
            const references = affected.slice(offset, offset + 200);
            await tx.run(`UPDATE sources SET playback_blocked=1,playback_blocked_at=CASE WHEN COALESCE(playback_blocked_at,0)>=? THEN playback_blocked_at+1 ELSE ? END,health='unavailable',last_failure=?,error=?,failures=failures+1 WHERE url_hash=? AND id IN (${references.map(() => '?').join(',')})`, [now, now, now, browserError, attempt.urlHash, ...references.map(row => row.id)]);
            await tx.run(`INSERT INTO source_health_history(id,source_id,health,error,created_at) VALUES ${references.map(() => '(?,?,?,?,?)').join(',')}`, references.flatMap(row => [id(), row.id, 'unavailable', browserError, now]));
          }
          return false;
        }
        if (source.playback_blocked && (attempt.blockedAt !== Number(source.playback_blocked_at) || attempt.issuedAt < Number(source.playback_blocked_at))) throw new AppError(409, 'Playback failed after this attempt; start a new playback attempt');
        const changed = !!source.playback_blocked || source.health !== 'healthy';
        await tx.run("UPDATE sources SET playback_blocked=0,playback_blocked_at=NULL,health='healthy',last_checked=?,last_success=?,error=NULL,failures=0,successes=successes+1 WHERE id=? AND url_hash=?", [now, now, sourceId, attempt.urlHash]);
        if (changed) await tx.run('INSERT INTO source_health_history(id,source_id,health,error,created_at) VALUES(?,?,?,?,?)', [id(), sourceId, 'healthy', null, now]); return changed;
      });
      if (path[1] === 'success') return response({ ok: true, restored });
      const jobId = await enqueue(db, 'health', { sourceId }, { dedupeKey: `health:${sourceId}` }); return response({ blocked: true, queued: true, jobId });
    }
    if (path[0] === 'playback' && path[1] && method === 'GET') { await rateLimit(db, `playback:${identity}`, 300, 60000); return response({ sources: await authorizedAttempts(db, await playbackSources(db, path[1], url.searchParams.get('episodeId')), identity) }); }
    if (path[0] === 'auth') {
      if (path[1] === 'me' && method === 'GET') return response({ user });
      if (['register', 'login'].includes(path[1]) && method === 'POST') {
        const data = await body(request); const email = text(data.email, 'Email', 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'Enter a valid email address');
        await rateLimit(db, `auth:${identity}`, 10, 600000); await rateLimit(db, `auth-email:${hash(email)}`, 10, 600000);
        const password = data.password; const passwordMinimum = path[1] === 'register' ? 12 : 1; if (typeof password !== 'string' || password.length < passwordMinimum || password.length > 128) throw new AppError(400, `Password must contain ${passwordMinimum}–128 characters`); let account = await db.get('SELECT * FROM users WHERE email=?', [email]);
        if (path[1] === 'register') {
          if (account) throw new AppError(409, 'An account already uses this email'); const name = text(data.name, 'Name', 80); const userId = id(); const now = Date.now();
          await db.transaction(async tx => { await tx.run("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,'user',?)", [userId, email, name, passwordHash(password), now]); await tx.run('INSERT INTO profiles(id,user_id,name,created_at) VALUES(?,?,?,?)', [id(), userId, name, now]); });
          account = { id: userId, email, name, role: 'user' };
        } else { const valid = verifyPassword(password, account?.password_hash); if (!account || !valid) throw new AppError(401, 'Email or password is incorrect'); }
        return response({ user: { id: account!.id, name: account!.name, email: account!.email, role: account!.role } }, path[1] === 'register' ? 201 : 200, { 'Set-Cookie': await session(db, account!.id) });
      }
      if (path[1] === 'logout' && method === 'POST') { const token = request.headers.get('cookie')?.match(/luma_session=([a-f0-9]{64})/)?.[1]; if (token) await db.run('DELETE FROM sessions WHERE id=?', [hash(token)]); return response({ ok: true }, 200, { 'Set-Cookie': clearCookie() }); }
    }
    if (['progress', 'list', 'history', 'preferences', 'favorites', 'profiles', 'library'].includes(path[0])) {
      const account = requireUser(user);
      if (path[0] === 'library' && method === 'GET') {
        const titles = await db.all(`SELECT t.*,${accessibleTitleSQL} AS available FROM titles t WHERE ${supportedContentSQL} AND t.id IN (SELECT title_id FROM watchlist WHERE user_id=? UNION SELECT title_id FROM favorites WHERE user_id=? UNION SELECT p.title_id FROM playback_progress p JOIN titles progress_title ON progress_title.id=p.title_id WHERE p.user_id=? AND progress_title.type IN ('movie','series') UNION SELECT h.title_id FROM watch_history h JOIN titles history_title ON history_title.id=h.title_id WHERE h.user_id=? AND history_title.type IN ('movie','series')) ORDER BY t.name LIMIT 1000`, [account.id, account.id, account.id, account.id]);
        return response({ titles: titles.map(row => ({ ...titleRecord(row), available: !!row.available && !!row.published })) });
      }
      if (path[0] === 'progress') {
        if (method === 'GET') return response({ progress: (await db.all(`SELECT p.* FROM playback_progress p JOIN titles t ON t.id=p.title_id WHERE p.user_id=? AND ${publicContentSQL} ORDER BY p.updated_at DESC LIMIT 300`, [account.id])).map(progressRecord) });
        if (method === 'POST') { const data = await body(request); if (path[1] === 'migrate') { if (!Array.isArray(data.progress) || data.progress.length > 300) throw new AppError(400, 'Progress must contain at most 300 entries'); let migrated = 0; for (const item of data.progress) { try { await saveProgress(db, account.id, item, true); migrated++; } catch (error) { if (!(error instanceof AppError) || error.status >= 500) throw error; } } return response({ migrated }); } return response({ progress: await saveProgress(db, account.id, data) }); }
        if (method === 'DELETE') { await db.run('DELETE FROM playback_progress WHERE user_id=?', [account.id]); await db.run('DELETE FROM watch_history WHERE user_id=?', [account.id]); return response({ ok: true }); }
      }
      if (path[0] === 'list' || path[0] === 'favorites') {
        const table = path[0] === 'list' ? 'watchlist' : 'favorites';
        if (method === 'GET') return response({ ids: (await db.all(`SELECT saved.title_id FROM ${table} saved JOIN titles t ON t.id=saved.title_id WHERE saved.user_id=? AND ${supportedContentSQL} ORDER BY saved.created_at DESC`, [account.id])).map(row => row.title_id) });
        const titleId = await resolveTitleId(db, method === 'DELETE' ? text(url.searchParams.get('titleId'), 'Title id', 64) : text((await body(request)).titleId, 'Title id', 64));
        if (method === 'POST') { if (!(await db.get(`SELECT t.id FROM titles t WHERE t.id=? AND ${supportedContentSQL}`, [titleId]))) throw new AppError(404, 'Title not found'); await db.run(`INSERT INTO ${table}(user_id,title_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`, [account.id, titleId, Date.now()]); return response({ ok: true }); }
        if (method === 'DELETE') { await db.run(`DELETE FROM ${table} WHERE user_id=? AND title_id=?`, [account.id, titleId]); return response({ ok: true }); }
      }
      if (path[0] === 'history' && method === 'GET') return response({ history: (await db.all(`SELECT h.*,t.name AS title_name FROM watch_history h JOIN titles t ON t.id=h.title_id WHERE h.user_id=? AND ${publicContentSQL} ORDER BY h.updated_at DESC LIMIT 100`, [account.id])).map(row => ({ ...progressRecord(row), titleName: row.title_name })) });
      if (path[0] === 'preferences') { const row = await db.get('SELECT preferences FROM users WHERE id=?', [account.id]); const preferences = { autoplay: true, language: 'en', ...JSON.parse(row!.preferences) }; if (method === 'GET') return response({ preferences }); if (method === 'PATCH') { const data = await body(request); if (data.autoplay !== undefined) preferences.autoplay = boolean(data.autoplay, 'Autoplay'); if (data.language !== undefined) preferences.language = text(data.language, 'Language', 20); await db.run('UPDATE users SET preferences=? WHERE id=?', [JSON.stringify(preferences), account.id]); return response({ preferences }); } }
      if (path[0] === 'profiles' && method === 'GET') return response({ profiles: (await db.all('SELECT id,name FROM profiles WHERE user_id=?', [account.id])) });
    }
    if (path[0] === 'admin') {
      const actor = requireUser(user, ['admin', 'editor']);
      if (method === 'DELETE' || ['merge', 'split', 'restore'].includes(path[2] || '') || path[1] === 'users') requireUser(user, ['admin']);
      if (path[1] === 'overview' && method === 'GET') return response(await adminOverview(db, playlistRecord));
      if (path[1] === 'catalog' && method === 'GET') { const params = new URLSearchParams(url.searchParams); if (!params.has('limit')) params.set('limit', '24'); return response(await catalog(db, params, true)); }
      if (path[1] === 'playlists') {
        const playlistId = path[2];
        if (!playlistId && method === 'GET') return response({ playlists: (await db.all('SELECT * FROM playlists ORDER BY created_at DESC')).map(playlistRecord) });
        if (!playlistId && method === 'POST') {
          // Only the authenticated playlist import route accepts bodies without an application size cap.
          const data = await body(request, null); if (data.authorized !== true) throw new AppError(400, 'Confirm that you are authorized to use this playlist');
          const name = text(data.name, 'Playlist name', 120); const interval = number(data.intervalHours ?? 24, 'Refresh interval', 0.25, 8760); const sourceUrl = data.url ? validateSourceUrl(requiredText(data.url, 'Playlist URL')).toString() : null;
          const content = data.content ? requiredText(data.content, 'Playlist content') : null; if (!sourceUrl && !content || sourceUrl && content) throw new AppError(400, 'Provide either a playlist URL or file content');
          const playlistId = id(); await db.run('INSERT INTO playlists(id,name,url_encrypted,content_encrypted,interval_hours,next_sync,created_at) VALUES(?,?,?,?,?,?,?)', [playlistId, name, sourceUrl ? encrypt(sourceUrl) : null, content ? encrypt(content) : null, interval, Date.now(), Date.now()]);
          const jobId = await enqueue(db, 'sync', { playlistId }, { dedupeKey: `sync:${playlistId}` }); await audit(db, actor.id, 'playlist.create', playlistId, { name }); return response({ playlist: playlistRecord((await db.get('SELECT * FROM playlists WHERE id=?', [playlistId]))!), jobId }, 201);
        }
        if (playlistId) {
          const row = await db.get('SELECT * FROM playlists WHERE id=?', [playlistId]); if (!row) throw new AppError(404, 'Playlist not found');
          if (path[3] === 'history' && method === 'GET') return response({ history: (await db.all('SELECT id,content_hash,report,created_at FROM playlist_versions WHERE playlist_id=? ORDER BY created_at DESC LIMIT 50', [playlistId])).map(version => ({ id: version.id, contentHash: version.content_hash, report: JSON.parse(version.report), createdAt: Number(version.created_at) })) });
          if (path[3] === 'restore' && method === 'POST') { requireUser(user, ['admin']); const data = await body(request); const version = await db.get('SELECT id FROM playlist_versions WHERE id=? AND playlist_id=?', [text(data.versionId, 'Version id', 64), playlistId]); if (!version) throw new AppError(404, 'Version not found'); const jobId = await enqueue(db, 'sync', { playlistId, versionId: version.id }, { dedupeKey: `sync:${playlistId}`, expedite: true }); await audit(db, actor.id, 'playlist.restore', playlistId, { versionId: version.id }); return response({ queued: true, jobId }); }
          if (path[3] === 'sync' && method === 'POST') { const jobId = await enqueue(db, 'sync', { playlistId }, { dedupeKey: `sync:${playlistId}`, expedite: true }); await audit(db, actor.id, 'playlist.sync', playlistId); return response({ queued: true, jobId }); }
          if (method === 'PATCH') {
            const data = await body(request); const fields: Record<string, unknown> = {};
            if (data.name !== undefined) fields.name = text(data.name, 'Playlist name', 120); if (data.enabled !== undefined) fields.enabled = boolean(data.enabled, 'Enabled') ? 1 : 0;
            if (data.intervalHours !== undefined) { fields.interval_hours = number(data.intervalHours, 'Refresh interval', 0.25, 8760); fields.next_sync = Date.now() + Number(fields.interval_hours) * 3600000; }
            if (data.url !== undefined) { if (data.authorized !== true) throw new AppError(400, 'Authorization confirmation is required'); fields.url_encrypted = encrypt(validateSourceUrl(requiredText(data.url, 'URL')).toString()); fields.content_encrypted = null; fields.next_sync = Date.now(); fields.health = 'unknown'; fields.error = null; }
            let jobId: string | undefined;
            await db.transaction(async tx => {
              if (Object.keys(fields).length) await tx.run(`UPDATE playlists SET ${Object.keys(fields).map(key => `${key}=?`).join(',')} WHERE id=?`, [...Object.values(fields), playlistId]);
              if (data.url !== undefined && (fields.enabled ?? row.enabled)) {
                const running = await tx.get("SELECT id FROM jobs WHERE type='sync' AND status='running' AND (dedupe_key=? OR dedupe_key LIKE ?) LIMIT 1", [`sync:${playlistId}`, `sync:${playlistId}:%`]);
                // A changed link must get a follow-up even while its old request
                // is finishing; explicit edits also advance an existing delayed retry.
                const dedupeKey = running ? `sync:${playlistId}:${hash(String(fields.url_encrypted)).slice(0, 16)}` : `sync:${playlistId}`;
                jobId = await enqueue(tx, 'sync', { playlistId }, { dedupeKey, expedite: true });
                await tx.run("UPDATE jobs SET attempts=0,error=NULL WHERE id=? AND status='queued'", [jobId]);
              }
            });
            await audit(db, actor.id, 'playlist.update', playlistId, { fields: Object.keys(fields).filter(k => !k.endsWith('encrypted')) }); return response({ playlist: playlistRecord((await db.get('SELECT * FROM playlists WHERE id=?', [playlistId]))!), ...(jobId ? { queued: true, jobId } : {}) });
          }
          if (method === 'DELETE') { await db.run('DELETE FROM playlists WHERE id=?', [playlistId]); await audit(db, actor.id, 'playlist.delete', playlistId); return response({ ok: true }); }
        }
      }
      if (path[1] === 'titles') {
        if (path[2] === 'merge' && method === 'POST') { requireUser(user, ['admin']); const data = await body(request); const fromId = text(data.fromId, 'From title', 64); const toId = text(data.toId, 'Target title', 64); await mergeTitles(db, fromId, toId); await audit(db, actor.id, 'title.merge', toId, { fromId }); return response({ title: await titleDetails(db, toId, true) }); }
        if (!path[2] && method === 'POST') { const data = await body(request); const titleId = await createTitle(db, { name: text(data.name, 'Name', 200), type: data.type && ['movie', 'series', 'live'].includes(data.type) ? data.type : 'movie', year: data.year ? number(data.year, 'Year', 1888, 2100) : null, published: false }); await updateTitle(db, titleId, data); await audit(db, actor.id, 'title.create', titleId); return response({ title: await titleDetails(db, titleId, true) }, 201); }
        if (path[2] && method === 'PATCH') { await updateTitle(db, path[2], await body(request)); await audit(db, actor.id, 'title.update', path[2]); return response({ title: await titleDetails(db, path[2], true) }); }
        if (path[2] && method === 'DELETE') { await db.run('DELETE FROM titles WHERE id=?', [path[2]]); await audit(db, actor.id, 'title.delete', path[2]); return response({ ok: true }); }
      }
      if (path[1] === 'episodes' && !path[2] && method === 'POST') {
        const data = await body(request); const titleId = text(data.titleId, 'Title id', 64); const title = await db.get('SELECT type FROM titles WHERE id=?', [titleId]); if (title?.type !== 'series') throw new AppError(400, 'Episodes require a series title');
        const season = number(data.season, 'Season', 0, 99); const episodeNumber = number(data.number, 'Episode number', 1, 999); if (!Number.isInteger(season) || !Number.isInteger(episodeNumber)) throw new AppError(400, 'Episode numbers must be integers');
        if (await db.get('SELECT id FROM episodes WHERE title_id=? AND season=? AND number=?', [titleId, season, episodeNumber])) throw new AppError(409, 'This episode already exists');
        const episodeId = id(); const name = text(data.name, 'Episode name', 200); const duration = data.duration === undefined || data.duration === null ? null : number(data.duration, 'Duration', 1, 86400); const markers = markerFields(data, {});
        await db.transaction(async tx => { let seasonRow = await tx.get('SELECT id FROM seasons WHERE title_id=? AND number=?', [titleId, season]); if (!seasonRow) { const seasonId = id(); await tx.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,?)', [seasonId, titleId, season]); seasonRow = { id: seasonId }; } await tx.run('INSERT INTO episodes(id,title_id,season_id,season,number,name,duration,intro_start,intro_end,recap_start,recap_end) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [episodeId, titleId, seasonRow.id, season, episodeNumber, name, duration, markers.intro_start ?? null, markers.intro_end ?? null, markers.recap_start ?? null, markers.recap_end ?? null]); });
        await audit(db, actor.id, 'episode.create', episodeId); return response({ title: await titleDetails(db, titleId, true), episodeId }, 201);
      }
      if (path[1] === 'episodes' && path[2] && method === 'PATCH') { const data = await body(request); const existing = await db.get('SELECT * FROM episodes WHERE id=?', [path[2]]); if (!existing) throw new AppError(404, 'Episode not found'); markerFields(data, existing); for (const key of ['duration', 'introStart', 'introEnd', 'recapStart', 'recapEnd']) if (data[key] !== undefined && data[key] !== null) number(data[key], key, 0, 86400); if (data.name !== undefined) text(data.name, 'Episode name', 200); await updateEpisode(db, path[2], data); await audit(db, actor.id, 'episode.update', path[2]); return response({ title: await titleDetails(db, existing.title_id, true) }); }
      if (path[1] === 'episodes' && path[2] && method === 'DELETE') { const existing = await db.get('SELECT title_id FROM episodes WHERE id=?', [path[2]]); if (!existing) throw new AppError(404, 'Episode not found'); await db.run('DELETE FROM episodes WHERE id=?', [path[2]]); await audit(db, actor.id, 'episode.delete', path[2]); return response({ title: await titleDetails(db, existing.title_id, true) }); }
      if (path[1] === 'sources') {
        const sourceId = path[2];
        if (!sourceId && method === 'POST') {
          const data = await body(request); const titleId = text(data.titleId, 'Title id', 64); const title = await db.get('SELECT type FROM titles WHERE id=?', [titleId]); if (!title) throw new AppError(404, 'Title not found'); const episodeId = data.episodeId || null;
          if (title.type === 'series' && !episodeId || title.type !== 'series' && episodeId) throw new AppError(400, 'Series sources require an episode'); if (episodeId && !(await db.get('SELECT id FROM episodes WHERE id=? AND title_id=?', [episodeId, titleId]))) throw new AppError(400, 'Episode does not belong to title');
          const sourceUrl = validateSourceUrl(requiredText(data.url, 'Source URL')).toString(); const name = text(data.name, 'Server name', 120); const sourceId = id();
          const language = data.language === undefined || data.language === null ? null : text(data.language, 'Language', 20);
          const priority = number(data.priority ?? 0, 'Priority', -1000, 1000); const urlHash = hash(sourceUrl);
          await db.transaction(async tx => {
            const blocked = await existingPlaybackBlock(tx, urlHash);
            await tx.run('INSERT INTO sources(id,title_id,episode_id,entry_key,name,url_encrypted,url_hash,format,priority,language,created_at,health,playback_blocked,playback_blocked_at,error,failures) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [sourceId, titleId, episodeId, id(), name, encrypt(sourceUrl), urlHash, inferFormat(sourceUrl), priority, language, Date.now(), blocked ? 'unavailable' : 'unknown', blocked ? 1 : 0, blocked ? Number(blocked.playback_blocked_at || Date.now()) : null, blocked ? blocked.error : null, blocked ? Number(blocked.failures || 1) : 0]);
          });
          const jobId = await enqueue(db, 'health', { sourceId }, { dedupeKey: `health:${sourceId}` }); await audit(db, actor.id, 'source.create', sourceId); return response({ source: sourceRecord((await db.get('SELECT * FROM sources WHERE id=?', [sourceId]))!), jobId }, 201);
        }
        if (sourceId) {
          const source = await db.get('SELECT * FROM sources WHERE id=?', [sourceId]); if (!source) throw new AppError(404, 'Source not found');
          if (path[3] === 'history' && method === 'GET') return response({ history: (await db.all('SELECT health,error,latency_ms,created_at FROM source_health_history WHERE source_id=? ORDER BY created_at DESC LIMIT 100', [sourceId])).map(row => ({ health: row.health, error: row.error, latencyMs: Number(row.latency_ms), createdAt: Number(row.created_at) })) });
          if (path[3] === 'check' && method === 'POST') { const jobId = await enqueue(db, 'health', { sourceId }, { dedupeKey: `health:${sourceId}` }); await audit(db, actor.id, 'source.check', sourceId); return response({ queued: true, jobId }); }
          if (path[3] === 'split' && method === 'POST') { requireUser(user, ['admin']); const data = await body(request); const titleId = await splitSource(db, sourceId, text(data.name, 'New title name', 200), data.year ? number(data.year, 'Year', 1888, 2100) : null); await audit(db, actor.id, 'source.split', sourceId, { titleId }); return response({ title: await titleDetails(db, titleId, true) }); }
          if (method === 'PATCH') {
            const data = await body(request); const fields: Record<string, unknown> = {};
            if (data.name !== undefined) fields.name = text(data.name, 'Server name', 120); if (data.enabled !== undefined) fields.enabled = boolean(data.enabled, 'Enabled') ? 1 : 0; if (data.priority !== undefined) fields.priority = number(data.priority, 'Priority', -1000, 1000);
            if (data.language !== undefined) fields.language = data.language === null ? null : text(data.language, 'Language', 20);
            const replacementUrl = data.url === undefined ? null : validateSourceUrl(requiredText(data.url, 'Source URL')).toString(); let urlChanged = false;
            if (data.titleId !== undefined || data.episodeId !== undefined) { requireUser(user, ['admin']); const targetId = text(data.titleId || source.title_id, 'Target title', 64); const target = await db.get('SELECT type FROM titles WHERE id=?', [targetId]); if (!target) throw new AppError(404, 'Target title not found'); const episodeId = data.episodeId ?? null; if (target.type === 'series' && !episodeId || target.type !== 'series' && episodeId) throw new AppError(400, 'Target requires a valid episode'); if (episodeId && !(await db.get('SELECT id FROM episodes WHERE id=? AND title_id=?', [episodeId, targetId]))) throw new AppError(400, 'Episode does not belong to target'); fields.title_id = targetId; fields.episode_id = episodeId; }
            await db.transaction(async tx => {
              if (replacementUrl !== null) {
                const replacementHash = hash(replacementUrl); const blocked = await existingPlaybackBlock(tx, replacementHash);
                const current = await tx.get('SELECT url_hash FROM sources WHERE id=?' + (tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), [sourceId]); if (!current) throw new AppError(404, 'Source not found');
                if (current.url_hash !== replacementHash) { urlChanged = true; Object.assign(fields, { url_encrypted: encrypt(replacementUrl), url_hash: replacementHash, format: inferFormat(replacementUrl), health: blocked ? 'unavailable' : 'unknown', quality: null, last_success: null, last_checked: null, failures: blocked ? Number(blocked.failures || 1) : 0, successes: 0, error: blocked ? blocked.error : null, playback_blocked: blocked ? 1 : 0, playback_blocked_at: blocked ? Number(blocked.playback_blocked_at || Date.now()) : null }); }
              }
              if (Object.keys(fields).length) await tx.run(`UPDATE sources SET ${Object.keys(fields).map(key => `${key}=?`).join(',')} WHERE id=?`, [...Object.values(fields), sourceId]);
            });
            if (urlChanged || data.enabled === true) await enqueue(db, 'health', { sourceId }, { dedupeKey: `health:${sourceId}` }); await audit(db, actor.id, 'source.update', sourceId, { fields: Object.keys(data).filter(key => key !== 'url') }); return response({ source: sourceRecord((await db.get('SELECT * FROM sources WHERE id=?', [sourceId]))!) });
          }
          if (method === 'DELETE') { await db.run('DELETE FROM sources WHERE id=?', [sourceId]); await audit(db, actor.id, 'source.delete', sourceId); return response({ ok: true }); }
        }
      }
      if (path[1] === 'reviews' && path[2] && method === 'POST') { const data = await body(request); const review = await db.get("SELECT * FROM review_queue WHERE id=? AND status='pending'", [path[2]]); if (!review) throw new AppError(404, 'Review not found'); if (data.action === 'merge') { requireUser(user, ['admin']); const targetId = text(data.targetId || review.candidate_id, 'Target title', 64); await mergeTitles(db, review.title_id, targetId); } else if (data.action === 'reject') { await db.run('UPDATE titles SET published=1 WHERE id=?', [review.title_id]); } else if (data.action !== 'ignore') throw new AppError(400, 'Action must be merge, reject or ignore'); await db.run("UPDATE review_queue SET status='resolved' WHERE id=?", [path[2]]); await audit(db, actor.id, `review.${data.action}`, path[2]); return response({ ok: true }); }
    }
    throw new AppError(404, 'API endpoint not found');
  } catch (error) { if (error instanceof MediaRuntimeError) return response({ error: error.message, classification: error.classification, code: error.code }, error.classification === 'source' ? 422 : 503, error.classification === 'capacity' ? { 'Retry-After': '5' } : {}); if (error instanceof AppError) return response({ error: error.message }, error.status); if (isSqliteBusy(error)) return response({ error: 'The database is busy. Please try again shortly.' }, 503, { 'Retry-After': '1' }); console.error(JSON.stringify({ level: 'error', event: 'api.failure', error: sanitizeError(error), time: Date.now() })); return response({ error: 'The request could not be completed. Please try again.' }, 500); }
}
