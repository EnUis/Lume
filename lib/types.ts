export type Health = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
export type ContentType = 'movie' | 'series' | 'live';
export interface Title {
  id: string; name: string; type: ContentType; year: number | null;
  alternateIds?: string[];
  synopsis: string; poster: string; backdrop: string; genres: string[];
  duration: number | null; ageRating: string | null; cast: string[]; director: string;
  featured: boolean; demo: boolean; published: boolean; createdAt: number;
  attribution: string; trailer?: string; sources?: Source[]; episodes?: Episode[];
  introStart?: number; introEnd?: number; recapStart?: number; recapEnd?: number;
}
export interface Episode { id: string; titleId: string; alternateIds?: string[]; season: number; number: number; name: string; duration: number | null; available: boolean; sources?: Source[]; introStart?: number; introEnd?: number; recapStart?: number; recapEnd?: number; }
export interface Source { id: string; titleId: string; episodeId: string | null; name: string; format: 'hls' | 'dash' | 'mp4' | 'webm' | 'unknown'; health: Health; enabled: boolean; priority: number; quality: string | null; lastChecked: number | null; lastSuccess: number | null; lastFailure?: number | null; expiresAt?: number; error: string | null; url?: string; language?: string | null; originalName?: string | null; playbackBlocked?: boolean; playbackAttemptToken?: string; playbackAttemptExpiresAt?: number; playbackRetry?: boolean; }
export interface Progress { titleId: string; episodeId?: string | null; position: number; duration: number; updatedAt: number; }
export interface User { id: string; email: string; name: string; role: 'admin' | 'editor' | 'user'; }
export interface Playlist {
  id: string; name: string; url?: string; enabled: boolean; intervalHours: number; lastSync: number | null; nextSync: number | null; health: Health; error: string | null; entryCount: number;
  importStatus?: 'queued' | 'retrying' | 'syncing' | 'awaiting_verification' | 'ready' | 'needs_review' | 'failed' | 'idle' | 'disabled';
  visibilityBreakdown?: { catalogSourceCount: number; groupedSourceCount: number; hiddenVerifiedSourceCount: number; unpublishedSourceCount: number; unpublishedTitleCount: number; misplacedSourceCount: number; movies: number; series: number; channels: number };
  recentlyCheckedSourceCount?: number; disabledSourceCount?: number; sourceCount?: number; pendingSourceCount?: number; playableSourceCount?: number; unavailableSourceCount?: number; visibleTitleCount?: number; reviewCount?: number;
  latestSyncJob?: { id: string; status: string; createdAt: number; runAfter?: number; attempts?: number; maxAttempts?: number; completedAt?: number | null; error?: string | null };
  playlistError?: { code: string; message: string; action: string; httpStatus?: number } | null;
}
export interface Job { id: string; type: string; status: string; createdAt: number; completedAt?: number; error?: string; report?: Record<string, unknown>; }
export interface CatalogResponse { titles: Title[]; total: number; genres: string[]; }
export interface MediaConversion { sessionId: string; duration: number | null; startAt: number; audioTrack?: number; audioTracks: { index: number; language?: string; title?: string; codec?: string; channels?: number; default: boolean }[] }
export interface Source { conversionRequired?: boolean; conversion?: MediaConversion }
