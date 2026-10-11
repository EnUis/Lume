import type { DB, Row } from './db';
import { availableTitleSQL } from './catalog';
import { playlistImportStates, workerStatus } from './import-status';

function storedObject(value: string, label: string): Row {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Row;
  } catch {}
  return { error: `Stored ${label} could not be read` };
}

async function readOverview(db: DB, mapPlaylist: (row: Row) => Row) {
  const statsRow = await db.get(`SELECT (SELECT COUNT(*) FROM titles WHERE type='movie') AS movies,(SELECT COUNT(*) FROM titles WHERE type='series') AS series,(SELECT COUNT(*) FROM episodes) AS episodes,(SELECT COUNT(*) FROM sources WHERE removed=0) AS sources,(SELECT COUNT(*) FROM sources WHERE health='healthy' AND playback_blocked=0 AND enabled=1 AND removed=0) AS healthy,(SELECT COUNT(*) FROM sources WHERE (health IN ('unavailable','degraded') OR playback_blocked=1) AND removed=0) AS broken,(SELECT COUNT(*) FROM titles t WHERE published=0 OR NOT ${availableTitleSQL}) AS hidden,(SELECT COUNT(*) FROM playlists) AS playlists,(SELECT MAX(last_sync) FROM playlists) AS last_sync,(SELECT MIN(next_sync) FROM playlists WHERE enabled=1) AS next_sync`);
  const stats = { movies: Number(statsRow!.movies), series: Number(statsRow!.series), episodes: Number(statsRow!.episodes), sources: Number(statsRow!.sources), healthySources: Number(statsRow!.healthy), brokenSources: Number(statsRow!.broken), hiddenTitles: Number(statsRow!.hidden), playlists: Number(statsRow!.playlists), lastSync: statsRow!.last_sync ? Number(statsRow!.last_sync) : null, nextSync: statsRow!.next_sync ? Number(statsRow!.next_sync) : null };
  const playlistRows = await db.all('SELECT id,name,enabled,interval_hours,last_sync,next_sync,health,error,entry_count,url_encrypted FROM playlists ORDER BY created_at DESC');
  const importStates = await playlistImportStates(db, playlistRows);
  const playlists = playlistRows.map(row => ({ ...mapPlaylist(row), ...importStates.get(row.id) }));
  const jobs = (await db.all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 30')).map(row => ({ id: row.id, type: row.type, status: row.status, createdAt: Number(row.created_at), completedAt: row.completed_at ? Number(row.completed_at) : undefined, error: row.error, report: row.report ? storedObject(row.report, 'job report') : undefined, attempts: row.attempts }));
  const reviews = (await db.all("SELECT r.*,t.name AS title_name,c.name AS candidate_name FROM review_queue r LEFT JOIN titles t ON t.id=r.title_id LEFT JOIN titles c ON c.id=r.candidate_id WHERE r.status='pending' ORDER BY r.created_at DESC LIMIT 100")).map(row => ({ id: row.id, sourceId: row.source_id, titleId: row.title_id, candidateId: row.candidate_id, reason: row.reason, status: row.status, createdAt: Number(row.created_at), titleName: row.title_name, candidateName: row.candidate_name }));
  const auditRows = (await db.all('SELECT a.*,u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 30')).map(row => ({ id: row.id, actorId: row.actor_id, actorName: row.actor_name, action: row.action, entityId: row.entity_id, details: storedObject(row.details, 'audit details'), createdAt: Number(row.created_at) }));
  return { stats, playlists, jobs, reviews, audit: auditRows, worker: await workerStatus(db) };
}

const pending = new WeakMap<DB, Promise<Awaited<ReturnType<typeof readOverview>>>>();

// Coalesce concurrent polls without caching completed results: a refresh after
// a mutation must read the current state, including health and import changes.
export function adminOverview(db: DB, mapPlaylist: (row: Row) => Row) {
  const existing = pending.get(db);
  if (existing) return existing;
  const request = readOverview(db, mapPlaylist);
  pending.set(db, request);
  void request.then(
    () => { if (pending.get(db) === request) pending.delete(db); },
    () => { if (pending.get(db) === request) pending.delete(db); },
  );
  return request;
}
