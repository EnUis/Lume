import { safeFetch } from './outbound';
import type { DB, Row } from './db';
import { hash, id } from './security';
import { metadataClient, MetadataDeferred, type MetadataClientOptions } from './metadata-client';
import { findMetadata, metadataConfiguration, explicitAdultMetadata, englishDisplayTitle, type MetadataConfiguration, type MetadataIdentity } from './metadata-providers';
import { availableTitleSQL } from './catalog';
import { enqueue } from './jobs';
import { cleanDisplayTitle, cleanMediaTitle, normalizeTitle } from './m3u';
import { workerError } from './worker-log';
import { normalizeLanguage } from '../languages';
export async function fetchMetadata(url: string, token: string): Promise<Record<string, unknown>> {
  const response = await safeFetch(url, { maxBytes: 200000, timeoutMs: 10000, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (response.status !== 200 || response.truncated) throw new Error(`Licensed metadata provider returned HTTP ${response.status}`);
  let result: unknown; try { result = JSON.parse(response.body.toString('utf8')); } catch { throw new Error('Metadata provider returned invalid JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Metadata provider response must be an object'); return result as Record<string, unknown>;
}

const WEEK = 7 * 86400000;
export const METADATA_ENRICHMENT_VERSION = 3;
export interface EnrichmentOptions extends MetadataClientOptions { configuration?: MetadataConfiguration; force?: boolean }
function identityHash(title: Row, config: MetadataConfiguration) { return hash(JSON.stringify([METADATA_ENRICHMENT_VERSION, title.name, title.type, title.year ?? null, config.licensedUrl || '', config.licensedKey || '', config.tmdbToken || '', config.tmdbKey || '', config.language])); }
const missing = (value: unknown) => typeof value !== 'string' || !value.trim();
async function storeLookup(db: DB, titleId: string, identity: string, status: string, now: number, retryAt: number, details: { provider?: string; providerId?: string; result?: unknown; error?: string; saved?: Row } = {}) {
  // The title may have been deleted/merged while its provider request was running.
  // A scheduler snapshot can contain a revision newer than its captured clock.
  // A fresh queue record must not then appear stale and bypass its own cooldown.
  const checkedAt = Math.max(now, Number(details.saved?.updated_at) || 0);
  await db.run(`INSERT INTO metadata_lookups(title_id,identity_hash,status,provider,provider_id,checked_at,retry_after,result,error) SELECT ?,?,?,?,?,?,?,?,? FROM titles saved WHERE saved.id=? ${details.saved ? 'AND saved.name=? AND saved.type=? AND COALESCE(saved.year,0)=?' : ''} ON CONFLICT(title_id) DO UPDATE SET identity_hash=excluded.identity_hash,status=excluded.status,provider=excluded.provider,provider_id=excluded.provider_id,checked_at=excluded.checked_at,retry_after=excluded.retry_after,result=excluded.result,error=excluded.error`, [titleId, identity, status, details.provider || null, details.providerId || null, checkedAt, retryAt, JSON.stringify({ enrichmentVersion: METADATA_ENRICHMENT_VERSION, ...(details.result && typeof details.result === 'object' ? details.result : {}) }), details.error || null, titleId, ...(details.saved ? [details.saved.name, details.saved.type, Number(details.saved.year) || 0] : [])]);
}
export async function enrichTitleMetadata(db: DB, titleId: string, options: EnrichmentOptions = {}): Promise<Record<string, unknown>> {
  const config = options.configuration || metadataConfiguration(); if (!config.enabled) return { skipped: true, reason: 'Automatic metadata is disabled' };
  const title = await db.get('SELECT * FROM titles WHERE id=?', [titleId]);
  if (!title || !['movie', 'series', 'live'].includes(title.type) || !title.published) return { skipped: true, reason: 'Title is missing or awaiting publication review' };
  if (await db.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [titleId])) return { skipped: true, reason: 'Administrator metadata is preserved' };
  const now = options.now || Date.now; const fingerprint = identityHash(title, config); const previous = await db.get('SELECT * FROM metadata_lookups WHERE title_id=?', [titleId]);
  if (!missing(title.poster) && !missing(title.backdrop) && !missing(title.synopsis) && previous?.identity_hash === fingerprint && previous.status === 'matched') return { skipped: true, reason: 'Artwork, description and display title have already been checked' };
  if (!options.force && previous?.identity_hash === fingerprint && ['matched', 'no-match', 'cooldown', 'blocked'].includes(previous.status) && Number(previous.retry_after) > now()) return { skipped: true, reason: 'Metadata lookup is cooling down', nextLookupAt: Number(previous.retry_after) };
  const originalNames = await db.all('SELECT original_name,language FROM sources WHERE title_id=? AND (original_name IS NOT NULL OR language IS NOT NULL) LIMIT 100', [titleId]);
  if (explicitAdultMetadata(title.name) || /"(?:Adult|Pornography|XXX)"/i.test(title.genres || '') || originalNames.some(source => typeof source.original_name === 'string' && explicitAdultMetadata(source.original_name))) {
    await storeLookup(db, titleId, fingerprint, 'blocked', now(), now() + WEEK, { error: 'Explicit adult provider labels are excluded from public metadata lookup', saved: title });
    return { skipped: true, reason: 'Explicit adult provider labels are excluded' };
  }
  const aliases = await db.all('SELECT name FROM title_aliases WHERE title_id=?', [titleId]); const identifiers = await db.all('SELECT provider,external_id FROM metadata_identifiers WHERE title_id=?', [titleId]);
  const clean = cleanMediaTitle(title.name); const displayName = cleanDisplayTitle(title.name, title.type);
  const languages = [...new Set(originalNames.map(source => normalizeLanguage(source.language)).filter((language): language is string => !!language && /^[a-z]{2}$/.test(language)))].slice(0, 3);
  const identity: MetadataIdentity = { name: displayName, type: title.type, year: title.type === 'live' ? null : title.year === null ? clean.year : Number(title.year), aliases: aliases.map(alias => cleanDisplayTitle(alias.name, title.type)), identifiers: Object.fromEntries(identifiers.map(identifier => [identifier.provider, identifier.external_id])), languages, needs: { poster: missing(title.poster), backdrop: missing(title.backdrop), synopsis: missing(title.synopsis) } };
  try {
    const match = await findMetadata(identity, metadataClient(db, { ...options, userAgent: config.userAgent || options.userAgent }), config);
    if (!match || !match.synopsis && !match.poster && !match.backdrop && !match.englishTitle) {
      await storeLookup(db, titleId, fingerprint, 'no-match', now(), now() + WEEK, { error: 'No unique title, content type and release-year match with useful metadata', saved: title });
      return { matched: false, reason: 'No unambiguous metadata match' };
    }
    return await db.transaction(async tx => {
      const current = await tx.get(`SELECT * FROM titles WHERE id=?${tx.dialect === 'postgres' ? ' FOR UPDATE' : ''}`, [titleId]);
      if (!current || !current.published || identityHash(current, config) !== fingerprint || await tx.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [titleId])) return { skipped: true, reason: 'Title identity or administrator metadata changed during lookup' };
      const existingIdentifier = await tx.get('SELECT title_id FROM metadata_identifiers WHERE provider=? AND external_id=?', [match.provider, match.providerId]);
      const differentIdentifier = await tx.get('SELECT external_id FROM metadata_identifiers WHERE title_id=? AND provider=? AND external_id<>?', [titleId, match.provider, match.providerId]);
      if (existingIdentifier && existingIdentifier.title_id !== titleId || differentIdentifier) {
        await storeLookup(tx, titleId, fingerprint, 'no-match', now(), now() + WEEK, { provider: match.provider, providerId: match.providerId, error: 'Provider identity conflicts with an existing catalog identity' });
        return { matched: false, reason: 'Provider identity requires administrator confirmation' };
      }
      const updates: Record<string, string> = {};
      for (const field of ['synopsis', 'poster', 'backdrop', 'director'] as const) if (missing(current[field]) && match[field]) updates[field] = match[field]!;
      for (const [field, values] of [['genres', match.genres], ['cast_members', match.cast]] as const) if ((missing(current[field]) || current[field].trim() === '[]') && values?.length) updates[field] = JSON.stringify(values);
      const englishTitle = englishDisplayTitle(match.englishTitle) ? cleanDisplayTitle(match.englishTitle!, title.type) : '';
      if (englishTitle && englishTitle !== current.name) { updates.name = englishTitle; updates.normalized = normalizeTitle(englishTitle); }
      const time = now(); const fields = Object.keys(updates);
      {
        // Reserve a provider identity before filling anything. PostgreSQL's unique
        // constraint also resolves a concurrent match claimed by another title.
        const inserted = await tx.get('INSERT INTO metadata_identifiers(id,title_id,provider,external_id) VALUES(?,?,?,?) ON CONFLICT(provider,external_id) DO NOTHING RETURNING title_id', [id(), titleId, match.provider, match.providerId]);
        const binding = inserted || await tx.get('SELECT title_id FROM metadata_identifiers WHERE provider=? AND external_id=?', [match.provider, match.providerId]);
        if (!binding || binding.title_id !== titleId) {
          await storeLookup(tx, titleId, fingerprint, 'no-match', time, time + WEEK, { provider: match.provider, providerId: match.providerId, error: 'Provider identity was claimed by another catalog title' });
          return { matched: false, reason: 'Provider identity requires administrator confirmation' };
        }
        // Preserve both the imported spelling and confirmed localized names for search.
        const displayAliases = [...new Set([current.name, displayName, ...(match.aliases || [])])].filter(name => typeof name === 'string' && name.trim() && name.length <= 200).slice(0, 32);
        for (const name of displayAliases) {
          const normalized = normalizeTitle(name); if (!normalized || name === (updates.name || current.name)) continue;
          await tx.run('INSERT INTO title_aliases(id,title_id,name,normalized) VALUES(?,?,?,?) ON CONFLICT(title_id,normalized) DO NOTHING', [id(), titleId, name, normalized]);
        }
        if (fields.length) {
          const attribution = current.attribution ? current.attribution.includes(match.attribution) ? current.attribution : `${current.attribution}; ${match.attribution}` : match.attribution;
          await tx.run(`UPDATE titles SET ${fields.map(field => `${field}=?`).join(',')},attribution=?,updated_at=? WHERE id=?`, [...Object.values(updates), attribution.slice(0, 8000), time, titleId]);
        }
      }
      const updatedTitle = { ...current, ...updates, updated_at: fields.length ? time : current.updated_at };
      await storeLookup(tx, titleId, identityHash(updatedTitle, config), 'matched', time, time + WEEK, { provider: match.provider, providerId: match.providerId, result: { fields, enrichmentVersion: METADATA_ENRICHMENT_VERSION, displayTitleChecked: true, englishTitle: englishTitle || null }, saved: updatedTitle });
      return { matched: true, provider: match.provider, updated: fields.length, fields };
    });
  } catch (error) {
    const time = now(); const deferred = error instanceof MetadataDeferred;
    await storeLookup(db, titleId, fingerprint, deferred ? 'cooldown' : 'failed', time, deferred ? error.retryAt : time + 300000, { error: workerError(error), saved: title });
    if (deferred) return { deferred: true, nextLookupAt: error.retryAt };
    throw new Error(workerError(error), { cause: error });
  }
}

export interface MetadataScheduleOptions { limit?: number; backgroundLimit?: number; now?: number; force?: boolean; titleIds?: string[] }
export async function scheduleMetadataEnrichment(db: DB, options: MetadataScheduleOptions = {}) {
  const config = metadataConfiguration(); if (!config.enabled) return { queued: 0, candidates: 0 };
  const time = options.now ?? Date.now(); const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 20))); const background = Math.max(0, Math.min(20, Math.floor(options.backgroundLimit ?? 5)));
  const ids = options.titleIds?.slice(0, 100); const values: unknown[] = options.force ? [] : [time];
  if (ids?.length) values.push(...ids);
  const eligible = `t.published=1 AND t.type IN ('movie','series','live') AND (TRIM(t.poster)='' OR TRIM(t.backdrop)='' OR TRIM(t.synopsis)='' OR COALESCE(m.result,'') NOT LIKE '%"displayTitleChecked":true%' OR COALESCE(m.result,'') NOT LIKE '%"enrichmentVersion":${METADATA_ENRICHMENT_VERSION}%' ) AND NOT EXISTS(SELECT 1 FROM title_metadata_locks locks WHERE locks.title_id=t.id) ${options.force ? '' : `AND (m.title_id IS NULL OR m.retry_after<=? OR t.updated_at>m.checked_at OR (m.status IN ('matched','no-match') AND COALESCE(m.result,'') NOT LIKE '%"enrichmentVersion":${METADATA_ENRICHMENT_VERSION}%'))`} ${ids?.length ? `AND t.id IN (${ids.map(() => '?').join(',')})` : ''}`;
  // A visible foreign-script title should not wait behind thousands of new imports.
  const foreignName = db.dialect === 'postgres' ? `t.name ~ '[^ -~]'` : `t.name GLOB '*[^ -~]*'`;
  const namePriority = `CASE WHEN ${foreignName} THEN 0 ELSE 1 END`;
  const visible = await db.all(`SELECT t.* FROM titles t LEFT JOIN metadata_lookups m ON m.title_id=t.id WHERE ${eligible} AND ${availableTitleSQL} ORDER BY t.featured DESC,${namePriority},t.created_at DESC LIMIT ?`, [...values, limit]);
  const remaining = Math.max(0, Math.min(background, limit - visible.length));
  const others = remaining ? await db.all(`SELECT t.* FROM titles t LEFT JOIN metadata_lookups m ON m.title_id=t.id WHERE ${eligible} ${visible.length ? `AND t.id NOT IN (${visible.map(() => '?').join(',')})` : ''} ORDER BY ${namePriority},t.created_at DESC LIMIT ?`, [...values, ...visible.map(title => title.id), remaining]) : [];
  const first = await db.get("SELECT run_after FROM jobs WHERE type='metadata' AND status='queued' AND attempts<max_attempts ORDER BY run_after,created_at LIMIT 1"); const visibleRunAfter = Math.min(time, Number(first?.run_after) || time) - 1;
  let queued = 0;
  for (const title of [...visible, ...others]) {
    if (explicitAdultMetadata(title.name) || /"(?:Adult|Pornography|XXX)"/i.test(title.genres || '')) {
      await storeLookup(db, title.id, identityHash(title, config), 'blocked', time, time + WEEK, { error: 'Explicit adult provider labels are excluded', saved: title }); continue;
    }
    await db.transaction(async tx => {
      const verified = visible.some(candidate => candidate.id === title.id);
      await enqueue(tx, 'metadata', { titleId: title.id, ...(options.force ? { force: true } : {}) }, { dedupeKey: `metadata:${title.id}`, runAfter: verified ? visibleRunAfter : time });
      if (verified) await tx.run("UPDATE jobs SET run_after=? WHERE dedupe_key=? AND type='metadata' AND status='queued' AND status IN ('queued','running') AND attempts=0 AND run_after>?", [visibleRunAfter, `metadata:${title.id}`, visibleRunAfter]);
      await storeLookup(tx, title.id, identityHash(title, config), 'queued', time, time + 900000, { saved: title }); queued++;
    });
  }
  await db.run('DELETE FROM metadata_http_cache WHERE cache_key IN (SELECT cache_key FROM metadata_http_cache WHERE expires_at<? ORDER BY expires_at LIMIT 500)', [time]);
  return { queued, candidates: visible.length + others.length };
}
