import { workerError } from './worker-log';

export interface PlaylistErrorDetail { code: string; message: string; action: string; httpStatus?: number }
const HOUR = 3600000;

/** Keep the status code for diagnostics without exposing a provider URL or response body. */
export class PlaylistFetchError extends Error {
  readonly retryAt: number;
  constructor(public readonly httpStatus: number, retryAfter?: string, now = Date.now()) {
    super(`Playlist HTTP ${httpStatus}${[401, 403].includes(httpStatus) ? ': authentication or authorization required' : ''}`);
    this.name = 'PlaylistFetchError';
    const seconds = Number(retryAfter), date = /^[A-Za-z]{3},\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT$/i.test(retryAfter || '') ? Date.parse(retryAfter!) : NaN;
    const requested = retryAfter?.trim() && Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Number.isFinite(date) ? date : 0;
    const minimum = permanentProviderResponse(httpStatus) ? HOUR : httpStatus === 429 ? 60000 : 15000;
    this.retryAt = Math.max(now + minimum, Math.min(now + 24 * HOUR, requested));
  }
}

function httpStatus(error: unknown) {
  if (error instanceof PlaylistFetchError) return error.httpStatus;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = message.match(/\bPlaylist HTTP\s+(\d{3})\b/i); return match ? Number(match[1]) : null;
}
function permanentProviderResponse(status: number) { return [400, 401, 403, 404, 405, 410, 422].includes(status) || status < 100 || status > 599; }

/** Retry policy applies to playlist fetches, not ordinary health/metadata jobs. */
export function playlistRetryAt(error: unknown, attempts: number, now = Date.now(), jitter = Math.floor(Math.random() * 5000)) {
  const backoff = now + Math.min(HOUR, 15000 * 2 ** Math.max(0, attempts - 1)) + jitter;
  if (error instanceof PlaylistFetchError) return Math.max(backoff, error.retryAt);
  const status = httpStatus(error);
  if (status !== null) return Math.max(backoff, now + (permanentProviderResponse(status) ? HOUR : status === 429 ? 60000 : 0));
  const message = error instanceof Error ? error.message : String(error);
  return /Playlist must begin|Playlist has no valid entries|Unexpected playlist shrink/i.test(message) ? Math.max(backoff, now + HOUR) : backoff;
}

/** Also interpret legacy persisted errors; no database rewrite is necessary. */
export function describePlaylistError(error: unknown): PlaylistErrorDetail | null {
  if (error == null || error === '') return null;
  const status = httpStatus(error), message = workerError(error);
  if (status === 404 || status === 410) return { code: 'playlist_not_found', httpStatus: status, message: 'The provider could not find this playlist.', action: 'Check the playlist link or request a current link from the provider.' };
  if (status === 401) return { code: 'playlist_credentials_rejected', httpStatus: status, message: 'The provider did not accept the playlist credentials.', action: 'Check the account details in the link and confirm the provider account is active.' };
  if (status === 403) return { code: 'playlist_access_denied', httpStatus: status, message: 'The provider denied access to this playlist.', action: 'Ask the provider to confirm access for this account and server.' };
  if (status === 429) return { code: 'playlist_rate_limited', httpStatus: status, message: 'The provider is temporarily limiting playlist requests.', action: 'Wait for the scheduled retry before requesting another refresh.' };
  if (status !== null && status >= 500 && status <= 599) return { code: 'playlist_provider_unavailable', httpStatus: status, message: 'The provider is temporarily unable to deliver this playlist.', action: 'The saved library is retained. Wait for the scheduled retry or check with the provider.' };
  if (status !== null) return { code: 'playlist_provider_response', httpStatus: status, message: `The provider returned response ${status} instead of a playlist.`, action: 'Check the link with the provider; this response alone does not identify the cause.' };
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(message)) return { code: 'playlist_timeout', message: 'The provider took too long to deliver the playlist.', action: 'Wait for the scheduled retry or check the provider connection.' };
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|DNS lookup|socket hang up|fetch failed/i.test(message)) return { code: 'playlist_connection_failed', message: 'The playlist provider could not be reached.', action: 'Check the provider address and connection, then retry.' };
  if (/Playlist must begin/i.test(message)) return { code: 'playlist_invalid_response', message: 'The response was not a valid M3U playlist.', action: 'Use the provider’s M3U export link or upload a valid M3U file.' };
  if (/Playlist has no valid entries/i.test(message)) return { code: 'playlist_empty', message: 'The playlist contained no usable entries.', action: 'Check the provider export. The saved library has been retained.' };
  if (/Playlist download was incomplete/i.test(message)) return { code: 'playlist_incomplete', message: 'The playlist download did not finish.', action: 'Wait for the scheduled retry. The saved library has been retained.' };
  if (/Unexpected playlist shrink/i.test(message)) return { code: 'playlist_shrink_protected', message: 'The refresh removed too much of the playlist to apply automatically.', action: 'Check the provider export before replacing the saved library.' };
  if (/Worker lease expired|maximum attempts/i.test(message)) return { code: 'playlist_worker_interrupted', message: 'Playlist processing stopped before it could finish.', action: 'Check the processing service and request another refresh.' };
  return { code: 'playlist_refresh_failed', message: 'The playlist refresh could not finish.', action: 'Review the safe error details and retry after correcting the problem.' };
}
