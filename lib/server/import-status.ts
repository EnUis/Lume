import type { DB, Row } from './db';
import { playableSQL } from './catalog';
import { describePlaylistError } from './playlist-errors';
import { workerError } from './worker-log';

export async function heartbeatWorker(db: DB, owner: string, now = Date.now()) {
  await db.run('INSERT INTO worker_heartbeats(owner,last_seen) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET last_seen=excluded.last_seen', [owner, now]);
  await db.run('DELETE FROM worker_heartbeats WHERE last_seen<?', [now - 86400000]);
}
export async function workerStatus(db: DB, now = Date.now()) {
  const row = await db.get('SELECT MAX(last_seen) AS last_seen FROM worker_heartbeats');
  const lastHeartbeat = row?.last_seen == null ? null : Number(row.last_seen);
  const waiting = await db.get("SELECT COUNT(*) AS count FROM jobs WHERE status='queued' AND run_after<=? AND attempts<max_attempts", [now]);
  return { online: lastHeartbeat !== null && lastHeartbeat >= now - 60000, lastHeartbeat, unclaimedJobs: Number(waiting?.count || 0) };
}
export async function playlistImportStates(db: DB, playlists: Row[], now = Date.now()) {
  const counts = await db.all(`SELECT s.playlist_id,COUNT(*) AS source_count,
    SUM(CASE WHEN s.last_checked>=? THEN 1 ELSE 0 END) AS recently_checked_count,
    SUM(CASE WHEN s.enabled=0 THEN 1 ELSE 0 END) AS disabled_count,
    SUM(CASE WHEN s.enabled=1 AND s.health='unknown' AND s.playback_blocked=0 THEN 1 ELSE 0 END) AS pending_count,
    SUM(CASE WHEN s.enabled=1 AND (s.health IN ('unavailable','degraded') OR s.playback_blocked=1) THEN 1 ELSE 0 END) AS unavailable_count
    FROM sources s
    WHERE s.removed=0 AND s.playlist_id IS NOT NULL GROUP BY s.playlist_id`, [now - 600000]);
  const visibleSource = `t.published=1 AND t.type IN ('movie','series','live') AND ((t.type='series' AND s.episode_id IS NOT NULL) OR (t.type<>'series' AND s.episode_id IS NULL))`;
  const playableCounts = await db.all(`SELECT s.playlist_id,COUNT(*) AS playable_count,
    SUM(CASE WHEN ${visibleSource} THEN 1 ELSE 0 END) AS catalog_source_count,
    COUNT(DISTINCT CASE WHEN ${visibleSource} THEN s.title_id ELSE NULL END) AS visible_count,
    COUNT(DISTINCT CASE WHEN ${visibleSource} AND t.type='movie' THEN s.title_id ELSE NULL END) AS visible_movies,
    COUNT(DISTINCT CASE WHEN ${visibleSource} AND t.type='series' THEN s.title_id ELSE NULL END) AS visible_series,
    COUNT(DISTINCT CASE WHEN ${visibleSource} AND t.type='live' THEN s.title_id ELSE NULL END) AS visible_channels,
    SUM(CASE WHEN t.published<>1 THEN 1 ELSE 0 END) AS unpublished_source_count,
    COUNT(DISTINCT CASE WHEN t.published<>1 THEN s.title_id ELSE NULL END) AS unpublished_title_count,
    SUM(CASE WHEN t.published=1 AND ((t.type='series' AND s.episode_id IS NULL) OR (t.type<>'series' AND s.episode_id IS NOT NULL)) THEN 1 ELSE 0 END) AS misplaced_source_count
    FROM sources s LEFT JOIN playlists p ON p.id=s.playlist_id JOIN titles t ON t.id=s.title_id
    WHERE s.playlist_id IS NOT NULL AND ${playableSQL} GROUP BY s.playlist_id`);
  const reviews = await db.all("SELECT s.playlist_id,COUNT(DISTINCT r.title_id) AS review_count FROM review_queue r JOIN sources s ON s.id=r.source_id WHERE r.status='pending' AND s.removed=0 GROUP BY s.playlist_id");
  const jobs = await db.all("SELECT id,payload,status,created_at,completed_at,run_after,attempts,max_attempts,lease_until,error FROM jobs WHERE type='sync' ORDER BY created_at DESC,id DESC LIMIT 1000");
  const latest = new Map<string, Row>();
  for (const job of jobs) { try { const { playlistId } = JSON.parse(job.payload); if (typeof playlistId === 'string' && !latest.has(playlistId)) latest.set(playlistId, job); } catch {} }
  const countMap = new Map(counts.map(row => [row.playlist_id, row])), playableMap = new Map(playableCounts.map(row => [row.playlist_id, row])), reviewMap = new Map(reviews.map(row => [row.playlist_id, Number(row.review_count)]));
  return new Map(playlists.map(playlist => {
    const count = countMap.get(playlist.id), playable = playableMap.get(playlist.id), job = latest.get(playlist.id);
    const sourceCount = Number(count?.source_count || 0), pendingSourceCount = Number(count?.pending_count || 0), playableSourceCount = Number(playable?.playable_count || 0), unavailableSourceCount = Number(count?.unavailable_count || 0), visibleTitleCount = Number(playable?.visible_count || 0), reviewCount = reviewMap.get(playlist.id) || 0;
    const catalogSourceCount = Number(playable?.catalog_source_count || 0);
    const visibilityBreakdown = { catalogSourceCount, groupedSourceCount: Math.max(0, catalogSourceCount - visibleTitleCount), hiddenVerifiedSourceCount: Math.max(0, playableSourceCount - catalogSourceCount), unpublishedSourceCount: Number(playable?.unpublished_source_count || 0), unpublishedTitleCount: Number(playable?.unpublished_title_count || 0), misplacedSourceCount: Number(playable?.misplaced_source_count || 0), movies: Number(playable?.visible_movies || 0), series: Number(playable?.visible_series || 0), channels: Number(playable?.visible_channels || 0) };
    const disabledSourceCount = Number(count?.disabled_count || 0), recentlyCheckedSourceCount = Number(count?.recently_checked_count || 0);
    const exhausted = !!job && Number(job.attempts) >= Number(job.max_attempts) && (job.status === 'queued' || job.status === 'running' && Number(job.lease_until) <= now);
    const waitingRetry = !!job && (job.status === 'queued' && !exhausted && (Number(job.attempts) > 0 || !!job.error || playlist.health === 'unavailable' && !!playlist.error) || job.status === 'running' && Number(job.lease_until) <= now && !exhausted);
    const savedError = job?.error || (playlist.health === 'unavailable' ? playlist.error : null), playlistError = describePlaylistError(savedError);
    const importStatus = !playlist.enabled ? 'disabled' : exhausted ? 'failed' : waitingRetry ? 'retrying' : job?.status === 'running' ? 'syncing' : job?.status === 'queued' ? 'queued' : job?.status === 'failed' || playlist.health === 'unavailable' ? 'failed' : visibleTitleCount > 0 ? 'ready' : reviewCount > 0 ? 'needs_review' : pendingSourceCount > 0 ? 'awaiting_verification' : sourceCount > 0 && unavailableSourceCount > 0 ? 'failed' : 'idle';
    return [playlist.id, { importStatus, sourceCount, disabledSourceCount, recentlyCheckedSourceCount, visibilityBreakdown, pendingSourceCount, playableSourceCount, unavailableSourceCount, visibleTitleCount, reviewCount, ...(playlistError ? { playlistError } : {}), ...(job ? { latestSyncJob: { id: job.id, status: exhausted ? 'failed' : job.status, createdAt: Number(job.created_at), runAfter: Number(job.run_after), attempts: Number(job.attempts), maxAttempts: Number(job.max_attempts), completedAt: job.completed_at == null ? null : Number(job.completed_at), ...(job.error ? { error: workerError(job.error) } : {}) } } : {}) }];
  }));
}
