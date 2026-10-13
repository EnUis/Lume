export type WorkerJobType = 'sync' | 'metadata' | 'health';

/** HTTP checks can overlap; expensive media probes have their own smaller gate. */
export function workerJobLanes(configured = process.env.HEALTH_CONCURRENCY): WorkerJobType[][] {
  const parsed = Number(configured || 8);
  const checks = Number.isFinite(parsed) ? Math.max(1, Math.min(16, Math.floor(parsed))) : 8;
  return [['sync'], ['metadata'], ...Array.from({ length: checks }, (): WorkerJobType[] => ['health'])];
}
