import type { DB, Row } from './db';

/** Use the same two-key locks as playback reports, in the same URL hash order. */
export async function lockImportUrls(db: DB, hashes: string[]) {
  if (db.dialect !== 'postgres' || !hashes.length) return;
  const ordered = [...new Set(hashes)].sort();
  // The subquery materializes the ordering before evaluating the volatile lock
  // function. One round trip replaces one round trip for every source URL.
  await db.run(`SELECT pg_advisory_xact_lock(hi,lo) FROM (SELECT * FROM (VALUES ${ordered.map((_hash, index) => `(${index},CAST(? AS INTEGER),CAST(? AS INTEGER))`).join(',')}) AS locks(position,hi,lo) ORDER BY position OFFSET 0) AS ordered_locks`, ordered.flatMap(hash => [parseInt(hash.slice(0, 8), 16) | 0, parseInt(hash.slice(8, 16), 16) | 0]));
}

/** Read only after taking the URL locks, so an in-flight playback block wins. */
export async function importPlaybackBlocks(db: DB, hashes: string[]) {
  const unique = [...new Set(hashes)], blocks = new Map<string, Row>();
  if (!unique.length) return blocks;
  // Each URL uses the indexed LIMIT 1 lookup, even when thousands of imported
  // references share it. Return at most one row per URL rather than all copies.
  for (const row of await db.all(`WITH requested(url_hash) AS (VALUES ${unique.map(() => '(?)').join(',')}) SELECT s.url_hash,s.error,s.playback_blocked_at,s.last_failure,s.failures FROM requested r JOIN sources s ON s.id=(SELECT candidate.id FROM sources candidate WHERE candidate.url_hash=r.url_hash AND candidate.playback_blocked=1 ORDER BY candidate.playback_blocked_at DESC NULLS LAST LIMIT 1)`, unique)) blocks.set(row.url_hash, row);
  return blocks;
}

/** Callers supply static identifiers and at most one bounded import batch. */
export async function insertImportRows(db: DB, table: string, columns: string[], rows: unknown[][], ignoreConflicts = false) {
  if (!rows.length) return;
  if (![table, ...columns].every(name => /^[a-z_]+$/.test(name)) || rows.some(row => row.length !== columns.length)) throw new Error('Invalid import batch');
  const tuple = `(${columns.map(() => '?').join(',')})`;
  await db.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES${rows.map(() => tuple).join(',')}${ignoreConflicts ? ' ON CONFLICT DO NOTHING' : ''}`, rows.flat());
}
