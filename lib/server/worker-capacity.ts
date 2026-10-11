export type WorkerJobType = 'sync' | 'metadata' | 'health';

/** Imports and metadata never borrow a stream-check slot. Match ffprobe's cap. */
export function workerJobLanes(configured = process.env.HEALTH_CONCURRENCY): WorkerJobType[][] {
  const parsed = Number(configured || 4);
  const checks = Number.isFinite(parsed) ? Math.max(1, Math.min(4, Math.floor(parsed))) : 4;
  return [['sync'], ['metadata'], ...Array.from({ length: checks }, (): WorkerJobType[] => ['health'])];
}
