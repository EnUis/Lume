import type { DB, Row } from './db';
import type { PlaylistEntry } from './m3u';
import { hash, id } from './security';

const MIN_UNRELATED_MOVIES = 8;
// Legacy imports can contain one row per episode under the movie type. Their
// shared show poster is legitimate even before episode consolidation runs.
function artworkIdentity(normalized: string) { return normalized.replace(/\s+(?:s\d{1,2}|season\s+\d{1,2})\b.*$/i, '').trim(); }
/** A logo reused for many different films is provider decoration, not cover art. */
export function genericPlaylistArtwork(entries: Pick<PlaylistEntry, 'type' | 'normalized' | 'poster'>[]): Set<string> {
  const identities = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.type !== 'movie' || !entry.poster || !entry.normalized) continue;
    let names = identities.get(entry.poster); if (!names) identities.set(entry.poster, names = new Set());
    names.add(artworkIdentity(entry.normalized));
  }
  return new Set([...identities].filter(([, names]) => names.size >= MIN_UNRELATED_MOVIES).map(([poster]) => poster));
}
export interface ArtworkRepairCandidate { titleId: string; poster: string; backdrop: string; fingerprint: string }
/** Read-only plan. Confirmed metadata, channel logos and administrator edits are protected. */
export async function previewGenericArtworkRepair(db: DB): Promise<ArtworkRepairCandidate[]> {
  const shared = await db.all("SELECT poster FROM titles WHERE type='movie' AND TRIM(poster)<>'' GROUP BY poster HAVING COUNT(DISTINCT normalized)>=?", [MIN_UNRELATED_MOVIES]);
  const plan: ArtworkRepairCandidate[] = [];
  for (const batchStart of Array.from({ length: Math.ceil(shared.length / 100) }, (_, index) => index * 100)) {
    const posters = shared.slice(batchStart, batchStart + 100).map(row => row.poster);
    const rows = await db.all(`SELECT t.id,t.name,t.normalized,t.type,t.poster,t.backdrop,t.updated_at FROM titles t WHERE t.type IN ('movie','series') AND t.poster IN (${posters.map(() => '?').join(',')}) AND NOT EXISTS(SELECT 1 FROM title_metadata_locks l WHERE l.title_id=t.id) AND NOT EXISTS(SELECT 1 FROM metadata_lookups m WHERE m.title_id=t.id AND m.status='matched' AND m.result LIKE '%"poster"%')`, posters);
    const confirmed = genericPlaylistArtwork(rows.map(row => ({ type: row.type, normalized: row.normalized, poster: row.poster })));
    for (const row of rows) if (confirmed.has(row.poster)) plan.push({ titleId: row.id, poster: row.poster, backdrop: row.backdrop, fingerprint: artworkFingerprint(row) });
  }
  return plan;
}
function artworkFingerprint(row: Row) { return hash(JSON.stringify([row.id, row.name, row.type, row.poster, row.backdrop, Number(row.updated_at)])); }
/** Bounded transactions leave the library usable while removing confirmed generic imports. */
export async function applyGenericArtworkRepair(db: DB, plan: ArtworkRepairCandidate[]) {
  let repaired = 0, skipped = 0;
  for (let start = 0; start < plan.length; start += 50) {
    await db.transaction(async tx => {
      const batch = plan.slice(start, start + 50), ids = batch.map(item => item.titleId), placeholders = ids.map(() => '?').join(',');
      const rows = await tx.all(`SELECT id,name,type,poster,backdrop,updated_at FROM titles WHERE id IN (${placeholders}) ORDER BY id` + (tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), ids);
      const byId = new Map(rows.map(row => [row.id, row]));
      const protectedRows = await tx.all(`SELECT title_id FROM title_metadata_locks WHERE title_id IN (${placeholders}) UNION SELECT title_id FROM metadata_lookups WHERE title_id IN (${placeholders}) AND status='matched' AND result LIKE '%"poster"%'`, [...ids, ...ids]);
      const protectedIds = new Set(protectedRows.map(row => row.title_id));
      const candidates = batch.filter(item => { const current = byId.get(item.titleId); return current && artworkFingerprint(current) === item.fingerprint && !protectedIds.has(item.titleId); });
      skipped += batch.length - candidates.length;
      if (!candidates.length) return;
      const time = Date.now(), changedIds = candidates.map(item => item.titleId), changed = changedIds.map(() => '?').join(',');
      await tx.run(`INSERT INTO audit_log(id,action,entity_id,details,created_at) VALUES ${candidates.map(() => '(?,?,?,?,?)').join(',')}`, candidates.flatMap(item => [id(), 'title.generic-artwork.remove', item.titleId, JSON.stringify({ poster: item.poster, backdrop: item.backdrop, reason: 'Provider image reused across unrelated movie identities' }), time]));
      await tx.run(`UPDATE titles SET backdrop=CASE WHEN backdrop=poster THEN '' ELSE backdrop END,poster='',updated_at=? WHERE id IN (${changed})`, [time, ...changedIds]);
      // Reconsider missing artwork even when a generic cover produced a no-match cooldown.
      await tx.run(`UPDATE metadata_lookups SET retry_after=0 WHERE title_id IN (${changed}) AND status IN ('matched','no-match','failed','queued')`, changedIds);
      repaired += candidates.length;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { repaired, skipped };
}
