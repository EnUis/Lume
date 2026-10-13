import type { DB, Row } from './db';
import { cleanMediaTitle, parseM3U, normalizeTitle, similarity, M3U_IMPORT_VERSION, type PlaylistEntry } from './m3u';
import { safeFetch, type SafeFetcher } from './outbound';
import { decrypt, encrypt, hash, id, sanitizeError } from './security';
import { enqueue } from './jobs';
import { nextHealth, verifyStream } from './health';
import { normalizeLanguage } from '../languages';
import { PlaylistFetchError } from './playlist-errors';
import { genericPlaylistArtwork } from './catalog-artwork';
import { importPlaybackBlocks, insertImportRows, lockImportUrls } from './import-batches';

export async function createTitle(db: DB, data: { name: string; type?: string; year?: number | null; poster?: string; genres?: string[]; published?: boolean }) {
  const titleId = id(); const now = Date.now();
  await db.run('INSERT INTO titles(id,name,normalized,type,year,poster,genres,published,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [titleId, data.name, normalizeTitle(data.name), data.type || 'movie', data.year || null, data.poster || '', JSON.stringify(data.genres || []), data.published === false ? 0 : 1, now, now]);
  return titleId;
}
const CLASSIFICATION_REVIEW = 'Content classification requires administrator review';
const TITLE_COLUMNS = 'id,name,normalized,type,year,published';
export const STARTER_VERIFICATION_VERSION = 1;
const STARTER_PER_BUCKET = 3;
const STARTER_CANDIDATES_PER_BUCKET = 12;
/** Preserve failed-check backoff when an older import is reconciled. */
async function enqueueUncheckedHealth(db: DB, sourceId: string) {
  const now = Date.now();
  await db.run("INSERT INTO jobs(id,type,payload,status,run_after,created_at,dedupe_key) SELECT ?,'health',?,'queued',?,?,? FROM sources s WHERE s.id=? AND s.enabled=1 AND s.removed=0 AND s.health='unknown' AND s.last_checked IS NULL AND s.last_success IS NULL AND s.failures=0 ON CONFLICT DO NOTHING", [id(), JSON.stringify({ sourceId }), now, now, `health:${sourceId}`, sourceId]);
}
/** Exact identities and bounded fuzzy windows; a missing year never scans other titles. */
export class ImportIdentityIndex {
  private exact = new Map<string, Map<string, Map<string, Row>>>();
  private fuzzy = new Map<string, Map<string, Row>>();
  private languages = new Map<string, Set<string>>();
  private aliases = new Map<string, Set<string>>();
  private decorated = new Set<string>();
  readonly rows = new Map<string, Row>();
  comparisons = 0;
  constructor(rows: Row[], sourceLanguages: Row[] = [], aliases: Row[] = []) {
    for (const row of rows) this.add(row); for (const source of sourceLanguages) this.recordLanguage(source.title_id, source.language, source.original_name);
    for (const alias of aliases) { let ids = this.aliases.get(alias.normalized); if (!ids) this.aliases.set(alias.normalized, ids = new Set()); ids.add(alias.title_id); }
  }
  aliasCandidates(entry: PlaylistEntry): Row[] {
    if (entry.type === 'live' || entry.type === 'series' && (entry.season === null || entry.episode === null)) return [];
    const aliasIds = this.aliases.get(entry.normalized); if (!aliasIds?.size) return [];
    const candidates = new Map<string, Row>();
    const compatible = (row: Row | undefined) => row && row.type === entry.type && (entry.year === null || row.year === null || Number(row.year) === entry.year);
    for (const titleId of aliasIds) {
      const row = this.rows.get(titleId);
      if (compatible(row)) candidates.set(titleId, row!);
    }
    // A localized alias and another title's primary name may refer to remakes.
    // Include both so an undated entry cannot silently choose one of them.
    for (const bucket of this.exact.get(this.exactKey(entry))?.values() || []) for (const row of bucket.values()) if (compatible(row)) candidates.set(row.id, row);
    return [...candidates.values()];
  }
  matchesAlias(title: Row, entry: PlaylistEntry) {
    return title.type === entry.type && (entry.year === null || title.year === null || Number(title.year) === entry.year) && !!this.aliases.get(entry.normalized)?.has(title.id);
  }
  recordLanguage(titleId: string, language: string | null, originalName?: unknown) {
    const tags = typeof originalName === 'string' ? cleanMediaTitle(originalName) : null;
    if (tags?.decorated) this.decorated.add(titleId);
    for (const code of [normalizeLanguage(language), tags?.language]) { if (!code) continue; let values = this.languages.get(titleId); if (!values) this.languages.set(titleId, values = new Set()); values.add(code); }
  }
  private exactKey(row: Row) { return `${row.type}\0${row.normalized}`; }
  private fuzzyKey(row: Row, length = String(row.normalized).length) { return `${row.type}\0${row.year}\0${String(row.normalized).slice(0, 3)}\0${length}`; }
  add(row: Row) {
    if (row.type !== 'live' && typeof row.name === 'string') { const cleaned = cleanMediaTitle(row.name); this.recordLanguage(row.id, cleaned.language, row.name); row = { ...row, normalized: normalizeTitle(cleaned.title), year: row.year ?? cleaned.year }; }
    this.rows.set(row.id, row);
    const key = this.exactKey(row); let years = this.exact.get(key);
    if (!years) this.exact.set(key, years = new Map());
    const year = row.year === null ? '' : String(row.year); let bucket = years.get(year);
    if (!bucket) years.set(year, bucket = new Map()); bucket.set(row.id, row);
    if (row.year !== null) { const key = this.fuzzyKey(row); let bucket = this.fuzzy.get(key); if (!bucket) this.fuzzy.set(key, bucket = new Map()); bucket.set(row.id, row); }
  }
  remove(row: Row) {
    this.rows.delete(row.id);
    const years = this.exact.get(this.exactKey(row)); const year = row.year === null ? '' : String(row.year); const bucket = years?.get(year); bucket?.delete(row.id);
    if (!bucket?.size) years?.delete(year); if (!years?.size) this.exact.delete(this.exactKey(row));
    if (row.year !== null) this.fuzzy.get(this.fuzzyKey(row))?.delete(row.id);
  }
  strong(entry: PlaylistEntry): Row | undefined {
    if (entry.year === null && (entry.type !== 'series' || entry.season === null || entry.episode === null)) return;
    return this.exact.get(this.exactKey(entry))?.get(entry.year === null ? '' : String(entry.year))?.values().next().value;
  }
  languageVariant(entry: PlaylistEntry): Row | undefined {
    if (entry.type === 'live' || !(entry.year !== null || entry.decorated || entry.languageExplicit && entry.language && entry.language !== 'mul')) return;
    if (entry.type === 'series' && (entry.season === null || entry.episode === null)) return;
    const years = this.exact.get(this.exactKey(entry)); if (!years || [...years.keys()].filter(Boolean).length > 1 || entry.year !== null && [...years.keys()].some(year => year && Number(year) !== entry.year)) return;
    const candidates = [...years.values()].flatMap(bucket => [...bucket.values()]); if (candidates.length !== 1) return;
    const candidate = candidates[0], languages = this.languages.get(candidate.id);
    if (entry.year !== null && candidate.year === null && (this.decorated.has(candidate.id) || languages?.size && !languages.has('mul'))) return candidate;
    if (entry.decorated || this.decorated.has(candidate.id) && !!entry.language) return candidate;
    return languages?.size && [...languages].some(language => language !== 'mul') && !languages.has(entry.language!) ? candidate : undefined;
  }
  conflictingSeriesYears(entry: PlaylistEntry) {
    if (entry.type !== 'series' || entry.year !== null) return false;
    const years = this.exact.get(this.exactKey(entry)); if (!years) return false;
    let knownYears = 0; for (const year of years.keys()) if (year && ++knownYears > 1) return true;
    return false;
  }
  possible(entry: PlaylistEntry): Row | undefined {
    const years = this.exact.get(this.exactKey(entry));
    const uncertain = entry.year === null ? years?.values().next().value?.values().next().value : years?.get('')?.values().next().value;
    if (uncertain || entry.year === null) return uncertain;
    let examined = 0;
    for (let length = Math.max(0, entry.normalized.length - 7); length <= entry.normalized.length + 7; length++) {
      for (const candidate of this.fuzzy.get(this.fuzzyKey(entry, length))?.values() || []) {
        // Saturated or very long windows remain manual review, never a guessed merge.
        if (++examined > 128 || entry.normalized.length > 300) return candidate;
        this.comparisons++;
        if (similarity(candidate.normalized, entry.normalized) >= 0.88) return candidate;
      }
    }
  }
}
async function identify(db: DB, entry: PlaylistEntry, cache: ImportIdentityIndex) {
  let externalConflict: Row | undefined;
  if (entry.externalId) {
    const match = await db.get('SELECT t.* FROM titles t JOIN metadata_identifiers m ON m.title_id=t.id WHERE m.provider=? AND m.external_id=? AND t.type=?', [entry.externalId.provider, entry.externalId.id, entry.type]);
    if (match && (!entry.year || !match.year || Number(match.year) === entry.year)) return { titleId: match.id, review: null };
    if (match) externalConflict = match;
  }
  // Automatic merging requires a confirmed year (or series identity with episode coordinates).
  const aliasCandidates = cache.aliasCandidates(entry);
  let strong = cache.strong(entry) || cache.languageVariant(entry);
  const aliasConflict = aliasCandidates.length > 1 || strong && aliasCandidates.some(candidate => candidate.id !== strong!.id) ? aliasCandidates[0] : undefined;
  if (aliasConflict) strong = undefined;
  else if (!strong && aliasCandidates.length === 1) strong = aliasCandidates[0];
  // Another import may have committed since this run built its index.
  if (!strong && !aliasConflict && (entry.year !== null || entry.type === 'series' && entry.season !== null && entry.episode !== null)) {
    strong = await db.get(`SELECT ${TITLE_COLUMNS} FROM titles WHERE normalized=? AND type=? AND ${entry.year === null ? 'year IS NULL' : 'year=?'} LIMIT 1`, [entry.normalized, entry.type, ...(entry.year === null ? [] : [entry.year])]);
    if (strong) cache.add(strong);
  }
  if (strong && !externalConflict) {
    const external = entry.externalId ? await db.get('SELECT external_id FROM metadata_identifiers WHERE title_id=? AND provider=?', [strong.id, entry.externalId.provider]) : null;
    if (!external || external.external_id === entry.externalId?.id) {
      if (cache.conflictingSeriesYears(entry)) {
        if (!(await db.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [strong.id]))) { await db.run('UPDATE titles SET published=0,updated_at=? WHERE id=?', [Date.now(), strong.id]); strong.published = 0; }
        return { titleId: strong.id, review: { candidateId: null, reason: 'Same series name has conflicting release years; manual confirmation required' } };
      }
      if (entry.year !== null && strong.year === null && !(await db.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [strong.id]))) {
        const current = await db.get('SELECT year FROM titles WHERE id=?', [strong.id]);
        if (current && current.year === null) { await db.run('UPDATE titles SET year=?,updated_at=? WHERE id=? AND year IS NULL', [entry.year, Date.now(), strong.id]); cache.remove(strong); strong = { ...strong, year: entry.year }; cache.add(strong); }
        else if (current && Number(current.year) !== entry.year) return { titleId: strong.id, review: { candidateId: null, reason: 'Release year changed during import; manual confirmation required' } };
      }
      return { titleId: strong.id, review: null };
    }
    externalConflict = strong;
  }
  const possible = externalConflict || aliasConflict || cache.possible(entry);
  const titleId = await createTitle(db, { name: entry.title, year: entry.year, type: entry.type, poster: safeImage(entry.poster), published: !entry.ambiguous && !possible, genres: extractGenres(entry) });
  cache.add({ id: titleId, name: entry.title, normalized: entry.normalized, type: entry.type, year: entry.year, published: !entry.ambiguous && !possible ? 1 : 0 });
  if (entry.externalId && !possible) await db.run('INSERT INTO metadata_identifiers(id,title_id,provider,external_id) VALUES(?,?,?,?) ON CONFLICT(provider,external_id) DO NOTHING', [id(), titleId, entry.externalId.provider, entry.externalId.id]);
  return { titleId, review: possible ? { candidateId: possible.id, reason: externalConflict ? 'External metadata identity conflicts with title/year; manual confirmation required' : aliasConflict ? 'Saved title alias matches multiple identities; manual confirmation required' : cache.conflictingSeriesYears(entry) ? 'Same series name has conflicting release years; manual confirmation required' : 'Potential duplicate needs identity confirmation' } : entry.ambiguous ? { candidateId: null, reason: CLASSIFICATION_REVIEW } : null };
}
export function safeImage(value: string) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : ''; } catch { return value.startsWith('/images/') ? value : ''; } }
function extractGenres(entry: PlaylistEntry) {
  const recognized = ['Action', 'Comedy', 'Horror', 'Thriller', 'Sci-Fi', 'Drama', 'Animation', 'Documentary', 'Fantasy', 'Adventure'];
  const supplied = entry.attributes.genres || entry.group;
  return recognized.filter(genre => supplied.toLowerCase().includes(genre.toLowerCase()));
}
async function episodeFor(db: DB, titleId: string, entry: PlaylistEntry, cache: Map<string, string>) {
  if (entry.type !== 'series' || entry.season === null || entry.episode === null) return null;
  const episodeKey = `${titleId}:${entry.season}:${entry.episode}`; if (cache.has(episodeKey)) return cache.get(episodeKey)!;
  const seasonKey = `${titleId}:${entry.season}`;
  let season = cache.has(seasonKey) ? { id: cache.get(seasonKey)! } : await db.get('SELECT id FROM seasons WHERE title_id=? AND number=?', [titleId, entry.season]);
  if (!season) season = await db.get('INSERT INTO seasons(id,title_id,number) VALUES(?,?,?) ON CONFLICT(title_id,number) DO NOTHING RETURNING id', [id(), titleId, entry.season]) || await db.get('SELECT id FROM seasons WHERE title_id=? AND number=?', [titleId, entry.season]);
  cache.set(seasonKey, season!.id);
  let episode = await db.get('SELECT id FROM episodes WHERE title_id=? AND season=? AND number=?', [titleId, entry.season, entry.episode]);
  if (!episode) episode = await db.get('INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES(?,?,?,?,?,?) ON CONFLICT(title_id,season,number) DO NOTHING RETURNING id', [id(), titleId, season!.id, entry.season, entry.episode, entry.episodeName]) || await db.get('SELECT id FROM episodes WHERE title_id=? AND season=? AND number=?', [titleId, entry.season, entry.episode]);
  cache.set(episodeKey, episode!.id);
  return episode!.id;
}
export interface ImportBatchProgress { processed: number; total: number; batches: number }
export interface ImportOptions { batchSize?: number; onBatch?: (progress: ImportBatchProgress) => Promise<void> | void }
const yieldImport = () => new Promise<void>(resolve => setImmediate(resolve));
/** Match parser upgrades without guessing between repeated URLs or language copies. */
function importSourceKeys(urlHash: string, language: unknown, originalName: unknown): (string | null)[] {
  const code = normalizeLanguage(language); const name = typeof originalName === 'string' ? originalName.trim().replace(/\s+/g, ' ') : '';
  return [code && name ? JSON.stringify([urlHash, code, name]) : null, name ? JSON.stringify([urlHash, name]) : null, code ? JSON.stringify([urlHash, code]) : null, urlHash];
}
export async function synchronizePlaylist(db: DB, playlistId: string, fetcher: SafeFetcher = safeFetch, restoreContent?: string, options: ImportOptions = {}) {
  const playlist = await db.get('SELECT * FROM playlists WHERE id=?', [playlistId]); if (!playlist) throw new Error('Playlist no longer exists');
  if (!playlist.enabled && !restoreContent) return { skipped: true, reason: 'Playlist disabled' };
  // Legitimate encrypted updates replace the random IV and authentication tag,
  // both contained in these 64 characters. Compare their prefix and byte length;
  // never retransmit an unlimited upload for each batch. OCTET_LENGTH can use
  // stored byte-length metadata instead of scanning ASCII ciphertext characters.
  const configurationValues = [(playlist.url_encrypted || '').slice(0, 64), (playlist.url_encrypted || '').length, (playlist.content_encrypted || '').slice(0, 64), (playlist.content_encrypted || '').length];
  const configurationColumns = "COALESCE(SUBSTR(url_encrypted,1,64),'') AS url_prefix,COALESCE(OCTET_LENGTH(url_encrypted),0) AS url_length,COALESCE(SUBSTR(content_encrypted,1,64),'') AS content_prefix,COALESCE(OCTET_LENGTH(content_encrypted),0) AS content_length";
  const configurationPredicate = "COALESCE(SUBSTR(url_encrypted,1,64),'')=? AND COALESCE(OCTET_LENGTH(url_encrypted),0)=? AND COALESCE(SUBSTR(content_encrypted,1,64),'')=? AND COALESCE(OCTET_LENGTH(content_encrypted),0)=?";
  const configurationCurrent = async (tx: DB = db, lock = false) => {
    const current = await tx.get(`SELECT ${configurationColumns} FROM playlists WHERE id=?` + (lock && tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), [playlistId]);
    return !!current && current.url_prefix === configurationValues[0] && Number(current.url_length) === configurationValues[1] && current.content_prefix === configurationValues[2] && Number(current.content_length) === configurationValues[3];
  };
  const superseded = () => ({ skipped: true, reason: 'Playlist configuration changed; a fresh import is required' });
  const assertConfiguration = async (tx: DB) => { if (!(await configurationCurrent(tx, true))) throw new Error('Playlist configuration changed during import'); };
  let content: string;
  try {
    if (restoreContent !== undefined) content = restoreContent;
    else if (playlist.url_encrypted) {
      const fetched = await fetcher(decrypt(playlist.url_encrypted), { maxBytes: 0, timeoutMs: 20000 });
      if (fetched.status !== 200) throw new PlaylistFetchError(fetched.status, fetched.headers['retry-after']);
      if (fetched.truncated) throw new Error('Playlist download was incomplete'); content = fetched.body.toString('utf8');
    } else content = decrypt(playlist.content_encrypted || '');
    const contentHash = hash(content); const previousVersion = await db.get('SELECT content_hash,report FROM playlist_versions WHERE playlist_id=? ORDER BY created_at DESC LIMIT 1', [playlistId]);
    let previousImportVersion = 0; let previousStarterVersion = 0; let previousReport: Record<string, any> = {};
    try { previousReport = JSON.parse(previousVersion?.report || '{}'); previousImportVersion = previousReport.importVersion || 0; previousStarterVersion = previousReport.starterVerificationVersion || 0; } catch { /* Older or corrupt reports require reprocessing. */ }
    if (!(await configurationCurrent())) return superseded();
    // The activated snapshot proves these exact bytes were fully parsed and
    // committed by this parser. Skip parsing/index construction on routine refresh.
    const unchangedSnapshot = previousVersion?.content_hash === contentHash && previousImportVersion === M3U_IMPORT_VERSION && previousStarterVersion === STARTER_VERIFICATION_VERSION && playlist.health === 'healthy' && restoreContent === undefined;
    if (unchangedSnapshot && Number.isInteger(previousReport.valid) && previousReport.valid > 0 && previousReport.valid === Number(playlist.entry_count) && Array.isArray(previousReport.errors)) {
      const current = await db.get(`UPDATE playlists SET health='healthy',error=NULL,last_sync=?,next_sync=? WHERE id=? AND ${configurationPredicate} RETURNING id`, [Date.now(), Date.now() + Number(playlist.interval_hours) * 3600000, playlistId, ...configurationValues]);
      if (!current) return superseded();
      return { importVersion: M3U_IMPORT_VERSION, starterVerificationVersion: STARTER_VERIFICATION_VERSION, starterChecks: 0, added: 0, updated: 0, removed: 0, unchanged: previousReport.valid, reviews: 0, repaired: 0, valid: previousReport.valid, processed: 0, batches: 0, errors: previousReport.errors, restored: false, contentChanged: false };
    }
    const parsed = parseM3U(content);
    if (!parsed.entries.length) throw new Error('Playlist has no valid entries; existing catalog preserved');
    const genericImages = genericPlaylistArtwork(parsed.entries);
    for (const entry of parsed.entries) if (entry.type !== 'live' && genericImages.has(entry.poster)) entry.poster = '';
    const previousCount = Number(playlist.entry_count);
    if (!restoreContent && previousCount >= 10 && parsed.entries.length < previousCount * 0.2) throw new Error('Unexpected playlist shrink above 80%; existing catalog preserved for review');
    const report: Record<string, any> = { importVersion: M3U_IMPORT_VERSION, starterVerificationVersion: STARTER_VERIFICATION_VERSION, starterChecks: 0, added: 0, updated: 0, removed: 0, unchanged: 0, reviews: 0, repaired: 0, valid: parsed.entries.length, processed: 0, batches: 0, errors: parsed.errors, restored: restoreContent !== undefined };
    if (unchangedSnapshot) {
      const current = await db.get(`UPDATE playlists SET health='healthy',error=NULL,last_sync=?,next_sync=? WHERE id=? AND ${configurationPredicate} RETURNING id`, [Date.now(), Date.now() + Number(playlist.interval_hours) * 3600000, playlistId, ...configurationValues]);
      if (!current) return superseded();
      return { ...report, unchanged: parsed.entries.length, contentChanged: false };
    }
    // A crashed run can have committed early batches without activating a snapshot.
    // Persist a dirty marker so reverting to the previous bytes still reconciles them.
    const current = await db.get(`UPDATE playlists SET health='unknown',error=NULL WHERE id=? AND ${configurationPredicate} RETURNING id`, [playlistId, ...configurationValues]);
    if (!current) return superseded();
    // Two indexed heads, once per import; never scan/sort the whole active queue.
    const healthHeads = await Promise.all(['queued', 'running'].map(status => db.get(`SELECT run_after FROM jobs WHERE type='health' AND status='${status}' AND attempts<max_attempts ORDER BY run_after,created_at LIMIT 1`)));
    const starterRunAfter = Math.min(Date.now(), ...healthHeads.filter(Boolean).map(row => Number(row!.run_after))) - 1;
    const old = await db.all('SELECT id,entry_key,url_hash,removed,title_id,episode_id,enabled,health,last_checked,last_success,failures,language,original_name FROM sources WHERE playlist_id=?', [playlistId]);
    const oldByKey = new Map(old.map(source => [source.entry_key, source]));
    const needsFallback = old.length > 0 && parsed.entries.some(entry => !oldByKey.has(entry.key));
    const oldMatches = Array.from({ length: needsFallback ? 4 : 0 }, () => new Map<string, Row | null>());
    if (needsFallback) for (const source of old) importSourceKeys(source.url_hash, source.language, source.original_name).forEach((key, level) => {
      if (key !== null) oldMatches[level].set(key, oldMatches[level].has(key) ? null : source);
    });
    const incomingKeys = new Set(needsFallback ? parsed.entries.map(entry => entry.key) : []);
    const incomingCounts = Array.from({ length: 4 }, () => new Map<string, number>());
    const entryHashes = parsed.entries.map(entry => hash(entry.url));
    if (needsFallback) parsed.entries.forEach((entry, offset) => importSourceKeys(entryHashes[offset], entry.language, entry.name).forEach((key, level) => { if (key !== null) incomingCounts[level].set(key, (incomingCounts[level].get(key) || 0) + 1); }));
    // Metadata may replace an imported name with its confirmed English release
    // name. Load only aliases relevant to this playlist, using the alias index.
    const incomingNames = [...new Set(parsed.entries.map(entry => entry.normalized))]; const titleAliases: Row[] = [];
    for (let start = 0; start < incomingNames.length; start += 300) {
      const names = incomingNames.slice(start, start + 300);
      titleAliases.push(...await db.all(`SELECT title_id,normalized FROM title_aliases WHERE normalized IN (${names.map(() => '?').join(',')})`, names));
    }
    const cache = new ImportIdentityIndex(await db.all(`SELECT ${TITLE_COLUMNS} FROM titles`), await db.all('SELECT title_id,language,original_name FROM sources WHERE language IS NOT NULL OR original_name IS NOT NULL'), titleAliases); const episodeCache = new Map<string, string>();
    const pendingReviews = await db.all("SELECT id,source_id,title_id,reason FROM review_queue WHERE status='pending'"); const reviewsByTitle = new Map<string, Row[]>(); const reviewsBySource = new Map<string, Row[]>();
    for (const review of pendingReviews) { let rows = reviewsByTitle.get(review.title_id); if (!rows) reviewsByTitle.set(review.title_id, rows = []); rows.push(review); let sourceRows = reviewsBySource.get(review.source_id); if (!sourceRows) reviewsBySource.set(review.source_id, sourceRows = []); sourceRows.push(review); }
    const locked = new Set((await db.all('SELECT title_id FROM title_metadata_locks')).map(row => row.title_id));
    const activeIds = new Set<string>(); const batchSize = Math.max(1, Math.min(250, Math.floor(options.batchSize || 100)));
    const starterTitles = new Map<string, Set<string>>(); const starterCandidates = new Map<string, Set<string>>();
    const prioritizeStarter = async (tx: DB, entry: PlaylistEntry, sourceId: string, titleId: string, source?: Row) => {
      if (entry.ambiguous || !['mp4', 'hls', 'dash', 'webm'].includes(entry.format) || !cache.rows.get(titleId)?.published) return;
      if (source && (!source.enabled || source.health !== 'unknown' || source.last_checked !== null || source.last_success !== null || Number(source.failures) !== 0)) return;
      const bucket = `${entry.type}:${entry.format}`; const promoted = starterTitles.get(bucket) || new Set<string>(); const attempted = starterCandidates.get(bucket) || new Set<string>();
      if (promoted.size >= STARTER_PER_BUCKET || attempted.size >= STARTER_CANDIDATES_PER_BUCKET || attempted.has(titleId)) return;
      attempted.add(titleId); starterCandidates.set(bucket, attempted);
      // Check current state inside the commit: a consumer may have checked an old
      // source since this import loaded it. Attempted retries and running jobs stay put.
      // The redundant IN predicate matches the existing partial dedupe index on
      // SQLite; queued equality alone can otherwise trigger a bulk queue scan.
      const boosted = await tx.get("UPDATE jobs SET run_after=? WHERE type='health' AND status='queued' AND status IN ('queued','running') AND attempts=0 AND dedupe_key=? AND run_after>? AND EXISTS (SELECT 1 FROM sources s JOIN titles t ON t.id=s.title_id WHERE s.id=? AND s.enabled=1 AND s.removed=0 AND s.playback_blocked=0 AND s.health='unknown' AND s.last_checked IS NULL AND s.last_success IS NULL AND s.failures=0 AND t.published=1) RETURNING id", [starterRunAfter, `health:${sourceId}`, starterRunAfter, sourceId]);
      if (boosted) { promoted.add(titleId); starterTitles.set(bucket, promoted); report.starterChecks++; }
    };
    const appendReview = async (tx: DB, source: Row, reason: string) => {
      if ((reviewsBySource.get(source.id) || []).some(review => review.reason === reason)) return;
      const review = { id: id(), source_id: source.id, title_id: source.title_id, reason };
      await tx.run('INSERT INTO review_queue(id,source_id,title_id,reason,created_at) VALUES(?,?,?,?,?)', [review.id, source.id, source.title_id, reason, Date.now()]);
      const rows = reviewsBySource.get(source.id) || []; rows.push(review); reviewsBySource.set(source.id, rows); report.reviews++;
    };
    // All bytes and entries have been parsed before the first catalog mutation. Each
    // commit is independently retriable; deletion and snapshot activation happen last.
    for (let start = 0; start < parsed.entries.length; start += batchSize) {
      await db.transaction(async tx => {
       await assertConfiguration(tx);
       // PostgreSQL reports and imports share these locks. Acquire every batch URL
       // in order before row mutations, so concurrent imports cannot lock A/B in reverse.
       const batchHashes = entryHashes.slice(start, start + batchSize);
       await lockImportUrls(tx, batchHashes);
       const blockedUrls = await importPlaybackBlocks(tx, batchHashes.filter((urlHash, index) => { const source = oldByKey.get(parsed.entries[start + index].key); return !source || source.url_hash !== urlHash; }));
       let newSources: unknown[][] = [], newChecks: unknown[][] = [], newReviews: unknown[][] = [];
       let newStarters: Array<{ entry: PlaylistEntry; sourceId: string; titleId: string }> = [];
       const flushNewSources = async () => {
         await insertImportRows(tx, 'sources', ['id','title_id','episode_id','playlist_id','entry_key','name','original_name','language','url_encrypted','url_hash','format','health','error','failures','last_failure','playback_blocked','playback_blocked_at','created_at'], newSources);
         await insertImportRows(tx, 'review_queue', ['id','source_id','title_id','candidate_id','reason','created_at'], newReviews);
         // New random source IDs cannot already own retries or leases. Existing
         // sources continue through enqueue(), which preserves those states.
         await insertImportRows(tx, 'jobs', ['id','type','payload','status','run_after','created_at','dedupe_key'], newChecks, true);
         for (const starter of newStarters) await prioritizeStarter(tx, starter.entry, starter.sourceId, starter.titleId);
         newSources = []; newChecks = []; newReviews = []; newStarters = [];
       };
       for (let offset = start; offset < Math.min(start + batchSize, parsed.entries.length); offset++) {
        const entry = parsed.entries[offset]; const urlHash = entryHashes[offset];
        let existing = oldByKey.get(entry.key);
        const fallbackKeys = !existing && needsFallback ? importSourceKeys(urlHash, entry.language, entry.name) : [];
        if (!existing) for (let level = 0; level < oldMatches.length; level++) {
          const key = fallbackKeys[level]; if (key === null || incomingCounts[level].get(key) !== 1) continue;
          const candidate = oldMatches[level].get(key);
          // Reserve exact keys for their own entries, even when those appear later.
          if (candidate && !incomingKeys.has(candidate.entry_key) && !activeIds.has(candidate.id)) { existing = candidate; break; }
        }
        if (existing) {
          // Classification repair counts a title's sources. Make preceding new
          // rows visible before that path, including mixed old/new provider lists.
          await flushNewSources();
          activeIds.add(existing.id);
          const title = cache.rows.get(existing.title_id); const titleReviews = reviewsByTitle.get(existing.title_id) || [];
          let classificationOnly = !!title && !title.published && titleReviews.length > 0 && titleReviews.every(review => review.reason === CLASSIFICATION_REVIEW) && !locked.has(title.id);
          // Recheck within the commit: administrator edits can happen between batches.
          if (classificationOnly && (await tx.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [title!.id]) || (await tx.get('SELECT published FROM titles WHERE id=?', [title!.id]))?.published)) classificationOnly = false;
          const sameLiveName = !!title && title.type === 'live' && entry.type === 'live' && normalizeTitle(cleanMediaTitle(title.name).title) === normalizeTitle(cleanMediaTitle(entry.title).title);
          let sameAlias = !!title && cache.matchesAlias(title, entry);
          if (sameAlias && entry.externalId) { const binding = await tx.get('SELECT external_id FROM metadata_identifiers WHERE title_id=? AND provider=?', [title!.id, entry.externalId.provider]); if (binding && binding.external_id !== entry.externalId.id) sameAlias = false; }
          const differs = !!title && (title.type !== entry.type || title.normalized !== entry.normalized && !sameLiveName && !sameAlias || Number(title.year || 0) !== Number(entry.year || 0) && !sameAlias);
          // Version upgrades may repair only identities that were explicitly left for
          // machine classification review. Published or manually edited titles survive.
          if (!entry.ambiguous && classificationOnly && !differs) {
            await tx.run('UPDATE titles SET published=1,updated_at=? WHERE id=?', [Date.now(), title!.id]); title!.published = 1;
            for (const review of titleReviews) await tx.run("UPDATE review_queue SET status='resolved' WHERE id=?", [review.id]); reviewsByTitle.delete(title!.id); report.repaired++;
          } else if (!entry.ambiguous && classificationOnly && differs && Number((await tx.get('SELECT COUNT(*) AS n FROM sources WHERE title_id=?', [title!.id]))?.n) === 1 && !(await tx.get('SELECT id FROM metadata_identifiers WHERE title_id=? LIMIT 1', [title!.id]))) {
            const candidate = cache.strong(entry); const possible = candidate || cache.possible(entry);
            // A same-year or episode identity can be consolidated with the existing
            // administrator merge routine, which retains progress, lists and metadata.
            const enriched = candidate && await tx.get('SELECT synopsis,poster,backdrop,genres,cast_members,director FROM titles WHERE id=?', [title!.id]);
            const hasMetadata = !!enriched && ['synopsis', 'poster', 'backdrop', 'director'].some(key => !!enriched[key]) || !!enriched && [enriched.genres, enriched.cast_members].some(value => value && value !== '[]');
            if ((!possible || candidate) && !hasMetadata) {
              cache.remove(title!);
              await tx.run('UPDATE titles SET name=?,normalized=?,type=?,year=?,published=1,updated_at=? WHERE id=?', [entry.title, entry.normalized, entry.type, entry.year, Date.now(), title!.id]);
              const repaired = { ...title!, name: entry.title, normalized: entry.normalized, type: entry.type, year: entry.year, published: 1 }; cache.add(repaired);
              const episodeId = await episodeFor(tx, title!.id, entry, episodeCache);
              await tx.run('UPDATE sources SET episode_id=? WHERE id=?', [episodeId, existing.id]); existing.episode_id = episodeId;
              if (episodeId && title!.type !== 'series') {
                await tx.run('UPDATE playback_progress SET episode_id=?,item_key=? WHERE title_id=? AND episode_id IS NULL', [episodeId, episodeId, title!.id]);
                await tx.run('UPDATE watch_history SET episode_id=? WHERE title_id=? AND episode_id IS NULL', [episodeId, title!.id]);
              }
              for (const review of titleReviews) await tx.run("UPDATE review_queue SET status='resolved' WHERE id=?", [review.id]); reviewsByTitle.delete(title!.id);
              if (candidate && candidate.id !== title!.id) {
                const { mergeTitles } = await import('./management'); await mergeTitles(tx, title!.id, candidate.id); cache.remove(repaired);
                existing.title_id = candidate.id; existing.episode_id = await episodeFor(tx, candidate.id, entry, episodeCache);
              }
              report.repaired++;
            } else await appendReview(tx, existing, hasMetadata ? 'Provider reclassification may merge existing metadata; manual confirmation required' : 'Provider classification has a possible duplicate; manual confirmation required');
          } else if (differs) await appendReview(tx, existing, 'Provider classification differs from saved identity; manual confirmation required');
          // Old parsers could leave an EP source unassigned under an otherwise
          // correct series. A confirmed original-name alias preserves an English
          // display name while explicit coordinates supply the missing episode.
          if (!differs && !entry.ambiguous && title?.type === 'series' && !existing.episode_id && entry.season !== null && entry.episode !== null && !locked.has(title.id)) {
            const currentTitle = await tx.get(`SELECT t.type,t.year,EXISTS(SELECT 1 FROM title_metadata_locks l WHERE l.title_id=t.id) AS manually_locked FROM titles t WHERE t.id=?${tx.dialect === 'postgres' ? ' FOR UPDATE OF t' : ''}`, [existing.title_id]);
            if (currentTitle?.type === 'series' && !currentTitle.manually_locked && (entry.year === null || currentTitle.year === null || Number(currentTitle.year) === entry.year)) {
              const episodeId = await episodeFor(tx, existing.title_id, entry, episodeCache);
              const assigned = await tx.get('UPDATE sources SET episode_id=? WHERE id=? AND title_id=? AND episode_id IS NULL RETURNING id', [episodeId, existing.id, existing.title_id]);
              if (assigned) { existing.episode_id = episodeId; report.repaired++; }
            }
          }
          if (existing.entry_key !== entry.key) await tx.run('UPDATE sources SET entry_key=? WHERE id=?', [entry.key, existing.id]);
          if (existing.language !== entry.language || existing.original_name !== entry.name) await tx.run('UPDATE sources SET language=?,original_name=? WHERE id=?', [entry.language, entry.name, existing.id]);
          cache.recordLanguage(existing.title_id, entry.language, entry.name);
          if (existing.url_hash !== urlHash || existing.removed) {
            if (existing.url_hash !== urlHash) {
              const blocked = blockedUrls.get(urlHash);
              await tx.run('UPDATE sources SET url_encrypted=?,url_hash=?,format=?,health=?,quality=NULL,error=?,failures=?,successes=0,last_success=NULL,last_checked=NULL,last_failure=?,removed=0,playback_blocked=?,playback_blocked_at=? WHERE id=?', [encrypt(entry.url), urlHash, entry.format, blocked ? 'unavailable' : 'unknown', blocked ? blocked.error || 'Browser playback requires a verified retry' : null, blocked ? Math.max(1, Number(blocked.failures) || 0) : 0, blocked?.last_failure ?? null, blocked ? 1 : 0, blocked?.playback_blocked_at ?? null, existing.id]);
            }
            else await tx.run("UPDATE sources SET removed=0,health=CASE WHEN playback_blocked=1 THEN 'unavailable' ELSE 'unknown' END,quality=CASE WHEN playback_blocked=1 THEN quality ELSE NULL END,error=CASE WHEN playback_blocked=1 THEN error ELSE NULL END,failures=CASE WHEN playback_blocked=1 THEN failures ELSE 0 END,successes=CASE WHEN playback_blocked=1 THEN successes ELSE 0 END,last_success=CASE WHEN playback_blocked=1 THEN last_success ELSE NULL END,last_checked=CASE WHEN playback_blocked=1 THEN last_checked ELSE NULL END WHERE id=?", [existing.id]);
            report.updated++;
            await enqueue(tx, 'health', { sourceId: existing.id }, { dedupeKey: `health:${existing.id}` });
            await prioritizeStarter(tx, entry, existing.id, existing.title_id);
          } else {
            report.unchanged++;
            if (previousImportVersion !== M3U_IMPORT_VERSION || previousStarterVersion !== STARTER_VERIFICATION_VERSION) await enqueueUncheckedHealth(tx, existing.id);
            await prioritizeStarter(tx, entry, existing.id, existing.title_id, existing);
          }
          continue;
        }
        const identity = await identify(tx, entry, cache); const episodeId = await episodeFor(tx, identity.titleId, entry, episodeCache); const sourceId = id(); activeIds.add(sourceId);
        // Read inside the current batch so failures reported after the import began
        // are preserved too. The URL/playback index bounds this lookup on large catalogs.
        const blocked = blockedUrls.get(urlHash), now = Date.now();
        newSources.push([sourceId, identity.titleId, episodeId, playlistId, entry.key, playlist.name, entry.name, entry.language, encrypt(entry.url), urlHash, entry.format, blocked ? 'unavailable' : 'unknown', blocked ? blocked.error || 'Browser playback requires a verified retry' : null, blocked ? Math.max(1, Number(blocked.failures) || 0) : 0, blocked?.last_failure ?? null, blocked ? 1 : 0, blocked?.playback_blocked_at ?? null, now]);
        cache.recordLanguage(identity.titleId, entry.language, entry.name);
        if (identity.review) { newReviews.push([id(), sourceId, identity.titleId, identity.review.candidateId, identity.review.reason, now]); report.reviews++; }
        newChecks.push([id(), 'health', JSON.stringify({ sourceId }), 'queued', now, now, `health:${sourceId}`]);
        newStarters.push({ entry, sourceId, titleId: identity.titleId });
        // Metadata backfill is scheduled in bounded worker batches, rather than
        // queueing one remote lookup for every entry of a large playlist.
        report.added++;
       }
       await flushNewSources();
      });
      report.processed = Math.min(start + batchSize, parsed.entries.length); report.batches++;
      await options.onBatch?.({ processed: report.processed, total: parsed.entries.length, batches: report.batches });
      await yieldImport();
    }
    const removed = old.filter(source => !activeIds.has(source.id) && !source.removed);
    if (parsed.errors.length && removed.length) report.removalsSuppressed = true;
    else for (let start = 0; start < removed.length; start += batchSize) {
      await db.transaction(async tx => { await assertConfiguration(tx); const ids = removed.slice(start, start + batchSize).map(source => source.id); await tx.run(`UPDATE sources SET removed=1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids); report.removed += ids.length; });
      await yieldImport();
    }
    report.identityComparisons = cache.comparisons;
    const encryptedContent = encrypt(content);
    await yieldImport();
    await db.transaction(async tx => {
      await assertConfiguration(tx);
      const now = Date.now();
      await tx.run('INSERT INTO playlist_versions(id,playlist_id,content_encrypted,content_hash,report,created_at) VALUES(?,?,?,?,?,?)', [id(), playlistId, encryptedContent, contentHash, JSON.stringify(report), now]);
      await tx.run("UPDATE playlists SET health='healthy',error=NULL,last_sync=?,next_sync=?,entry_count=? WHERE id=?", [now, now + Number(playlist.interval_hours) * 3600000, parsed.entries.length, playlistId]);
    });
    if (db.dialect === 'sqlite' && (report.added + report.updated + report.repaired + report.removed >= 1000)) await db.run('ANALYZE sources');
    return { ...report, contentChanged: true };
  } catch (error) {
    if (!(await configurationCurrent())) return superseded();
    const current = await db.get(`UPDATE playlists SET health='unavailable',error=?,next_sync=? WHERE id=? AND ${configurationPredicate} RETURNING id`, [sanitizeError(error), Date.now() + Math.min(Number(playlist.interval_hours) * 3600000, 3600000), playlistId, ...configurationValues]);
    if (!current) return superseded(); throw error;
  }
}
export async function checkSource(db: DB, sourceId: string, fetcher: SafeFetcher = safeFetch) {
  const source = await db.get('SELECT s.*,p.enabled AS playlist_enabled FROM sources s LEFT JOIN playlists p ON p.id=s.playlist_id WHERE s.id=?', [sourceId]);
  if (!source || !source.enabled || source.removed || source.playlist_enabled === 0) return { skipped: true };
  const result = await verifyStream(decrypt(source.url_encrypted), source.format, fetcher); const now = Date.now(); let health = nextHealth(source.health, Number(source.failures), result.ok); let appliedError = result.error;
  if (result.retryable) throw new Error(result.error || 'Video verification is temporarily busy');
  const applied = await db.transaction(async tx => {
    const current = await tx.get('SELECT url_hash,playback_blocked,error,health,failures,successes,last_success,last_failure,quality FROM sources WHERE id=?', [sourceId]); if (!current || current.url_hash !== source.url_hash) return false;
    const blocked = !!current.playback_blocked;
    health = blocked ? 'unavailable' : nextHealth(current.health, Number(current.failures), result.ok);
    appliedError = blocked ? current.error || 'Browser playback requires a verified retry' : result.error;
    await tx.run('UPDATE sources SET health=?,format=?,quality=?,last_checked=?,last_success=?,last_failure=?,error=?,failures=?,successes=? WHERE id=? AND url_hash=?', [health, result.format, result.ok ? result.quality : current.quality, now, result.ok && !blocked ? now : current.last_success, result.ok ? current.last_failure : now, appliedError, result.ok ? blocked ? Number(current.failures) : 0 : Number(current.failures) + 1, Number(current.successes) + (result.ok ? 1 : 0), sourceId, source.url_hash]);
    await tx.run('INSERT INTO source_health_history(id,source_id,health,error,latency_ms,created_at) VALUES(?,?,?,?,?,?)', [id(), sourceId, health, appliedError, result.latencyMs, now]);
    return true;
  });
  if (!applied) return { skipped: true, reason: 'Source changed during verification' };
  return { sourceId, ...result, health, error: appliedError };
}
/** Explicit integration contract for a licensed metadata service, not a scraper.
 * Service accepts ?title=&year=&type= and returns a JSON title object with verified fields.
 * Tokens are sent in headers; provider hostname is administrator-configured, never user input. */
export async function enrichMetadata(db: DB, titleId: string) {
  const { enrichTitleMetadata } = await import('./metadata'); return enrichTitleMetadata(db, titleId);
}
