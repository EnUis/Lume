import type { Source } from './types';
import { languageLabel, normalizeLanguage } from './languages';
export function mediaPosition(time: number, conversion?: Source['conversion']) { return Math.max(0, (Number.isFinite(time) ? time : 0) + (conversion?.startAt || 0)); }
export function mediaDuration(duration: number, conversion?: Source['conversion']) { return conversion?.duration || (Number.isFinite(duration) && duration > 0 ? duration + (conversion?.startAt || 0) : 0); }
export function convertedSeek(position: number, conversion: NonNullable<Source['conversion']>, ranges: { length: number; start(index: number): number; end(index: number): number }) {
  const local = position - conversion.startAt;
  for (let index = 0; index < ranges.length; index++) if (local >= ranges.start(index) && local < ranges.end(index) - 0.1) return { restart: false, local };
  return { restart: true, local: Math.max(0, local) };
}

const healthRank = { healthy: 0, degraded: 1, unknown: 2, unavailable: 3 };

export function isExpiredGrant(source: Pick<Source, 'expiresAt'>, now = Date.now()): boolean {
  return typeof source.expiresAt === 'number' && Number.isFinite(source.expiresAt) && source.expiresAt > 0 && source.expiresAt <= now;
}

/** A single automatic access renewal per episode; explicit user retries reset the budget. */
export class GrantRefreshLimiter {
  private claimed = false;
  claim(sources: Pick<Source, 'expiresAt'>[], now = Date.now()): boolean {
    if (this.claimed || !sources.some(source => isExpiredGrant(source, now))) return false;
    this.claimed = true;
    return true;
  }
  reset() { this.claimed = false; }
}

/** Health is authoritative; priority and successful checks break ties. */
export function rankSources(sources: Source[], compatible?: (source: Source) => boolean, now = Date.now(), explicitRetry = false): Source[] {
  return sources.filter(source => source.enabled && (explicitRetry && source.playbackRetry || !source.playbackBlocked && (source.health === 'healthy' || source.health === 'degraded' && typeof source.lastSuccess === 'number' && source.lastSuccess > 0)) && !!source.url && !isExpiredGrant(source, now) && (!compatible || compatible(source)))
    .sort((a, b) => healthRank[a.health] - healthRank[b.health]
      || b.priority - a.priority
      || (b.lastSuccess ?? 0) - (a.lastSuccess ?? 0)
      || a.id.localeCompare(b.id));
}

export function sourceLanguage(source: Pick<Source, 'language'>): string {
  return normalizeLanguage(source.language) || 'und';
}

export function sourceLanguageChoices(sources: Source[]) {
  const codes = [...new Set(rankSources(sources).map(sourceLanguage))];
  return codes.map(code => ({ code, label: code === 'und' ? 'Original / unspecified' : languageLabel(code) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function chooseLanguageSource(sources: Source[], language?: string | null, compatible?: (source: Source) => boolean): Source | null {
  const ordered = rankSources(sources, compatible);
  const preferred = language === 'und' ? 'und' : normalizeLanguage(language);
  return (preferred ? ordered.find(source => sourceLanguage(source) === preferred) : null) ?? ordered[0] ?? null;
}

export function failoverDecision(sources: Source[], failedId: string, attemptedIds: Iterable<string>, position: number, language?: string) {
  const attempted = new Set(attemptedIds);
  attempted.add(failedId);
  return {
    source: rankSources(sources).find(source => !attempted.has(source.id) && (language === undefined || sourceLanguage(source) === language)) ?? null,
    position: Number.isFinite(position) ? Math.max(0, position) : 0,
    attemptedIds: attempted,
  };
}

export function playbackTransferState(media: { currentTime: number; paused: boolean; ended: boolean } | null, fallbackPosition: number, pending: { position: number; playing: boolean } | null = null) {
  const position = pending?.position ?? (media && Number.isFinite(media.currentTime) ? media.currentTime : fallbackPosition);
  return {
    position: Number.isFinite(position) ? Math.max(0, position) : 0,
    playing: pending?.playing ?? Boolean(media && !media.paused && !media.ended),
  };
}

export function resumeSeekTarget(position: number, duration: number): number | null {
  if (!Number.isFinite(position) || position <= 0 || !Number.isFinite(duration) || duration <= 0) return null;
  return Math.min(position, Math.max(0, duration - 0.2));
}

/** Metadata, seeking, and a play request alone are not evidence of a working stream. */
export class PlaybackSuccessEvidence {
  private baseline: number | null = null;
  private reported = false;
  playing(position: number) { this.baseline = Number.isFinite(position) ? position : null; }
  seeking() { this.baseline = null; }
  advance(position: number, paused: boolean, seeking: boolean): boolean {
    if (this.reported || paused || seeking || this.baseline === null || !Number.isFinite(position) || position - this.baseline < 0.25) return false;
    this.reported = true;
    return true;
  }
}

export function secondsLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = String(rounded % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

export function skipWindow(marker: { introStart?: number; introEnd?: number; recapStart?: number; recapEnd?: number } | null, position: number) {
  if (!marker) return null;
  for (const [label, start, end] of [['Skip recap', marker.recapStart, marker.recapEnd], ['Skip intro', marker.introStart, marker.introEnd]] as const) {
    if (typeof start === 'number' && typeof end === 'number' && start >= 0 && end > start && position >= start && position < end) return { label, end };
  }
  return null;
}

export function preferredSubtitle<T extends { id: string; language?: string }>(tracks: T[], preference: string): T | null {
  const language = preference.trim().toLowerCase();
  if (!language || language === 'off') return null;
  return tracks.find(track => track.language?.toLowerCase() === language)
    ?? tracks.find(track => track.language?.toLowerCase().split('-')[0] === language.split('-')[0])
    ?? null;
}
