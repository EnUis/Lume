/** Back off repeated worker crashes, but reset after a stable minute. */
export function workerRestart(previousFailures, uptimeMs) {
  const failures = uptimeMs >= 60000 ? 1 : previousFailures + 1;
  return { failures, delayMs: Math.min(60000, 5000 * 2 ** Math.min(4, failures - 1)) };
}
