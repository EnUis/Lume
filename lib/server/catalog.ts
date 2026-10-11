import type { DB, Row } from './db';
import type { Episode, Source, Title } from '../types';
import { decrypt } from './security';
import { cleanDisplayTitle, normalizeTitle, similarity } from './m3u';

export const playableSQL = `(s.enabled=1 AND s.removed=0 AND s.health='healthy' AND s.playback_blocked=0 AND (s.playlist_id IS NULL OR p.enabled=1))`;
// Build the verified title set once. A correlated availability check makes an
// empty catalog scan every title and source repeatedly during a large import.
const verifiedTitlesSQL = `SELECT s.title_id FROM sources s JOIN titles availability_title ON availability_title.id=s.title_id LEFT JOIN playlists p ON p.id=s.playlist_id WHERE ((availability_title.type='series' AND s.episode_id IS NOT NULL) OR (availability_title.type<>'series' AND s.episode_id IS NULL)) AND ${playableSQL}`;
export const availableTitleSQL = `t.id IN (${verifiedTitlesSQL})`;
// DISTINCT keeps PostgreSQL from pushing a LIMIT-driven browse into tens of
// thousands of per-title source lookups. Point reads retain their selective plan.
export const catalogAvailabilitySQL = `t.id IN (${verifiedTitlesSQL.replace('SELECT s.title_id', 'SELECT DISTINCT s.title_id')})`;
export const publicContentSQL = `t.type IN ('movie','series')`;
export const publicTitleSQL = `${publicContentSQL} AND t.published=1 AND ${availableTitleSQL}`;
export const publicCatalogSQL = `${publicContentSQL} AND t.published=1 AND ${catalogAvailabilitySQL}`;
// Explicit channel browsing and saved IDs allow live content. Default catalog
// and discovery feeds retain their movie/series scope through publicTitleSQL.
export const supportedContentSQL = `t.type IN ('movie','series','live')`;
export const accessibleTitleSQL = `${supportedContentSQL} AND t.published=1 AND ${availableTitleSQL}`;
const json = <T>(value: string, fallback: T): T => { try { return JSON.parse(value); } catch { return fallback; } };
export function sourceRecord(row: Row, includeUrl = false): Source {
  return { id: row.id, titleId: row.title_id, episodeId: row.episode_id, name: row.name, format: row.format, health: row.health, enabled: !!row.enabled && !row.removed && row.playlist_enabled !== 0, priority: Number(row.priority), quality: row.quality, lastChecked: row.last_checked === null ? null : Number(row.last_checked), lastSuccess: row.last_success === null ? null : Number(row.last_success), lastFailure: row.last_failure == null ? null : Number(row.last_failure), error: row.error, language: row.language ?? null, playbackBlocked: !!row.playback_blocked, ...(includeUrl ? { url: decrypt(row.url_encrypted) } : {}) };
}
export function titleRecord(row: Row): Title {
  return { id: row.id, name: cleanDisplayTitle(row.name, row.type), type: row.type, year: row.year === null ? null : Number(row.year), synopsis: row.synopsis, poster: row.poster, backdrop: row.backdrop, genres: json(row.genres, []), duration: row.duration === null ? null : Number(row.duration), ageRating: row.age_rating, cast: json(row.cast_members, []), director: row.director, featured: !!row.featured, demo: !!row.demo, published: !!row.published, createdAt: Number(row.created_at), attribution: row.attribution, ...(row.trailer ? { trailer: row.trailer } : {}), ...(row.intro_start === null ? {} : { introStart: Number(row.intro_start), introEnd: Number(row.intro_end) }), ...(row.recap_start === null ? {} : { recapStart: Number(row.recap_start), recapEnd: Number(row.recap_end) }) };
}
export async function resolveTitleId(db: DB, titleId: string) {
  let current = titleId; const seen = new Set<string>();
  for (let depth = 0; depth < 16 && !seen.has(current); depth++) {
    seen.add(current); const redirect = await db.get('SELECT title_id FROM title_redirects WHERE alias_id=?', [current]);
    if (!redirect) return current; current = redirect.title_id;
  }
  return current;
}
export async function resolveEpisodeId(db: DB, episodeId: string) {
  let current = episodeId; const seen = new Set<string>();
  for (let depth = 0; depth < 16 && !seen.has(current); depth++) {
    seen.add(current); const redirect = await db.get('SELECT episode_id FROM episode_redirects WHERE alias_id=?', [current]);
    if (!redirect) return current; current = redirect.episode_id;
  }
  return current;
}
export async function titleDetails(db: DB, titleId: string, admin = false): Promise<Title | null> {
  titleId = await resolveTitleId(db, titleId);
  const row = await db.get(`SELECT t.* FROM titles t WHERE t.id=? ${admin ? '' : `AND ${accessibleTitleSQL}`}`, [titleId]); if (!row) return null;
  const title = titleRecord(row);
  title.alternateIds = (await db.all('SELECT alias_id FROM title_redirects WHERE title_id=?', [titleId])).map(alias => alias.alias_id);
  const sources = await db.all('SELECT s.*,p.enabled AS playlist_enabled FROM sources s LEFT JOIN playlists p ON p.id=s.playlist_id WHERE s.title_id=? AND s.removed=0 ORDER BY s.priority DESC,s.name', [titleId]);
  title.sources = (admin ? sources : sources.filter(source => !source.episode_id)).map(source => sourceRecord(source));
  if (title.type === 'series') {
    const episodes = await db.all('SELECT * FROM episodes WHERE title_id=? ORDER BY season,number', [titleId]);
    const redirects = await db.all('SELECT r.alias_id,r.episode_id FROM episode_redirects r JOIN episodes e ON e.id=r.episode_id WHERE e.title_id=?', [titleId]);
    title.episodes = episodes.map(episode => {
      const episodeSources = sources.filter(source => source.episode_id === episode.id);
      return { id: episode.id, alternateIds: redirects.filter(alias => alias.episode_id === episode.id).map(alias => alias.alias_id), titleId, season: Number(episode.season), number: Number(episode.number), name: episode.name, duration: episode.duration === null ? null : Number(episode.duration), available: episodeSources.some(s => s.enabled && !s.removed && !s.playback_blocked && s.playlist_enabled !== 0 && s.health === 'healthy'), sources: episodeSources.map(s => sourceRecord(s)), ...(episode.intro_start === null ? {} : { introStart: Number(episode.intro_start), introEnd: Number(episode.intro_end) }), ...(episode.recap_start === null ? {} : { recapStart: Number(episode.recap_start), recapEnd: Number(episode.recap_end) }) } as Episode;
    });
  }
  return title;
}
export async function catalog(db: DB, params: URLSearchParams, admin = false) {
  const type = params.get('type'); const explicitType = type && ['movie', 'series', 'live'].includes(type) ? type : null;
  const publicScope = explicitType === 'live' ? `${supportedContentSQL} AND t.published=1 AND ${catalogAvailabilitySQL}` : publicCatalogSQL;
  const conditions = admin ? ['1=1'] : [publicScope]; const values: unknown[] = [];
  const availability = params.get('availability');
  if (admin && availability === 'available') conditions.push(`t.published=1 AND ${catalogAvailabilitySQL}`);
  if (admin && availability === 'hidden') conditions.push(`(t.published=0 OR NOT ${catalogAvailabilitySQL})`);
  if (explicitType) { conditions.push('t.type=?'); values.push(explicitType); }
  const year = params.get('year'); if (year && /^\d{4}$/.test(year)) { conditions.push('t.year=?'); values.push(Number(year)); }
  const genre = params.get('genre'); if (genre) { conditions.push('LOWER(t.genres) LIKE ?'); values.push(`%${genre.toLowerCase().replace(/[%_\\]/g, '')}%`); }
  const query = (params.get('q') || '').trim().slice(0, 160); const normalized = normalizeTitle(query);
  // Direct matches search the complete database. Fuzzy scoring uses a bounded
  // candidate window so a typo cannot force an unbounded edit-distance scan.
  let rows: Row[]; let total: number;
  if (query) {
    const like = `%${normalized.replace(/[%_\\]/g, '')}%`;
    const direct = await db.all(`SELECT t.* FROM titles t WHERE ${conditions.join(' AND ')} AND (t.normalized LIKE ? OR LOWER(t.cast_members) LIKE ? OR LOWER(t.genres) LIKE ? OR LOWER(t.director) LIKE ? OR EXISTS(SELECT 1 FROM title_aliases a WHERE a.title_id=t.id AND a.normalized LIKE ?)) ORDER BY t.featured DESC,t.created_at DESC`, [...values, like, like, like, like, like]);
    const fuzzy = normalized.length < 4 ? [] : await db.all(`SELECT t.* FROM titles t WHERE ${conditions.join(' AND ')} AND (t.normalized LIKE ? OR SUBSTR(t.normalized,2,2)=?) AND LENGTH(t.normalized) BETWEEN ? AND ? ORDER BY t.created_at DESC LIMIT 1000`, [...values, `${normalized.slice(0, 2)}%`, normalized.slice(1, 3), Math.max(1, normalized.length - 8), normalized.length + 8]);
    const all = [...new Map([...direct, ...fuzzy].map(row => [row.id, row])).values()];
    const aliasesByTitle = new Map<string, string[]>();
    for (let start = 0; start < all.length; start += 300) {
      const ids = all.slice(start, start + 300).map(row => row.id);
      const aliases = await db.all(`SELECT title_id,normalized FROM title_aliases WHERE title_id IN (${ids.map(() => '?').join(',')})`, ids);
      for (const alias of aliases) { const names = aliasesByTitle.get(alias.title_id) || []; names.push(alias.normalized); aliasesByTitle.set(alias.title_id, names); }
    }
    rows = all.map(row => {
      const searchable = normalizeTitle(`${row.name} ${row.cast_members} ${row.genres} ${row.director} ${(aliasesByTitle.get(row.id) || []).join(' ')}`);
      const score = row.normalized === normalized ? 2 : searchable.includes(normalized) ? 1.5 : similarity(row.normalized, normalized);
      return { ...row, searchScore: score };
    }).filter(row => row.searchScore >= (normalized.length < 4 ? 1.5 : 0.72)).sort((a, b) => b.searchScore - a.searchScore);
    total = rows.length;
  } else {
    total = Number((await db.get(`SELECT COUNT(*) AS count FROM titles t WHERE ${conditions.join(' AND ')}`, values))?.count || 0);
    rows = [];
  }
  const page = Math.max(1, Math.min(Number(params.get('page') || 1) || 1, 100000)); const limit = Math.max(1, Math.min(Number(params.get('limit') || 60) || 60, admin ? 100 : 60));
  if (query) rows = rows.slice((page - 1) * limit, page * limit);
  else rows = await db.all(`SELECT t.* FROM titles t WHERE ${conditions.join(' AND ')} ORDER BY t.featured DESC,t.created_at DESC LIMIT ? OFFSET ?`, [...values, limit, (page - 1) * limit]);
  const titles = admin ? await Promise.all(rows.map(row => titleDetails(db, row.id, true))) : rows.map(titleRecord);
  const genreRows = await db.all(`SELECT DISTINCT t.genres FROM titles t WHERE ${admin ? '1=1' : publicScope}${explicitType ? ' AND t.type=?' : ''} LIMIT 5000`, explicitType ? [explicitType] : []);
  const genres = [...new Set(genreRows.flatMap(row => json<string[]>(row.genres, [])))].sort();
  return { titles: titles.filter(Boolean), total, genres };
}
export async function playbackSources(db: DB, titleId: string, episodeId?: string | null) {
  titleId = await resolveTitleId(db, titleId);
  if (episodeId) episodeId = await resolveEpisodeId(db, episodeId);
  const title = await db.get('SELECT id,type,published FROM titles WHERE id=?', [titleId]);
  if (!title?.published || !['movie', 'series', 'live'].includes(title.type)) return [];
  if (title.type === 'series' && !episodeId || title.type !== 'series' && episodeId) return [];
  if (episodeId && !(await db.get('SELECT id FROM episodes WHERE id=? AND title_id=?', [episodeId, titleId]))) return [];
  const rows = await db.all(`SELECT s.*,p.enabled AS playlist_enabled FROM sources s LEFT JOIN playlists p ON p.id=s.playlist_id WHERE s.title_id=? AND ${episodeId ? 's.episode_id=?' : 's.episode_id IS NULL'} AND ${playableSQL} ORDER BY CASE WHEN s.health='healthy' THEN 0 ELSE 1 END,s.priority DESC,s.failures ASC,s.last_success DESC`, episodeId ? [titleId, episodeId] : [titleId]);
  return rows.map(row => sourceRecord(row, true));
}
