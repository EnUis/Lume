import type { DB, Row } from './db';
import { automaticMergeConflict, mergeTitles } from './management';
import { cleanMediaTitle, normalizeTitle, parseEpisodeTitle } from './m3u';
import { hash } from './security';
import { normalizeLanguage } from '../languages';

interface Identity extends Row { sources: Row[]; identifiers: Row[]; locked: boolean }
export interface ConsolidationGroup { titleIds: string[]; fingerprints: string[]; reason: 'same-release' | 'language-versions' | 'numbered-series' | 'same-stream' }
export interface ConsolidationPreview { groups: ConsolidationGroup[]; mergeCount: number; uncertainGroups: number }
async function identities(db: DB, rows: Row[]): Promise<Identity[]> {
  const result: Identity[] = rows.map(row => ({ ...row, sources: [], identifiers: [], locked: false }));
  const byId = new Map(result.map(row => [row.id, row]));
  for (let start = 0; start < rows.length; start += 250) {
    const ids = rows.slice(start, start + 250).map(row => row.id), placeholders = ids.map(() => '?').join(',');
    for (const source of await db.all(`SELECT s.id,s.title_id,s.url_hash,s.original_name,s.language,s.episode_id,e.title_id AS episode_title,e.season,e.number FROM sources s LEFT JOIN episodes e ON e.id=s.episode_id WHERE s.title_id IN (${placeholders}) AND s.removed=0 ORDER BY s.id`, ids)) byId.get(source.title_id)!.sources.push(source);
    for (const identifier of await db.all(`SELECT title_id,provider,external_id FROM metadata_identifiers WHERE title_id IN (${placeholders}) ORDER BY provider,external_id`, ids)) byId.get(identifier.title_id)!.identifiers.push(identifier);
    for (const lock of await db.all(`SELECT title_id FROM title_metadata_locks WHERE title_id IN (${placeholders})`, ids)) byId.get(lock.title_id)!.locked = true;
  }
  return result;
}
function fingerprint(row: Identity) {
  return hash(JSON.stringify([row.id, row.name, row.normalized, row.type, row.year == null ? null : Number(row.year), Number(row.published), row.locked, row.sources, row.identifiers]));
}
function proof(group: Identity[]): ConsolidationGroup['reason'] | null {
  if (group.length < 2 || group.some(row => row.locked || !row.sources.length || row.type === 'live')) return null;
  const first = group[0];
  if (group.some(row => row.type !== first.type || row.normalized !== first.normalized || normalizeTitle(cleanMediaTitle(row.name).title) !== first.normalized)) return null;
  const years = new Set(group.map(row => row.year == null ? null : Number(row.year)));
  if (years.size > 1) return null;
  const external = new Map<string, Set<string>>();
  for (const row of group) for (const identifier of row.identifiers) { let values = external.get(identifier.provider); if (!values) external.set(identifier.provider, values = new Set()); values.add(identifier.external_id); }
  if ([...external.values()].some(values => values.size > 1)) return null;
  for (const row of group) for (const source of row.sources) {
    if (!source.original_name) continue;
    const episode = row.type === 'series' ? parseEpisodeTitle(cleanMediaTitle(source.original_name, {}, false).title) : null;
    const label = cleanMediaTitle(episode?.title || source.original_name);
    if (normalizeTitle(label.title) !== first.normalized || label.year != null && (row.year == null || label.year !== Number(row.year))) return null;
  }
  if (first.type === 'series') {
    if (group.some(row => row.sources.some(source => !source.episode_id || source.episode_title !== row.id || !Number.isInteger(Number(source.season)) || Number(source.season) < 0 || !Number.isInteger(Number(source.number)) || Number(source.number) < 1))) return null;
    return first.year != null ? 'same-release' : 'numbered-series';
  }
  if (group.some(row => row.sources.some(source => source.episode_id))) return null;
  if (first.year != null) return 'same-release';
  // Repeated references to exactly the same stream are the same undated identity.
  if (new Set(group.flatMap(row => row.sources.map(source => source.url_hash))).size === 1) return 'same-stream';
  const seen = new Set<string>();
  for (const row of group) {
    const languages = new Set(row.sources.map(source => normalizeLanguage(source.language) || cleanMediaTitle(source.original_name || row.name).language));
    if (languages.has(null) || languages.has('mul') || !languages.size || [...languages].some(language => seen.has(language!))) return null;
    for (const language of languages) seen.add(language!);
  }
  return seen.size > 1 ? 'language-versions' : null;
}
/** Exact names plus release/episode/language evidence; artwork never supplies identity. */
export async function previewCatalogConsolidation(db: DB): Promise<ConsolidationPreview> {
  const rows = await db.all("SELECT t.id,t.name,t.normalized,t.type,t.year,t.published,t.created_at FROM titles t JOIN (SELECT type,normalized,COALESCE(year,0) AS release_year FROM titles WHERE type IN ('movie','series') GROUP BY type,normalized,COALESCE(year,0) HAVING COUNT(*)>1) duplicate ON duplicate.type=t.type AND duplicate.normalized=t.normalized AND duplicate.release_year=COALESCE(t.year,0) ORDER BY t.type,t.normalized,t.year,t.published DESC,t.created_at,t.id");
  const groups = new Map<string, Identity[]>();
  for (const row of await identities(db, rows)) { const key = JSON.stringify([row.type,row.normalized,row.year == null ? null : Number(row.year)]); const family = groups.get(key) || []; family.push(row); groups.set(key, family); }
  const result: ConsolidationPreview = { groups: [], mergeCount: 0, uncertainGroups: 0 };
  for (const family of groups.values()) {
    const reason = family.length <= 40 ? proof(family) : null;
    if (!reason) { result.uncertainGroups++; continue; }
    result.groups.push({ titleIds: family.map(row => row.id), fingerprints: family.map(fingerprint), reason }); result.mergeCount += family.length - 1;
  }
  return result;
}
/** Recheck reviewed identities inside short transactions; redirects retain saved links and progress. */
export async function applyCatalogConsolidation(db: DB, plan: ConsolidationPreview, onProgress?: (report: { merged: number; skippedGroups: number }) => void | Promise<void>) {
  let merged = 0, skippedGroups = 0;
  for (const group of plan.groups) {
    await db.transaction(async tx => {
      const rows = await tx.all(`SELECT id,name,normalized,type,year,published,created_at FROM titles WHERE id IN (${group.titleIds.map(() => '?').join(',')}) ORDER BY id` + (tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), group.titleIds);
      const byId = new Map((await identities(tx, rows)).map(row => [row.id, row]));
      const current = group.titleIds.map(titleId => byId.get(titleId));
      if (current.some((row, index) => !row || fingerprint(row) !== group.fingerprints[index]) || !proof(current as Identity[])) { skippedGroups++; return; }
      const target = current[0]!;
      for (const from of current.slice(1) as Identity[]) if (await automaticMergeConflict(tx, from, target)) { skippedGroups++; return; }
      for (const from of current.slice(1) as Identity[]) { await mergeTitles(tx, from.id, target.id, { automatic: true }); merged++; }
    });
    await onProgress?.({ merged, skippedGroups });
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { merged, skippedGroups };
}
