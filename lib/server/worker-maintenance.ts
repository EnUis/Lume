import { databaseConnectionFailure } from './database-errors';

interface MaintenanceTask { name: string; run: () => Promise<unknown>; }
interface MaintenanceOptions { now?: () => number; intervalMs?: number; retryMs?: number; maxRetryMs?: number; }

/** One bounded maintenance pass at a time; each stage has its own retry clock. */
export function createWorkerMaintenance(tasks: MaintenanceTask[], report: (name: string, error: unknown) => void, options: MaintenanceOptions = {}) {
  const now = options.now || Date.now, interval = options.intervalMs ?? 60000, retry = options.retryMs ?? 15000, maximum = options.maxRetryMs ?? 300000;
  const states = tasks.map(task => ({ ...task, due: 0, failures: 0 }));
  let pending: Promise<void> | undefined, stopped = false;
  return {
    requestStop() { stopped = true; },
    tick() {
      if (stopped || pending) return pending || Promise.resolve();
      pending = (async () => {
        for (const task of states) {
          if (stopped || task.due > now()) continue;
          try { await task.run(); task.failures = 0; task.due = now() + interval; }
          catch (error) {
            task.failures++;
            task.due = now() + Math.min(maximum, retry * 2 ** Math.min(8, task.failures - 1));
            report(task.name, error);
          }
        }
      })();
      void pending.then(() => { pending = undefined; }, () => { pending = undefined; });
      return pending;
    },
    async stop() { stopped = true; await pending; },
  };
}

/** Retry temporary database trouble, while genuine code/schema errors remain visible. */
export function transientWorkerError(error: unknown): boolean {
  if (databaseConnectionFailure(error)) return true;
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const detail = error as { code?: string; cause?: unknown };
    if (/^(?:08[0-9A-Z]{3}|57014|55P03|53300|57P0[123]|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)$/.test(detail.code || '')) return true;
    error = detail.cause;
  }
  return false;
}

export function workerRetryDelay(failures: number) { return Math.min(30000, 1000 * 2 ** Math.min(5, Math.max(0, failures - 1))); }
export async function connectWorkerDatabase<T>(open: () => Promise<T>, options: { stopped: () => boolean; pause: (milliseconds: number) => Promise<void>; report: (error: unknown) => void; once?: boolean }): Promise<T | null> {
  let failures = 0;
  while (!options.stopped()) {
    try { return await open(); }
    catch (error) {
      if (options.once || !transientWorkerError(error)) throw error;
      options.report(error); await options.pause(workerRetryDelay(++failures));
    }
  }
  return null;
}
