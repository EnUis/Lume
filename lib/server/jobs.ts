import type { DB, Row } from './db';
import { id, sanitizeError } from './security';
import { playlistRetryAt } from './playlist-errors';

export async function enqueue(db: DB, type: 'sync' | 'health' | 'metadata', payload: Record<string, unknown>, options: { runAfter?: number; dedupeKey?: string; expedite?: boolean } = {}): Promise<string> {
  const jobId = id(), now = Date.now();
  await db.run("INSERT INTO jobs(id,type,payload,status,run_after,created_at,dedupe_key) VALUES(?,?,?,'queued',?,?,?) ON CONFLICT DO NOTHING", [jobId, type, JSON.stringify(payload), options.runAfter ?? now, now, options.dedupeKey || null]);
  if (options.dedupeKey) {
    const existing = await db.get("SELECT id,status,attempts,max_attempts FROM jobs WHERE dedupe_key=? AND status IN ('queued','running')", [options.dedupeKey]);
    if (existing?.status === 'queued' && Number(existing.attempts) >= Number(existing.max_attempts)) {
      await db.run("UPDATE jobs SET status='failed',completed_at=?,error=COALESCE(error,'Maximum attempts exhausted') WHERE id=? AND status='queued' AND attempts>=max_attempts", [Date.now(), existing.id]);
      return enqueue(db, type, payload, options);
    }
    // Only an explicit administrator action bypasses backoff. A running attempt
    // keeps its payload and lease; scheduled worker scans never expedite retries.
    if (existing && options.expedite && existing.status === 'queued') await db.run("UPDATE jobs SET run_after=?,payload=? WHERE id=? AND status='queued' AND attempts<max_attempts", [options.runAfter ?? Date.now(), JSON.stringify(payload), existing.id]);
    return existing?.id || jobId;
  }
  return jobId;
}
export async function leaseJob(db: DB, owner: string, types?: Array<'sync' | 'health' | 'metadata'>): Promise<Row | null> {
  if (db.dialect === 'postgres') {
    const now = Date.now(), values: unknown[] = [now, now];
    const requestedTypes = types?.length ? [...new Set(types)].sort() : [undefined];
    const heads: string[] = [];
    for (const type of requestedTypes) for (const status of ['queued', 'running']) {
      const condition = status === 'queued' ? 'run_after<=?' : 'lease_until<?';
      heads.push(`head_${heads.length} AS MATERIALIZED (SELECT id,run_after,created_at FROM jobs WHERE status='${status}'${type ? ' AND type=?' : ''} AND ${condition} AND attempts<max_attempts ORDER BY run_after,created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`);
      values.push(...(type ? [type, now] : [now]));
    }
    values.push(owner, now + 120000, now, now);
    // One atomic statement replaces BEGIN, several queue reads, UPDATE, reread
    // and COMMIT. Each queue head still uses its ordered partial index, and
    // SKIP LOCKED lets independent health lanes claim different jobs.
    return await db.get(`WITH exhausted AS (
      UPDATE jobs SET status='failed',completed_at=?,error='Worker lease expired after maximum attempts',lease_owner=NULL,lease_until=NULL
      WHERE id IN (SELECT id FROM jobs WHERE status='running' AND lease_until<? AND attempts>=max_attempts ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED)
      RETURNING id
    ), ${heads.join(',')}, candidate AS MATERIALIZED (
      SELECT id FROM (${heads.map((_head, index) => `SELECT id,run_after,created_at FROM head_${index}`).join(' UNION ALL ')}) queue_heads ORDER BY run_after,created_at,id LIMIT 1
    ) UPDATE jobs j SET status='running',lease_owner=?,lease_until=?,attempts=j.attempts+1
      FROM candidate WHERE j.id=candidate.id AND j.attempts<j.max_attempts
        AND (j.status='queued' AND j.run_after<=? OR j.status='running' AND j.lease_until<?)
      RETURNING j.*`, values) || null;
  }
  return db.transaction(async tx => {
    const now = Date.now();
    // Expired leases can be reclaimed after crashed workers; terminal attempts are surfaced.
    await tx.run("UPDATE jobs SET status='failed',completed_at=?,error='Worker lease expired after maximum attempts',lease_owner=NULL,lease_until=NULL WHERE status='running' AND lease_until<? AND attempts>=max_attempts", [now, now]);
    // An unfiltered worker must also claim unknown types so the worker can surface
    // their unsupported-job failure, preserving the original durable queue behavior.
    const requestedTypes = types?.length ? [...new Set(types)] : [undefined];
    let row: Row | undefined;
    const locking = tx.dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : '';
    // Each indexed queue head is constant work. The old status OR + type IN query
    // sorted every due job before LIMIT, monopolizing SQLite with large imports.
    // PostgreSQL locks these few candidates consistently and skips concurrent claims.
    for (const type of requestedTypes) for (const status of ['queued', 'running']) {
      const condition = status === 'queued' ? 'run_after<=?' : 'lease_until<?';
      const typeCondition = type ? ' AND type=?' : '';
      // SQLite otherwise prefers the legacy status index and sorts the global
      // queue even after ANALYZE. Migration 5 supplies these ordered partial indexes.
      const orderedIndex = !type && tx.dialect === 'sqlite' ? ` INDEXED BY jobs_${status === 'queued' ? 'ready_order' : 'running_order'}` : '';
      const candidate = await tx.get(`SELECT id,run_after,created_at FROM jobs${orderedIndex} WHERE status='${status}'${typeCondition} AND ${condition} AND attempts<max_attempts ORDER BY run_after,created_at LIMIT 1${locking}`, type ? [type, now] : [now]);
      if (candidate && (!row || Number(candidate.run_after) < Number(row.run_after) || Number(candidate.run_after) === Number(row.run_after) && Number(candidate.created_at) < Number(row.created_at))) row = candidate;
    }
    if (!row) return null;
    await tx.run("UPDATE jobs SET status='running',lease_owner=?,lease_until=?,attempts=attempts+1 WHERE id=? AND attempts<max_attempts AND (status='queued' AND run_after<=? OR status='running' AND lease_until<?)", [owner, now + 120000, row.id, now, now]);
    const claimed = await tx.get('SELECT * FROM jobs WHERE id=? AND lease_owner=?', [row.id, owner]); return claimed || null;
  });
}
export async function finishJob(db: DB, job: Row, owner: string, report: Record<string, unknown>) { await db.run("UPDATE jobs SET status='completed',completed_at=?,report=?,error=NULL,lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND status='running' AND attempts=?", [Date.now(), JSON.stringify(report), job.id, owner, Number(job.attempts)]); }
export async function failJob(db: DB, job: Row, owner: string, error: unknown) {
  const retry = Number(job.attempts) < Number(job.max_attempts);
  const now = Date.now(), retryAt = job.type === 'sync' ? playlistRetryAt(error, Number(job.attempts), now) : now + Math.min(3600000, 15000 * 2 ** Math.max(0, Number(job.attempts) - 1)) + Math.floor(Math.random() * 5000);
  await db.transaction(async tx => {
    const updated = await tx.get("UPDATE jobs SET status=?,run_after=?,completed_at=?,error=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND status='running' AND attempts=? RETURNING id", [retry ? 'queued' : 'failed', retryAt, retry ? null : now, sanitizeError(error), job.id, owner, Number(job.attempts)]);
    if (!updated || job.type !== 'sync') return;
    let playlistId: unknown; try { playlistId = JSON.parse(job.payload).playlistId; } catch { return; }
    if (typeof playlistId !== 'string') return;
    // An exhausted attempt must not be immediately recreated by the periodic
    // scheduler. Align its next refresh with backoff without shortening a later date.
    await tx.run('UPDATE playlists SET next_sync=CASE WHEN next_sync IS NULL OR next_sync<? THEN ? ELSE next_sync END WHERE id=?', [retryAt, retryAt, playlistId]);
  });
}
export async function scheduleDueJobs(db: DB) {
  const now = Date.now();
  const playlists = await db.all('SELECT id FROM playlists WHERE enabled=1 AND (next_sync IS NULL OR next_sync<=?) ORDER BY next_sync LIMIT 25', [now]);
  for (const playlist of playlists) await enqueue(db, 'sync', { playlistId: playlist.id }, { dedupeKey: `sync:${playlist.id}` });
  const configured = Number(process.env.HEALTH_INTERVAL_MS || 21600000), interval = Number.isFinite(configured) ? Math.max(300000, configured) : 21600000;
  // Apply retry backoff before LIMIT so cooling or already queued sources cannot
  // monopolize the bounded batch. Existing due/active-dedupe indexes serve this.
  const retryInterval = `CASE WHEN s.health='healthy' THEN ${interval} ${Array.from({ length: 6 }, (_, n) => `WHEN s.failures<=${n + 1} THEN ${Math.min(interval, 300000 * 2 ** n)}`).join(' ')} ELSE ${Math.min(interval, 19200000)} END`;
  // PostgreSQL otherwise infers the untyped subtraction parameter as int4 from
  // the CASE constants, overflowing on a millisecond Unix timestamp.
  const sources = await db.all(`SELECT s.id FROM sources s LEFT JOIN playlists p ON p.id=s.playlist_id WHERE s.enabled=1 AND s.removed=0 AND (s.playlist_id IS NULL OR p.enabled=1) AND (s.last_checked IS NULL OR s.last_checked<? AND s.last_checked<=CAST(? AS BIGINT) - (${retryInterval})) AND NOT EXISTS(SELECT 1 FROM jobs active WHERE active.dedupe_key='health:' || s.id AND active.status IN ('queued','running') AND (active.status='running' OR active.attempts<active.max_attempts)) ORDER BY s.last_checked LIMIT 100`, [now - 300000, now]);
  let healthQueued = 0;
  if (sources.length) {
    await db.transaction(async tx => {
      const keys = sources.map(source => `health:${source.id}`);
      await tx.run(`UPDATE jobs SET status='failed',completed_at=?,error=COALESCE(error,'Maximum attempts exhausted') WHERE dedupe_key IN (${keys.map(() => '?').join(',')}) AND status='queued' AND attempts>=max_attempts`, [now, ...keys]);
      const values = sources.flatMap(source => [id(), JSON.stringify({ sourceId: source.id }), now, now, `health:${source.id}`]);
      // One insert replaces up to 2,000 individual enqueue round trips. A racing
      // scheduler keeps the existing durable lease or retry deadline unchanged.
      const inserted = await tx.all(`INSERT INTO jobs(id,type,payload,status,run_after,created_at,dedupe_key) VALUES ${sources.map(() => "(?,'health',?,'queued',?,?,?)").join(',')} ON CONFLICT DO NOTHING RETURNING id`, values);
      healthQueued = inserted.length;
    });
  }
  await db.run('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at<? ORDER BY expires_at LIMIT 500)', [now]);
  await db.run('DELETE FROM rate_limits WHERE bucket IN (SELECT bucket FROM rate_limits WHERE reset_at<? LIMIT 500)', [now - 86400000]);
  return { playlists: playlists.length, healthQueued };
}
