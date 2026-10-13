import type { DB } from './db';

/** Skip already-visible windows promptly without monopolizing database maintenance. */
export function createFirstTitleScheduler(db: DB, options: { maxWindows?: number; maxPromotions?: number; timeBudgetMs?: number } = {}) {
  const bounded = (value: number | undefined, fallback: number, maximum: number) => Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;
  const maxWindows = bounded(options.maxWindows, 8, 16);
  const maxPromotions = bounded(options.maxPromotions, 400, 1000);
  const timeBudgetMs = bounded(options.timeBudgetMs, 250, 1000);
  let cursor = '';
  return async () => {
    const now = Date.now();
    const started = performance.now();
    let scanned = 0; let promoted = 0; let priorityTime: number | undefined;
    for (let window = 0; window < maxWindows && promoted < maxPromotions; window++) {
      // Always allow one window; a slow query should not prevent cursor progress.
      if (window && performance.now() - started >= timeBudgetMs) break;
      const titles = await db.all("SELECT id FROM titles WHERE published=1 AND type IN ('movie','series','live') AND id>? ORDER BY id LIMIT 1000", [cursor]);
      if (!titles.length) { cursor = ''; break; }
      const limit = Math.min(100, maxPromotions - promoted);
      const eligible = await db.all(`SELECT job_id,title_id FROM (
      SELECT j.id AS job_id,s.title_id,ROW_NUMBER() OVER (PARTITION BY s.title_id ORDER BY CASE WHEN s.format IN ('mp4','webm') THEN 0 WHEN s.format IN ('hls','dash') THEN 1 ELSE 2 END,s.id) AS choice
      FROM sources s JOIN titles t ON t.id=s.title_id LEFT JOIN playlists p ON p.id=s.playlist_id
      JOIN jobs j ON j.dedupe_key='health:' || s.id AND j.status IN ('queued','running')
      WHERE s.title_id IN (${titles.map(() => '?').join(',')})
        AND t.published=1 AND s.enabled=1 AND s.removed=0 AND s.playback_blocked=0
        AND (s.playlist_id IS NULL OR p.enabled=1)
        AND ((t.type='series' AND s.episode_id IS NOT NULL) OR (t.type<>'series' AND s.episode_id IS NULL))
        AND s.health='unknown' AND s.last_checked IS NULL AND s.last_success IS NULL AND s.failures=0
        AND j.type='health' AND j.status='queued' AND j.attempts=0 AND j.attempts<j.max_attempts AND j.run_after<=? AND j.run_after>=j.created_at-1000
        AND NOT EXISTS (SELECT 1 FROM sources working LEFT JOIN playlists wp ON wp.id=working.playlist_id
          WHERE working.title_id=s.title_id AND working.enabled=1 AND working.removed=0 AND working.playback_blocked=0 AND working.health='healthy'
          AND (working.playlist_id IS NULL OR wp.enabled=1)
          AND ((t.type='series' AND working.episode_id IS NOT NULL) OR (t.type<>'series' AND working.episode_id IS NULL)))
        AND NOT EXISTS (SELECT 1 FROM sources reserved JOIN jobs r ON r.dedupe_key='health:' || reserved.id AND r.status IN ('queued','running')
          WHERE reserved.title_id=s.title_id AND r.type='health' AND r.attempts<r.max_attempts
          AND (r.status='running' OR r.status='queued' AND r.attempts=0 AND r.run_after<r.created_at-1000))
    ) choices WHERE choice=1 ORDER BY title_id LIMIT ?`, [...titles.map(title => title.id), now, limit]);
      if (eligible.length) {
        if (priorityTime === undefined) {
          const head = await db.get("SELECT run_after FROM jobs WHERE type='health' AND status='queued' AND attempts<max_attempts ORDER BY run_after,created_at LIMIT 1");
          // Millisecond enqueue skew is not deliberate first-title priority.
          priorityTime = Math.min(now - 60000, Number(head?.run_after ?? now) - 1);
        }
        const updated = await db.all(`UPDATE jobs SET run_after=? WHERE id IN (${eligible.map(() => '?').join(',')}) AND status='queued' AND attempts=0 AND attempts<max_attempts AND run_after<=? AND run_after>=created_at-1000 RETURNING id`, [priorityTime, ...eligible.map(row => row.job_id), now]);
        promoted += updated.length;
      }
      // When the promotion cap cuts a window short, resume immediately after
      // its last candidate instead of skipping eligible titles for a full lap.
      cursor = eligible.length === limit ? eligible[eligible.length - 1].title_id : titles[titles.length - 1].id;
      scanned += titles.filter(title => title.id <= cursor).length;
      if (eligible.length < limit && titles.length < 1000) { cursor = ''; break; }
    }
    return { scanned, promoted };
  };
}
