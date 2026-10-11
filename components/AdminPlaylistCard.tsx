'use client';

import { CircleAlert, Clock3, Film, ListChecks, LoaderCircle, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { playlistIssue, playlistRefresh, type DisplayPlaylist } from '../lib/playlist-presentation';

const count = (value?: number) => value === undefined ? '—' : value.toLocaleString();
const date = (value?: number | null) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not yet';

interface Props {
  playlist: DisplayPlaylist; pending: boolean; busy?: boolean; isAdmin: boolean; workerOnline?: boolean;
  onRefresh: () => void; onReview?: () => void; onEdit: () => void; onHistory: () => void; onToggle: () => void; onDelete: () => void;
}

export default function AdminPlaylistCard({ playlist, pending, busy, isAdmin, workerOnline, onRefresh, onReview, onEdit, onHistory, onToggle, onDelete }: Props) {
  const issue = playlistIssue(playlist), refresh = playlistRefresh(playlist, workerOnline);
  const visible = playlist.visibleTitleCount, breakdown = playlist.visibilityBreakdown;
  const libraryDescription = !playlist.enabled ? 'This playlist is disabled and its titles are hidden from viewers.'
    : visible ? 'Each movie, series or live channel is counted once.'
    : playlist.pendingSourceCount ? 'Titles appear after their streams pass verification.'
    : playlist.reviewCount ? 'Review the imported titles before publishing them.'
    : playlist.sourceCount ? 'Streams are saved; no titles are currently visible.'
    : 'A successful import will start building your library.';
  return <article className="admin-playlist-card" aria-labelledby={`playlist-${playlist.id}`}>
    <div className="admin-playlist-card-heading">
      <span className="admin-playlist-icon"><ListChecks size={22} /></span>
      <div><h3 id={`playlist-${playlist.id}`}>{playlist.name}</h3><p><span className={`admin-enabled-dot ${playlist.enabled ? 'enabled' : ''}`} />{playlist.enabled ? 'Automatic refresh on' : 'Disabled'}<span>·</span>Every {playlist.intervalHours} hours</p></div>
      <button className="admin-text-button" onClick={onEdit} disabled={pending}>Edit playlist</button>
    </div>
    <div className="admin-playlist-card-body">
      <section className="admin-playlist-library" aria-label="Saved library">
        <span className="admin-card-label"><Film size={15} />Saved library</span>
        <div className="admin-visible-titles"><strong>{count(visible)}</strong><span>visible {visible === 1 ? 'title' : 'titles'}</span></div>
        <p>{libraryDescription}</p>
        {breakdown && !!visible && <p className="admin-visible-breakdown">{count(breakdown.movies)} movies · {count(breakdown.series)} series · {count(breakdown.channels)} live channels</p>}
        {playlist.enabled && !!breakdown?.unpublishedTitleCount && <div className="admin-library-review"><CircleAlert size={16} /><div><p><strong>{count(breakdown.unpublishedTitleCount)} more titles</strong> have verified streams but are not published yet.</p>{onReview && <button className="admin-text-button" onClick={onReview}>Open Match review</button>}</div></div>}
        {issue && !!visible && playlist.enabled && <div className="admin-library-retained"><ShieldCheck size={15} />Your saved titles remain available.</div>}
      </section>
      <section className="admin-playlist-refresh" aria-label="Latest refresh">
        <span className="admin-card-label"><RefreshCw size={15} />Latest refresh</span>
        <span className={`admin-health ${refresh.tone}`}><span />{refresh.label}</span>
        <p>{refresh.description}</p>
        {issue && <div className="admin-playlist-issue"><CircleAlert size={17} /><div><span className="admin-issue-label">{['queued', 'running'].includes(playlist.latestSyncJob?.status || '') ? 'Last failed attempt' : 'Refresh issue'}</span><strong>{issue.message}</strong><p>{issue.action}</p>{issue.httpStatus && <small>Provider response {issue.httpStatus}</small>}</div></div>}
      </section>
    </div>
    <details className="admin-playlist-stream-details"><summary>Stream details <span>{count(playlist.sourceCount ?? playlist.entryCount)} imported links</span></summary>
      <p className="admin-stream-explainer">A stream is one playback link. Episodes, language versions and alternative servers can share one title.</p>
      {playlist.recentlyCheckedSourceCount !== undefined && <p className="admin-stream-activity">{count(playlist.recentlyCheckedSourceCount)} streams checked in the last 10 minutes.</p>}
      <div className="admin-stream-counts"><span><strong>{count(playlist.playableSourceCount)}</strong> verified streams</span><span><strong>{count(playlist.pendingSourceCount)}</strong> awaiting checks</span><span><strong>{count(playlist.unavailableSourceCount)}</strong> unavailable</span>{!!playlist.disabledSourceCount && <span><strong>{count(playlist.disabledSourceCount)}</strong> disabled streams</span>}<span><strong>{count(playlist.reviewCount)}</strong> titles need review</span></div>
      {breakdown && playlist.enabled && <section className="admin-visibility-explanation" aria-label="How verified streams become visible titles">
        <h4>Why the numbers differ</h4>
        <p><b>{count(breakdown.catalogSourceCount)} verified links</b> belong to <b>{count(visible)} visible titles</b>.{breakdown.groupedSourceCount > 0 ? ` This includes ${count(breakdown.groupedSourceCount)} extra links for episodes, language versions or alternative servers.` : ''}</p>
        {breakdown.hiddenVerifiedSourceCount > 0 && <p><b>{count(breakdown.hiddenVerifiedSourceCount)} verified links are still hidden.</b>{breakdown.unpublishedSourceCount > 0 ? ` ${count(breakdown.unpublishedSourceCount)} belong to unpublished titles.` : ''}{breakdown.misplacedSourceCount > 0 ? ` ${count(breakdown.misplacedSourceCount)} need their movie or episode information corrected.` : ''}</p>}
        <p className="admin-stream-note">The review count is a count of titles. It can overlap verified streams and streams awaiting checks.</p>
      </section>}
    </details>
    <div className="admin-playlist-card-footer">
      <div className="admin-playlist-actions"><button className="admin-button" onClick={onRefresh} disabled={pending || !playlist.enabled}>{busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}Refresh now</button><button className="admin-button" onClick={onHistory} disabled={pending}>History</button><button className="admin-text-button" onClick={onToggle} disabled={pending}>{playlist.enabled ? 'Disable playlist' : 'Enable playlist'}</button><button className="admin-playlist-delete" onClick={onDelete} disabled={pending || !isAdmin} title={isAdmin ? 'Delete playlist' : 'Administrator role required'} aria-label={`Delete ${playlist.name}`}><Trash2 size={16} /></button></div>
      <div className="admin-playlist-timing"><Clock3 size={14} /><span>Last successful import: <b>{date(playlist.lastSync)}</b>{playlist.enabled && <small>Next scheduled refresh: {date(playlist.nextSync)}</small>}</span></div>
    </div>
  </article>;
}
