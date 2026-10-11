import '../lib/server/env';
import { database } from '../lib/server/db';
import { decrypt, id } from '../lib/server/security';
import { leaseJob, finishJob, failJob, scheduleDueJobs } from '../lib/server/jobs';
import { synchronizePlaylist, checkSource } from '../lib/server/pipeline';
import { enrichTitleMetadata, scheduleMetadataEnrichment } from '../lib/server/metadata';
import { heartbeatWorker } from '../lib/server/import-status';
import { createWorkerLogger } from '../lib/server/worker-log';
import { settleWorkerLanes, workerInterval } from '../lib/server/worker-lifecycle';
import { createWorkerMaintenance, transientWorkerError, workerRetryDelay } from '../lib/server/worker-maintenance';
import { workerJobLanes } from '../lib/server/worker-capacity';
import { createFirstTitleScheduler } from '../lib/server/health-scheduling';

const logger = createWorkerLogger();

async function main() {
  const db = await database(); const owner = `${process.pid}:${id()}`; let stopping = false;
  const firstTitles = createFirstTitleScheduler(db);
  const maintenance = createWorkerMaintenance([
    { name: 'checks', run: () => scheduleDueJobs(db) },
    { name: 'first-titles', run: () => firstTitles() },
    { name: 'metadata', run: () => scheduleMetadataEnrichment(db) },
  ], (name, error) => logger.error(`worker.schedule.${name}.failed`, error));
  const stop = () => { stopping = true; maintenance.requestStop(); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const once = process.argv.includes('--once'); const lanes = workerJobLanes();
  let heartbeat: ReturnType<typeof workerInterval> | undefined;
  async function pause(milliseconds: number) {
    const until = Date.now() + milliseconds;
    while (!stopping && Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(1000, until - Date.now())));
  }
  async function next(types?: Array<'sync' | 'health' | 'metadata'>) {
    if (stopping) return false;
    const job = await leaseJob(db, owner, types); if (!job) return false;
    // A claim already in flight when stopping begins is still settled normally.
    const renew = workerInterval(() => db.run("UPDATE jobs SET lease_until=? WHERE id=? AND lease_owner=? AND status='running'", [Date.now() + 120000, job.id, owner]), 30000, error => logger.error('worker.lease.failed', error, { id: job.id, type: job.type }));
    try {
      const payload = JSON.parse(job.payload); let report: Record<string, unknown>;
      if (job.type === 'sync') {
        const version = payload.versionId ? await db.get('SELECT content_encrypted FROM playlist_versions WHERE id=? AND playlist_id=?', [payload.versionId, payload.playlistId]) : null;
        if (payload.versionId && !version) throw new Error('Recovery version does not exist');
        report = !(await db.get('SELECT id FROM playlists WHERE id=?', [payload.playlistId])) ? { skipped: true, reason: 'Playlist no longer exists' } : await synchronizePlaylist(db, payload.playlistId, undefined, version ? decrypt(version.content_encrypted) : undefined);
      } else if (job.type === 'health') report = await checkSource(db, payload.sourceId);
      else if (job.type === 'metadata') report = await enrichTitleMetadata(db, payload.titleId, { force: payload.force === true });
      else throw new Error('Unsupported durable job type');
      await finishJob(db, job, owner, report); logger.completed({ id: job.id, type: job.type }, report);
    } catch (error) { logger.failed({ id: job.id, type: job.type }, error); await failJob(db, job, owner, error); }
    finally { await renew.stop(); } return true;
  }
  try {
    try { await heartbeatWorker(db, owner); }
    catch (error) { if (!transientWorkerError(error)) throw error; logger.error('worker.heartbeat.failed', error); }
    heartbeat = workerInterval(async () => { try { await heartbeatWorker(db, owner); } finally { logger.flush(); } }, 15000, error => logger.error('worker.heartbeat.failed', error));
    if (once) {
      await maintenance.tick();
      while (!stopping && (await settleWorkerLanes(lanes.map(types => () => next(types)), stop, error => logger.error('worker.consumer.failed', error))).some(Boolean)) {}
      // Surface unsupported durable job types in the explicit one-shot drain.
      while (!stopping && await next()) {}
    } else {
      const consumers = lanes.map(types => async () => {
        let failures = 0;
        while (!stopping) {
          // Long imports and provider metadata requests have dedicated consumers.
          try {
            const worked = await next(types);
            failures = 0;
            if (!worked) await pause(1000);
          } catch (error) {
            if (!transientWorkerError(error)) throw error;
            logger.error('worker.consumer.delayed', error);
            await pause(workerRetryDelay(++failures));
          }
        }
      });
      // Maintenance never holds up the initial consumers or occupies a job lane.
      await settleWorkerLanes([...consumers, async () => { while (!stopping) { await maintenance.tick(); await pause(1000); } }], stop, error => logger.error('worker.consumer.failed', error));
    }
  } finally {
    stop(); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    try { await maintenance.stop(); await heartbeat?.stop(); logger.flush(true); await db.run('DELETE FROM worker_heartbeats WHERE owner=?', [owner]); }
    finally { await db.close(); }
  }
}
main().catch(error => { logger.fatal(error); process.exitCode = 1; });
