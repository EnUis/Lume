import { describe, expect, it } from 'vitest';
import { playlistIssue, playlistRefresh, safePlaylistText, type DisplayPlaylist } from '../lib/playlist-presentation';

const fixture = (changes: Partial<DisplayPlaylist> = {}): DisplayPlaylist => ({
  id: 'fixture', name: 'Fixture collection', enabled: true, intervalHours: 12,
  lastSync: 1000, nextSync: 9000, health: 'healthy', error: null, entryCount: 50,
  visibleTitleCount: 23, ...changes,
});

describe('playlist refresh presentation', () => {
  it('presents an expired running lease as a retry rather than active work', () => {
    const result = playlistRefresh(fixture({ importStatus: 'retrying', latestSyncJob: { id: 'job', status: 'running', createdAt: 1000, runAfter: 5000, attempts: 1 } }), true, 2000);
    expect(result.label).toBe('Retry scheduled');
    expect(result.description).toContain('Next attempt:');
  });

  it('distinguishes the first queued import from a retry of a previous failure', () => {
    const job = { id: 'job', status: 'queued', createdAt: 1000, attempts: 0 };
    expect(playlistRefresh(fixture({ latestSyncJob: job }), true, 2000).label).toBe('Waiting to start');
    expect(playlistRefresh(fixture({ importStatus: 'retrying', latestSyncJob: job }), true, 2000).label).toBe('Retry scheduled');
    expect(playlistRefresh(fixture({ importStatus: 'retrying', latestSyncJob: job }), false, 2000).label).toBe('Retry waiting for processing');
  });

  it('describes retained saved contents when a refresh fails', () => {
    const playlist = fixture({ latestSyncJob: { id: 'job', status: 'failed', createdAt: 1000, error: 'HTTP 404' } });
    expect(playlistRefresh(playlist).description).toContain('last saved import is retained');
    expect(playlist.visibleTitleCount).toBe(23);
    expect(playlistIssue(playlist)).toMatchObject({ httpStatus: 404, message: 'The provider could not find this playlist.' });
  });

  it('uses one structured explanation and does not guess the meaning of response 885', () => {
    const issue = playlistIssue(fixture({ error: 'old HTTP 404', playlistError: { code: 'playlist_provider_response', httpStatus: 885, message: 'The provider returned response 885.', action: 'Ask the provider about this response.' } }));
    expect(issue).toMatchObject({ httpStatus: 885, message: 'The provider returned response 885.' });
    expect(playlistIssue(fixture({ error: 'HTTP 885' }))?.message).toContain('provider-specific');
  });

  it('does not expose private links or tokens in legacy diagnostics', () => {
    const raw = 'Request failed: https://provider.invalid/list?token=private-value authorization=private-value';
    expect(safePlaylistText(raw)).not.toContain('private-value');
    expect(playlistIssue(fixture({ error: raw }))?.message).not.toContain('provider.invalid');
  });

  it('makes clear that disabling a playlist affects titles as well as updates', () => {
    expect(playlistRefresh(fixture({ enabled: false }))).toMatchObject({ label: 'Playlist disabled', description: 'Enable this playlist to restore verified titles and automatic updates.' });
  });
});
