import { sanitizeError } from './security';
import { databaseConnectionFailure } from './database-errors';

type JobReference = { id: string; type: string };
type LogOptions = { level?: string; now?: () => number; output?: (line: string) => void; error?: (line: string) => void };
type RepeatedFailure = { event: string; message: string; jobType?: string; since: number; repeated: number };
const NOTICE_INTERVAL_MS = 60000;
const MAX_FAILURE_GROUPS = 256;
const reportFields = ['ok', 'health', 'format', 'quality', 'latencyMs', 'skipped', 'added', 'updated', 'removed', 'unchanged', 'repaired', 'reviews', 'valid', 'processed', 'batches', 'starterChecks', 'identityComparisons', 'contentChanged', 'restored'];

export function workerError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Do not print payloads, provider URLs, connection strings or credential headers,
  // including their JSON/colon forms. Preserve the useful reason for the failure.
  return sanitizeError(message
    .replace(/\bgetaddrinfo (ENOTFOUND|EAI_AGAIN)\s+[^\s]+/gi, 'Database address lookup failed ($1)')
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, '[redacted source]')
    .replace(/\b(?:Bearer|Basic)\s+[a-z\d._~+\/-]+=*/gi, '[redacted credentials]')
    .replace(/\b(password|passwd|pwd|token|api[-_ ]?key|secret|authorization|cookie|session)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/\u001b\[[\d;]*[a-z]/gi, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' '));
}

function providerAccessDenied(type: string, message: string) {
  return type === 'sync' && /^Playlist HTTP (?:401|403)\b/.test(message)
    || type === 'health' && /^Upstream HTTP (?:401|403)\b/.test(message)
    || type === 'metadata' && /^Licensed metadata provider returned HTTP (?:401|403)\b/.test(message);
}

export function createWorkerLogger(options: LogOptions = {}) {
  const diagnostic = (options.level ?? process.env.WORKER_LOG_LEVEL) === 'diagnostic';
  const now = options.now ?? Date.now; const output = options.output ?? console.log; const stderr = options.error ?? console.error;
  const failures = new Map<string, RepeatedFailure>();
  const context = (event: string, jobType?: string) => event === 'job.failed' ? `${jobType === 'sync' ? 'Playlist import' : jobType === 'health' ? 'Stream verification' : jobType === 'metadata' ? 'Metadata update' : 'Background job'} failed`
    : event === 'worker.heartbeat.failed' ? 'Worker heartbeat failed'
    : event.startsWith('worker.schedule.') ? 'Background scheduling delayed'
    : event === 'worker.consumer.delayed' ? 'Background processing delayed'
    : event === 'worker.lease.failed' ? 'Worker lease renewal failed' : 'Background worker failed';
  const notice = (failure: RepeatedFailure, summary = false) => stderr(`${context(failure.event, failure.jobType)}: ${failure.message}${summary ? ` (${failure.repeated} repeated failures since the previous notice)` : ''}`);
  function flush(all = false) {
    if (diagnostic) return;
    const time = now();
    for (const failure of failures.values()) if (failure.repeated && (all || time - failure.since >= NOTICE_INTERVAL_MS)) {
      notice(failure, true); failure.since = time; failure.repeated = 0;
    }
  }
  function failure(event: string, error: unknown, job?: JobReference, fatal = false) {
    let message = workerError(error); const time = now();
    if (diagnostic) { stderr(JSON.stringify({ event, ...(job ? { jobId: workerError(job.id), type: workerError(job.type) } : {}), error: message, time })); return; }
    if (databaseConnectionFailure(error)) {
      // All affected consumers share one outage notice instead of flooding the
      // terminal with heartbeat, claim, job, and lease errors for the same outage.
      event = 'worker.database.delayed'; job = undefined; fatal = false;
      message = 'Database connection is temporarily unavailable. Background work will retry automatically.';
    }
    if (!fatal && event === 'job.failed' && job && providerAccessDenied(job.type, message)) return;
    const state: RepeatedFailure = { event, message, jobType: job?.type, since: time, repeated: 0 };
    if (fatal) { notice(state); return; }
    const key = JSON.stringify([event, job?.type, message]); const previous = failures.get(key);
    if (previous) {
      previous.repeated++;
      if (time - previous.since >= NOTICE_INTERVAL_MS) { notice(previous, true); previous.since = time; previous.repeated = 0; }
      return;
    }
    if (failures.size >= MAX_FAILURE_GROUPS) {
      const oldest = failures.keys().next().value!; const evicted = failures.get(oldest)!;
      if (evicted.repeated) notice(evicted, true); failures.delete(oldest);
    }
    failures.set(key, state); notice(state);
  }
  return {
    completed(job: JobReference, report: Record<string, unknown>) {
      if (!diagnostic) return;
      const safeReport: Record<string, unknown> = {};
      for (const field of reportFields) {
        const value = report[field];
        if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) safeReport[field] = value;
        else if (typeof value === 'string') safeReport[field] = workerError(value);
      }
      if (report.error) safeReport.error = workerError(report.error);
      output(JSON.stringify({ event: 'job.completed', jobId: workerError(job.id), type: workerError(job.type), report: safeReport, time: now() }));
    },
    failed: (job: JobReference, error: unknown) => failure('job.failed', error, job),
    error: (event: string, error: unknown, job?: JobReference) => failure(event, error, job),
    fatal: (error: unknown) => failure('worker.failed', error, undefined, true),
    flush,
  };
}
