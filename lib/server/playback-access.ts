import type { Source } from '../types';
import { safeFetch, validateBrowserSafeUrl, resolvePublicDestination, type SafeFetcher } from './outbound';
import { AppError, sanitizeError } from './security';

export interface PlaybackGrant { url: string; expiresAt: number; }
/** A licensed provider exchanges a private upstream source for a short-lived URL.
 * The browser never receives the private input when the signer is configured. */
export async function requestPlaybackGrant(source: Source, fetcher: SafeFetcher = safeFetch, checkDestination: (url: URL) => Promise<unknown> = resolvePublicDestination): Promise<PlaybackGrant> {
  const endpoint = process.env.PLAYBACK_SIGNER_URL; const token = process.env.PLAYBACK_SIGNER_API_KEY;
  if (!endpoint || !token) throw new AppError(503, 'Playback access provider is not configured');
  if (validateBrowserSafeUrl(endpoint).protocol !== 'https:') throw new AppError(503, 'Playback access provider must use HTTPS');
  const upstream = await fetcher(endpoint, { method: 'POST', body: JSON.stringify({ sourceId: source.id, url: source.url }), headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, maxBytes: 16000, timeoutMs: 10000 });
  if (upstream.status !== 200 || upstream.truncated) throw new AppError(503, 'Playback access provider could not issue access');
  let grant: Record<string, unknown>; try { grant = JSON.parse(upstream.body.toString('utf8')); } catch { throw new AppError(503, 'Playback access provider returned invalid data'); }
  if (!grant || typeof grant !== 'object' || typeof grant.url !== 'string' || typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt)) throw new AppError(503, 'Playback access grant is incomplete');
  const url = validateBrowserSafeUrl(grant.url); if (url.protocol !== 'https:') throw new AppError(503, 'Playback access URL must use HTTPS');
  const now = Date.now(); if (grant.expiresAt < now + 15000 || grant.expiresAt > now + 3600000) throw new AppError(503, 'Playback access URL has an invalid expiry');
  await checkDestination(url); return { url: url.toString(), expiresAt: grant.expiresAt };
}
export async function authorizePlaybackSources(sources: Source[], fetcher: SafeFetcher = safeFetch, checkDestination: (url: URL) => Promise<unknown> = resolvePublicDestination) {
  if (!process.env.PLAYBACK_SIGNER_URL && !process.env.PLAYBACK_SIGNER_API_KEY) {
    if (process.env.REQUIRE_PLAYBACK_SIGNER === 'true') throw new AppError(503, 'Playback access provider is required');
    return sources;
  }
  // Invalid shared configuration blocks the entire request before any grants.
  if (!process.env.PLAYBACK_SIGNER_URL || !process.env.PLAYBACK_SIGNER_API_KEY) throw new AppError(503, 'Playback access provider is not configured');
  try { if (validateBrowserSafeUrl(process.env.PLAYBACK_SIGNER_URL).protocol !== 'https:') throw new Error(); } catch { throw new AppError(503, 'Playback access provider configuration is invalid'); }
  const result: Source[] = [];
  // Bounded batches preserve server ranking and avoid overwhelming the provider.
  for (let start = 0; start < sources.length; start += 4) {
    const batchSources = sources.slice(start, start + 4);
    const batch = await Promise.allSettled(batchSources.map(async source => { const grant = await requestPlaybackGrant(source, fetcher, checkDestination); return { ...source, url: grant.url, expiresAt: grant.expiresAt }; }));
    for (const [index, grant] of batch.entries()) {
      if (grant.status === 'fulfilled') result.push(grant.value);
      else console.warn(JSON.stringify({ event: 'playback.signing.failed', sourceId: batchSources[index].id, error: sanitizeError(grant.reason), time: Date.now() }));
    }
  }
  if (sources.length && !result.length) throw new AppError(503, 'No available server could receive playback access');
  return result;
}
