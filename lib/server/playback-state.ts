import type { DB } from './db';

// Source insertions/replacements and playback failure propagation share a URL
// transaction lock, preventing a new duplicate from escaping an in-flight block.
export async function lockPlaybackUrl(db: DB, urlHash: string) {
  if (db.dialect === 'postgres') await db.run('SELECT pg_advisory_xact_lock(?,?)', [parseInt(urlHash.slice(0, 8), 16) | 0, parseInt(urlHash.slice(8, 16), 16) | 0]);
}

export async function existingPlaybackBlock(db: DB, urlHash: string) {
  await lockPlaybackUrl(db, urlHash);
  return db.get('SELECT playback_blocked_at,error,failures FROM sources WHERE url_hash=? AND playback_blocked=1 ORDER BY playback_blocked_at DESC NULLS LAST LIMIT 1', [urlHash]);
}
