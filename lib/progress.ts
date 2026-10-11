import type { Progress } from './types';
import { api } from './client';

export const GUEST_PROGRESS_KEY = 'luma.progress.v1';
export const PROGRESS_EVENT = 'luma-progress';
const MAX_DURATION = 60 * 60 * 24 * 7;

export function validProgress(value: unknown): value is Progress {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<Progress>;
  return typeof entry.titleId === 'string' && entry.titleId.length > 0 && entry.titleId.length <= 200
    && (entry.episodeId == null || (typeof entry.episodeId === 'string' && entry.episodeId.length > 0 && entry.episodeId.length <= 200))
    && typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration > 0 && entry.duration <= MAX_DURATION
    && typeof entry.position === 'number' && Number.isFinite(entry.position) && entry.position >= 0 && entry.position <= entry.duration
    && typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) && entry.updatedAt > 0 && entry.updatedAt <= Date.now() + 60_000;
}

export function progressKey(entry: Pick<Progress, 'titleId' | 'episodeId'>) {
  return `${entry.titleId}\u0000${entry.episodeId ?? ''}`;
}

export function mergeProgress(...collections: Progress[][]): Progress[] {
  const merged = new Map<string, Progress>();
  for (const entry of collections.flat()) {
    if (!validProgress(entry)) continue;
    const previous = merged.get(progressKey(entry));
    if (!previous || entry.updatedAt > previous.updatedAt) merged.set(progressKey(entry), { ...entry, episodeId: entry.episodeId ?? null });
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500);
}

export function readGuestProgress(): Progress[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(GUEST_PROGRESS_KEY) ?? '[]');
    return Array.isArray(parsed) ? mergeProgress(parsed as Progress[]) : [];
  } catch { return []; }
}

function notifyProgress() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PROGRESS_EVENT));
}

export function saveGuestProgress(entry: Progress): boolean {
  if (typeof window === 'undefined' || !validProgress(entry)) return false;
  try {
    window.localStorage.setItem(GUEST_PROGRESS_KEY, JSON.stringify(mergeProgress(readGuestProgress(), [entry])));
    notifyProgress();
    return true;
  } catch { return false; }
}

export function clearGuestProgress(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(GUEST_PROGRESS_KEY); notifyProgress(); } catch { /* Storage can be disabled. */ }
}

/** Call only after the viewer explicitly agrees to transfer guest history. */
export async function migrateGuestProgress(): Promise<number> {
  const snapshot = readGuestProgress();
  if (!snapshot.length) return 0;
  let migrated = 0;
  const confirmed: Progress[] = [];
  for (let start = 0; start < snapshot.length; start += 300) {
    const batch = snapshot.slice(start, start + 300);
    const result = await api<{ migrated?: number }>('/progress/migrate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: batch }),
    });
    const accepted = typeof result.migrated === 'number' && Number.isFinite(result.migrated) ? Math.min(batch.length, Math.max(0, result.migrated)) : 0;
    migrated += accepted;
    // A partial result does not identify rejected entries: retain the batch rather than lose history.
    if (accepted === batch.length) confirmed.push(...batch);
  }
  // Keep progress written by another tab while the request was in flight.
  const transferred = new Map(confirmed.map(entry => [progressKey(entry), entry.updatedAt]));
  const remaining = readGuestProgress().filter(entry => !transferred.has(progressKey(entry)) || entry.updatedAt > transferred.get(progressKey(entry))!);
  try {
    window.localStorage.setItem(GUEST_PROGRESS_KEY, JSON.stringify(remaining));
    notifyProgress();
  } catch { /* Server transfer succeeded even when browser storage is inaccessible. */ }
  return migrated;
}
