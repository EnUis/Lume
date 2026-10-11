import type { Playlist } from './types';

export interface PlaylistIssue { code: string; message: string; action: string; httpStatus?: number; }
export type DisplayPlaylist = Playlist & {
  playlistError?: PlaylistIssue | null;
  latestSyncJob?: NonNullable<Playlist['latestSyncJob']> & { runAfter?: number; attempts?: number; maxAttempts?: number; completedAt?: number | null };
};

export function safePlaylistText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, '[private link]')
    .replace(/\b(password|token|key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[private]')
    .replace(/\s+/g, ' ').trim().slice(0, 260);
}

/** Prefer the API's safe explanation; older installations still get one useful message. */
export function playlistIssue(playlist: DisplayPlaylist): PlaylistIssue | null {
  if (playlist.playlistError) return { ...playlist.playlistError, message: safePlaylistText(playlist.playlistError.message), action: safePlaylistText(playlist.playlistError.action) };
  const error = playlist.latestSyncJob?.error || playlist.error;
  if (!error) return null;
  const status = error.match(/\b(?:HTTP|status|response)[\s:=]*(\d{3})\b/i)?.[1];
  if (status === '404') return { code: 'not_found', httpStatus: 404, message: 'The provider could not find this playlist.', action: 'Check the playlist link, or ask your provider whether it is still available.' };
  if (status === '885') return { code: 'provider_response', httpStatus: 885, message: 'The provider rejected the request with a provider-specific response.', action: 'Check the link and ask your provider about response 885.' };
  if (status === '401' || status === '403') return { code: 'access_rejected', httpStatus: Number(status), message: 'The provider rejected access to this playlist.', action: 'Confirm that the link is current and your provider allows access.' };
  return { code: 'refresh_failed', ...(status ? { httpStatus: Number(status) } : {}), message: safePlaylistText(error), action: 'Check the playlist link and provider, then try the refresh again.' };
}

export function playlistRefresh(playlist: DisplayPlaylist, workerOnline?: boolean, now = Date.now()) {
  const job = playlist.latestSyncJob;
  const runAfter = job?.runAfter;
  if (!playlist.enabled) return { label: 'Playlist disabled', tone: 'unknown', description: 'Enable this playlist to restore verified titles and automatic updates.' };
  if (playlist.importStatus !== 'retrying' && (job?.status === 'running' || playlist.importStatus === 'syncing')) return { label: 'Refreshing now', tone: 'degraded', description: 'Fetching the latest playlist. Saved titles stay in your library.' };
  if (job?.status === 'queued' || playlist.importStatus === 'retrying') {
    if ((job?.attempts || 0) > 0 || playlist.importStatus === 'retrying') return { label: workerOnline === false ? 'Retry waiting for processing' : 'Retry scheduled', tone: 'degraded', description: workerOnline === false ? 'The refresh will retry when the processing service is back online.' : runAfter && runAfter > now ? `Next attempt: ${new Date(runAfter).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}.` : 'The processing service will try this refresh again shortly.' };
    if (workerOnline === false) return { label: 'Waiting for processing', tone: 'unknown', description: 'The processing service is offline. Your saved library is retained.' };
    if (runAfter && runAfter > now) return { label: 'Refresh scheduled', tone: 'unknown', description: `Starts after ${new Date(runAfter).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}.` };
    return { label: 'Waiting to start', tone: 'unknown', description: 'The playlist is saved. Its refresh is waiting in the processing queue.' };
  }
  if (job?.status === 'failed' || playlistIssue(playlist)) return { label: 'Refresh needs attention', tone: 'unavailable', description: playlist.lastSync ? 'The last saved import is retained while this refresh is unresolved.' : 'A successful playlist fetch is needed before titles can be imported.' };
  if (playlist.pendingSourceCount) return { label: 'Checking new streams', tone: 'degraded', description: 'The playlist was imported. New streams are being checked before publication.' };
  if (playlist.reviewCount) return { label: 'Some titles need review', tone: 'degraded', description: 'Review uncertain title matches in Match review.' };
  if (playlist.lastSync || job?.status === 'completed') return { label: 'Refresh complete', tone: 'healthy', description: 'The latest playlist import was saved successfully.' };
  return { label: 'Not refreshed yet', tone: 'unknown', description: 'Refresh this playlist to begin importing its titles.' };
}
