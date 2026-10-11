/** Stop future claims on the first fatal lane failure, then drain active lanes. */
export async function settleWorkerLanes<T>(lanes: Array<() => Promise<T>>, stop: () => void, report?: (error: unknown) => void): Promise<T[]> {
  let failed = false; let firstFailure: unknown;
  const results = await Promise.allSettled(lanes.map(async lane => {
    try { return await lane(); }
    catch (error) {
      if (!failed) { failed = true; firstFailure = error; }
      stop(); report?.(error); throw error;
    }
  }));
  if (failed) throw firstFailure;
  return results.map(result => (result as PromiseFulfilledResult<T>).value);
}

/** At most one timer write runs at a time; shutdown awaits an already started write. */
export function workerInterval(task: () => Promise<unknown>, intervalMs: number, report: (error: unknown) => void) {
  let pending: Promise<void> | undefined; let stopped = false;
  const timer = setInterval(() => {
    if (stopped || pending) return;
    pending = Promise.resolve().then(task).then(() => {}, report);
    // Attach the rejection handler immediately, even if an error reporter fails.
    void pending.then(() => { pending = undefined; }, () => { pending = undefined; });
  }, intervalMs);
  return { async stop() { stopped = true; clearInterval(timer); await pending; } };
}
