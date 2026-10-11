import type { DB } from './db';

/** Walk a bounded title window, promoting one first check per unseen title. */
export function createFirstTitleScheduler(db: DB) {
  let cursor = '';
  return async () => {
    const titles = await db.all("SELECT id FROM titles WHERE published=1 AND type IN ('movie','series','live') AND id>? ORDER BY id LIMIT 1000", [cursor]);
    if (!titles.length) { cursor = ''; return { scanned: 0, promoted: 0 }; }
    const now = Date.now();
    const eligible = await db.all(`SELECT job_id FROM (
      SELECT j.id AS job_id,ROW_NUMBER() OVER (PARTITION BY s.title_id ORDER BY CASE WHEN s.format IN ('mp4','webm') THEN 0 WHEN s.format IN ('hls','dash') THEN 1 ELSE 2 END,s.id) AS choice
      FROM sources s JOIN titles t ON t.id=s.title_id LEFT JOIN playlists p ON p.id=s.playlist_id
      JOIN jobs j ON j.dedupe_key='health:' || s.id AND j.status IN ('queued','running')
      WHERE s.title_id IN (${titles.map(() => '?').join(',')})
        AND t.published=1 AND s.enabled=1 AND s.removed=0 AND s.playback_blocked=0
        AND (s.playlist_id IS NULL OR p.enabled=1)
        AND ((t.type='series' AND s.episode_id IS NOT NULL) OR (t.type<>'series' AND s.episode_id IS NULL))
        AND s.health='unknown' AND s.last_checked IS NULL AND s.last_success IS NULL AND s.failures=0
        AND j.type='health' AND j.status='queued' AND j.attempts=0 AND j.run_after<=? AND j.run_after>=j.created_at-1000
        AND NOT EXISTS (SELECT 1 FROM sources working LEFT JOIN playlists wp ON wp.id=working.playlist_id
          WHERE working.title_id=s.title_id AND working.enabled=1 AND working.removed=0 AND working.playback_blocked=0 AND working.health='healthy'
          AND (working.playlist_id IS NULL OR wp.enabled=1)
          AND ((t.type='series' AND working.episode_id IS NOT NULL) OR (t.type<>'series' AND working.episode_id IS NULL)))
        AND NOT EXISTS (SELECT 1 FROM sources reserved JOIN jobs r ON r.dedupe_key='health:' || reserved.id AND r.status IN ('queued','running')
          WHERE reserved.title_id=s.title_id AND r.type='health' AND r.attempts<r.max_attempts
          AND (r.status='running' OR r.status='queued' AND r.attempts=0 AND r.run_after<r.created_at-1000))
    ) choices WHERE choice=1 LIMIT 100`, [...titles.map(title => title.id), now]);
    let promoted = 0;
    if (eligible.length) {
      const head = await db.get("SELECT run_after FROM jobs WHERE type='health' AND status='queued' AND attempts<max_attempts ORDER BY run_after,created_at LIMIT 1");
      // Older enqueue code could introduce millisecond timestamp skew. A full
      // minute marks a deliberate promotion without mistaking that skew for one.
      const priorityTime = Math.min(now - 60000, Number(head?.run_after ?? now) - 1);
      const updated = await db.all(`UPDATE jobs SET run_after=? WHERE id IN (${eligible.map(() => '?').join(',')}) AND status='queued' AND attempts=0 AND run_after<=? AND run_after>=created_at-1000 RETURNING id`, [priorityTime, ...eligible.map(row => row.job_id), now]);
      promoted = updated.length;
    }
    cursor = titles[titles.length - 1].id;
    return { scanned: titles.length, promoted };
  };
}
