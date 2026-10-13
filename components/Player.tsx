'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Info, ListVideo, LoaderCircle, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, Settings2, SkipBack, SkipForward, Subtitles, Volume2, VolumeX, Wifi, X } from 'lucide-react';
import type { Episode, Progress, Source, Title, User } from '@/lib/types';
import { chooseLanguageSource, convertedSeek, mediaPosition, mediaDuration, failoverDecision, GrantRefreshLimiter, isExpiredGrant, playbackTransferState, PlaybackSuccessEvidence, preferredSubtitle, rankSources, resumeSeekTarget, secondsLabel, skipWindow, sourceLanguage, sourceLanguageChoices } from '@/lib/playback';
import { languageLabel, normalizeLanguage } from '@/lib/languages';
import { mergeProgress, progressKey, readGuestProgress, saveGuestProgress } from '@/lib/progress';
import { canonicalizeTitleProgress, selectPlaybackEpisode } from '@/lib/player-progress';
import { needsServerPlayback, playbackFetch, playRejection, type PlaybackCapabilities } from '@/lib/player-device';
import './player.css';

type Option = { id: string; label: string; language?: string };
type Adapter = { destroy: () => void; quality?: (id: string) => void; audio?: (id: string) => void; caption?: (id: string) => void };
type NativeAudioTrack = { id: string; label: string; language: string; enabled: boolean };
type ExtendedVideo = HTMLVideoElement & { audioTracks?: { length: number; [index: number]: NativeAudioTrack }; webkitDisplayingFullscreen?: boolean; webkitEnterFullscreen?: () => void; webkitExitFullscreen?: () => void };
type DashTrack = { id?: string; lang?: string; labels?: { text: string }[]; index?: number };
type DashRepresentation = { id: string; height?: number; bandwidth?: number; bitrate?: number };
type DashPlayer = {
  initialize: (video: HTMLVideoElement, url: string, autoplay: boolean) => void;
  on: (event: string, handler: (event?: { error?: unknown }) => void) => void;
  reset: () => void;
  getRepresentationsByType: (type: string) => DashRepresentation[];
  getTracksFor: (type: string) => DashTrack[];
  getCurrentTrack: (type: string) => DashTrack | null;
  setRepresentationForTypeById: (type: string, id: string) => void;
  updateSettings: (settings: object) => void;
  setCurrentTrack: (track: DashTrack) => void;
  setTextTrack: (index: number) => void;
};

function trackLabel(track: { label?: string; name?: string; lang?: string; language?: string }, index: number, kind: string) {
  const code = normalizeLanguage(track.lang || track.language);
  return track.label || track.name || (code ? languageLabel(code) : '') || `${kind} ${index + 1}`;
}

function refreshCatalog() {
  window.dispatchEvent(new CustomEvent('luma-catalog-refresh'));
  try { localStorage.setItem('luma.catalog.updatedAt', String(Date.now())); } catch { /* Current-tab invalidation remains available. */ }
}

function deviceCapabilities(video: HTMLVideoElement): PlaybackCapabilities {
  return { pageUrl: window.location.href, nativeHls: !!video.canPlayType('application/vnd.apple.mpegurl'), mediaSource: typeof MediaSource !== 'undefined' || !!(window as Window & { ManagedMediaSource?: unknown }).ManagedMediaSource, mp4: !!video.canPlayType('video/mp4'), webm: !!video.canPlayType('video/webm') };
}

function browserCompatible(source: Source): boolean {
  // Server conversion is available when a device cannot decode the original.
  if (source.playbackAttemptToken) return true;
  const video = document.createElement('video');
  const mse = typeof MediaSource !== 'undefined' || !!(window as Window & { ManagedMediaSource?: unknown }).ManagedMediaSource;
  if (source.format === 'dash') return mse;
  if (source.format === 'hls') return mse || !!video.canPlayType('application/vnd.apple.mpegurl');
  if (source.format === 'mp4') return !!video.canPlayType('video/mp4');
  if (source.format === 'webm') return !!video.canPlayType('video/webm');
  return true;
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || (response.status === 404 ? 'This title is not available.' : 'Could not load this title. Please try again.')), { classification: body.classification, code: body.code });
  }
  return response.json() as Promise<T>;
}

export default function Player({ titleId, initialEpisodeId }: { titleId: string; initialEpisodeId?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<Adapter | null>(null);
  const sourcesRef = useRef<Source[]>([]);
  const attemptedRef = useRef(new Set<string>());
  const activeRef = useRef<string | null>(null);
  const seekRef = useRef(0);
  const playIntent = useRef(false);
  const transferRef = useRef<{ position: number; playing: boolean } | null>(null);
  const accountRef = useRef<User | null>(null);
  const preferredCaptionRef = useRef('off');
  const preferredLanguageRef = useRef<string | null>(null);
  const selectedLanguageRef = useRef<string>('und');
  const captionSelectedRef = useRef(false);
  const historyRef = useRef<Progress[]>([]);
  const metadataRef = useRef<{ title: Title | null; episodeId: string | null }>({ title: null, episodeId: null });
  const progressLastSaved = useRef(0);
  const hasPlayedRef = useRef(false);
  const currentTimeRef = useRef(0);
  const sourceGeneration = useRef(0);
  const playbackGeneration = useRef(0);
  const grantRefreshRef = useRef(new GrantRefreshLimiter());
  const grantAbortRef = useRef<AbortController | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failureRef = useRef<(reason: string) => void>(() => {});
  const conversionRef = useRef<Source['conversion']>(undefined);
  const conversionAbortRef = useRef<AbortController | null>(null);
  const bridgeAttemptRef = useRef(new Set<string>());
  const prepareRef = useRef<(position: number, audioTrack?: number) => Promise<void>>(async () => {});
  const [title, setTitle] = useState<Title | null>(null);
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [awaitingPlay, setAwaitingPlay] = useState(true);
  const playRequestRef = useRef<() => void>(() => {});
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState('1');
  const [controls, setControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pipAvailable, setPipAvailable] = useState(false);
  const [panel, setPanel] = useState<'settings' | 'servers' | 'episodes' | 'help' | null>(null);
  const [qualities, setQualities] = useState<Option[]>([]);
  const [audios, setAudios] = useState<Option[]>([]);
  const [captions, setCaptions] = useState<Option[]>([]);
  const [quality, setQuality] = useState('auto');
  const [audio, setAudio] = useState('0');
  const [sourceAudioLanguage, setSourceAudioLanguage] = useState('und');
  const [preferredAudioLanguage, setPreferredAudioLanguage] = useState<string | null>(null);
  const [caption, setCaption] = useState('off');
  const [measuredQuality, setMeasuredQuality] = useState('');
  const [ended, setEnded] = useState(false);
  const [autoNext, setAutoNext] = useState(true);
  const [countdown, setCountdown] = useState(8);
  const [reload, setReload] = useState(0);
  const episodes = [...(title?.episodes ?? [])].sort((a, b) => a.season - b.season || a.number - b.number);
  const episodeIndex = episodes.findIndex(entry => entry.id === episodeId);
  const episode = episodes[episodeIndex] ?? null;
  const previousEpisode = episodes.slice(0, episodeIndex).reverse().find(entry => entry.available);
  const nextEpisode = episodes.slice(episodeIndex + 1).find(entry => entry.available);
  const source = sources.find(entry => entry.id === activeId);
  const languageChoices = sourceLanguageChoices(sources);
  const skip = title?.type === 'live' ? null : skipWindow(episode ?? title, position);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all([
      playbackFetch(`/api/titles/${encodeURIComponent(titleId)}`, { signal: controller.signal }, 30000, 16 * 1024 * 1024).then(response => responseJson<{ title: Title }>(response)),
      playbackFetch('/api/auth/me', { signal: controller.signal }).then(response => responseJson<{ user: User | null }>(response)).catch(() => ({ user: null })),
      playbackFetch('/api/progress', { signal: controller.signal }).then(response => responseJson<{ progress: Progress[] }>(response)).catch(() => ({ progress: [] })),
      playbackFetch('/api/preferences', { signal: controller.signal }).then(response => responseJson<{ preferences: { autoplay: boolean; language: string } }>(response)).catch(() => null),
    ]).then(([detail, auth, history, preference]) => {
      if (controller.signal.aborted) return;
      accountRef.current = auth.user;
      if (auth.user && preference) { setAutoNext(preference.preferences.autoplay); preferredCaptionRef.current = preference.preferences.language; }
      // Account history is kept separate until the viewer explicitly transfers guest history.
      historyRef.current = canonicalizeTitleProgress(detail.title, auth.user ? mergeProgress(history.progress) : readGuestProgress());
      const oldEpisode = detail.title.episodes?.find(episode => episode.alternateIds?.includes(titleId));
      const selected = selectPlaybackEpisode(detail.title, historyRef.current, initialEpisodeId || oldEpisode?.id);
      setTitle(detail.title);
      metadataRef.current = { title: detail.title, episodeId: selected?.id ?? null };
      setEpisodeId(selected?.id ?? null);
      setLoading(false);
    }).catch(reason => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : 'Could not load this title.');
      setLoading(false);
    });
    return () => controller.abort();
  }, [titleId, initialEpisodeId, reload]);

  useEffect(() => {
    if (!title) return;
    if (title.type === 'series' && !episodeId) {
      setError('No episodes are available right now. Please check back soon.');
      return;
    }
    const controller = new AbortController();
    playbackGeneration.current++;
    grantAbortRef.current?.abort();
    grantRefreshRef.current.reset();
    metadataRef.current = { title, episodeId };
    const saved = title.type === 'live' ? undefined : historyRef.current.find(entry => progressKey(entry) === progressKey({ titleId: title.id, episodeId }));
    seekRef.current = saved && saved.position < saved.duration - 2 ? saved.position : 0;
    currentTimeRef.current = seekRef.current;
    transferRef.current = { position: seekRef.current, playing: playIntent.current };
    hasPlayedRef.current = false;
    attemptedRef.current = new Set();
    bridgeAttemptRef.current = new Set();
    conversionAbortRef.current?.abort();
    activeRef.current = null;
    setActiveId(null);
    setSources([]);
    setPosition(seekRef.current);
    setDuration(0);
    setEnded(false);
    setError('');
    setSourceLoading(true);
    playbackFetch(`/api/playback/${encodeURIComponent(title.id)}${episodeId ? `?episodeId=${encodeURIComponent(episodeId)}` : ''}`, { signal: controller.signal }, 30000)
      .then(response => responseJson<{ sources: Source[] }>(response)).then(result => {
        if (controller.signal.aborted) return;
        const available = rankSources(result.sources, browserCompatible);
        sourcesRef.current = available;
        setSources(available);
        if (!available.length) throw new Error(rankSources(result.sources).length ? 'The available streams are not compatible with this browser. Try a current browser with adaptive video support.' : 'No playback servers are available for this title right now.');
        const selected = chooseLanguageSource(available, preferredLanguageRef.current)!;
        const selectedLanguage = sourceLanguage(selected);
        selectedLanguageRef.current = selectedLanguage;
        setSourceAudioLanguage(selectedLanguage);
        if (preferredLanguageRef.current && selectedLanguage !== preferredLanguageRef.current) setNotice(`Your preferred audio is unavailable. ${selectedLanguage === 'und' ? 'Using an unspecified audio language.' : `Playing in ${languageLabel(selectedLanguage)}.`}`);
        activeRef.current = selected.id;
        setActiveId(selected.id);
        setSourceLoading(false);
      }).catch(reason => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : 'Could not load playback servers.');
        setSourceLoading(false);
      });
    return () => { controller.abort(); grantAbortRef.current?.abort(); };
  }, [title, episodeId, reload]);

  const saveProgress = useCallback((force = false, keepalive = false) => {
    const video = videoRef.current;
    const meta = metadataRef.current;
    if (!video || !meta.title || !hasPlayedRef.current || meta.title.type === 'live') return;
    const total = mediaDuration(video.duration, conversionRef.current); if (!total) return;
    if (!force && Date.now() - progressLastSaved.current < 5000) return;
    progressLastSaved.current = Date.now();
    const entry: Progress = { titleId: meta.title.id, episodeId: meta.episodeId, position: Math.min(total, mediaPosition(video.currentTime, conversionRef.current)), duration: total, updatedAt: Date.now() };
    historyRef.current = mergeProgress(historyRef.current, [entry]);
    if (!accountRef.current) {
      if (!saveGuestProgress(entry)) setNotice('Browser storage is unavailable. Your place cannot be saved on this device.');
    } else {
      void fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry), keepalive })
        .then(response => { if (!response.ok) throw new Error('sync'); })
        .catch(() => {
          saveGuestProgress(entry);
          setNotice('Account history could not sync. Your place is saved on this device.');
        });
    }
  }, []);

  useEffect(() => {
    const leave = () => saveProgress(true, true);
    const hide = () => { if (document.visibilityState === 'hidden') leave(); };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hide);
    return () => { leave(); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', hide); };
  }, [saveProgress]);

  const renewPlaybackAccess = useCallback(async (resumePosition: number, originalReason: string) => {
    if (metadataRef.current.title?.type === 'live') resumePosition = 0;
    const meta = metadataRef.current;
    if (!meta.title) return;
    const generation = playbackGeneration.current;
    const controller = new AbortController();
    grantAbortRef.current = controller;
    sourceGeneration.current++;
    transferRef.current = { position: resumePosition, playing: playIntent.current };
    videoRef.current?.pause();
    setSourceLoading(true);
    setNotice('Refreshing playback access. Your place will be kept.');
    try {
      // One bounded attempt after a short backoff, rather than a renewal/error loop.
      await new Promise(resolve => setTimeout(resolve, 400));
      if (controller.signal.aborted || generation !== playbackGeneration.current) return;
      const response = await playbackFetch(`/api/playback/${encodeURIComponent(meta.title.id)}${meta.episodeId ? `?episodeId=${encodeURIComponent(meta.episodeId)}` : ''}`, { signal: controller.signal }, 30000);
      const result = await responseJson<{ sources: Source[] }>(response);
      if (controller.signal.aborted || generation !== playbackGeneration.current) return;
      const renewed = rankSources(result.sources, browserCompatible);
      const selected = renewed.find(entry => sourceLanguage(entry) === selectedLanguageRef.current);
      if (!selected) throw new Error('No fresh compatible playback access is available in the selected audio language.');
      sourcesRef.current = renewed;
      attemptedRef.current = new Set();
      seekRef.current = resumePosition;
      currentTimeRef.current = resumePosition;
      activeRef.current = selected.id;
      setSources(renewed);
      setActiveId(selected.id);
      setSourceRevision(value => value + 1);
      setError('');
      setNotice('Playback access renewed. Continuing from your saved place.');
    } catch (reason) {
      if (controller.signal.aborted || generation !== playbackGeneration.current) return;
      setBuffering(false);
      setPlaying(false);
      setError(`${originalReason} Playback access could not be renewed. Try again to request a new connection.`);
    } finally {
      if (!controller.signal.aborted && generation === playbackGeneration.current) {
        grantAbortRef.current = null;
        setSourceLoading(false);
      }
    }
  }, []);

  failureRef.current = (reason: string) => { void (async () => {
    const failedId = activeRef.current;
    if (!failedId || attemptedRef.current.has(failedId)) return;
    const failed = sourcesRef.current.find(entry => entry.id === failedId);
    if (!failed) return;
    const video = videoRef.current;
    const decision = failoverDecision(sourcesRef.current, failedId, attemptedRef.current, metadataRef.current.title?.type === 'live' ? 0 : Math.max(currentTimeRef.current, seekRef.current), selectedLanguageRef.current);
    attemptedRef.current = decision.attemptedIds;
    seekRef.current = decision.position;
    playIntent.current = playIntent.current || !!video && !video.paused;
    transferRef.current = { position: decision.position, playing: playIntent.current };
    const generation = ++sourceGeneration.current;
    const playback = playbackGeneration.current;
    video?.pause();
    setSourceLoading(true);
    const expired = isExpiredGrant(failed);
    let availabilityWarning = '';
    if (!expired) {
      sourcesRef.current = sourcesRef.current.map(entry => entry.id === failedId ? { ...entry, health: 'unavailable', playbackBlocked: true, playbackRetry: false } : entry);
      setSources(sourcesRef.current);
      try {
        let token = failed.playbackAttemptToken;
        if (token && failed.playbackAttemptExpiresAt && failed.playbackAttemptExpiresAt <= Date.now() + 1000) {
          const response = await playbackFetch('/api/playback/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: failedId, playbackAttemptToken: token }) });
          token = (await responseJson<{ source: Source }>(response)).source.playbackAttemptToken;
        }
        if (!token) throw new Error('Playback verification could not be recorded.');
        const response = await playbackFetch('/api/playback/failure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: failedId, playbackAttemptToken: token }) });
        if (!response.ok) throw new Error('Playback verification could not be recorded.');
      } catch { availabilityWarning = 'Availability could not be updated. '; }
      refreshCatalog();
    }
    if (generation !== sourceGeneration.current || playback !== playbackGeneration.current) return;
    setSourceLoading(false);
    if (decision.source) {
      setNotice(`${availabilityWarning}${metadataRef.current.title?.type === 'live' ? 'Connection interrupted. Trying another live server.' : 'Connection interrupted. Trying another server in the same audio language and keeping your place.'}`);
      activeRef.current = decision.source.id;
      setActiveId(decision.source.id);
    } else if (grantRefreshRef.current.claim(sourcesRef.current)) {
      void renewPlaybackAccess(decision.position, reason);
    } else {
      setBuffering(false);
      setPlaying(false);
      const otherLanguage = rankSources(sourcesRef.current).some(entry => sourceLanguage(entry) !== selectedLanguageRef.current);
      setError(`${availabilityWarning}${reason} No working server remains in this audio language.${otherLanguage ? ' Choose another audio language in playback settings.' : ' You can retry a server or return to browsing.'}`);
    }
  })(); };

  prepareRef.current = async (position: number, audioTrack?: number) => {
    if (metadataRef.current.title?.type === 'live') position = 0;
    const active = sourcesRef.current.find(entry => entry.id === activeRef.current); if (!active) return;
    const generation = ++sourceGeneration.current, playback = playbackGeneration.current;
    conversionAbortRef.current?.abort(); const controller = new AbortController(); conversionAbortRef.current = controller;
    bridgeAttemptRef.current.add(active.id);
    playIntent.current ||= !!videoRef.current && !videoRef.current.paused;
    transferRef.current = { position, playing: playIntent.current }; seekRef.current = position; currentTimeRef.current = position;
    videoRef.current?.pause(); setSourceLoading(true); setBuffering(true); setError(''); setNotice(metadataRef.current.title?.type === 'live' ? 'Connecting to the live broadcast.' : 'Preparing playback. Your place will be kept.');
    const current = () => !controller.signal.aborted && generation === sourceGeneration.current && playback === playbackGeneration.current;
    try {
      const response = await playbackFetch('/api/playback/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: active.id, playbackAttemptToken: active.playbackAttemptToken, startAt: position, audioTrack, previousSessionId: active.conversion?.sessionId, delivery: videoRef.current && deviceCapabilities(videoRef.current).nativeHls ? 'hls' : 'mp4' }), signal: controller.signal }, 90000);
      const fresh = (await responseJson<{ source: Source }>(response)).source;
      if (!current()) { if (fresh.conversion) void fetch('/api/playback/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: fresh.conversion.sessionId }) }); return; }
      sourcesRef.current = sourcesRef.current.map(entry => entry.id === active.id ? fresh : entry); setSources(sourcesRef.current);
      setSourceLoading(false); setNotice(''); setSourceRevision(value => value + 1);
    } catch (reason) {
      if (!current()) return;
      setSourceLoading(false); setBuffering(false); setPlaying(false);
      if ((reason as { classification?: string }).classification === 'source') failureRef.current((reason as Error).message);
      else setError(reason instanceof Error && reason.name !== 'TimeoutError' ? reason.message : 'Video preparation took too long. Please retry.');
    }
  };
  useEffect(() => () => { conversionAbortRef.current?.abort(); }, []);

  useEffect(() => {
    const video = videoRef.current;
    const active = sourcesRef.current.find(entry => entry.id === activeId);
    if (!video || !active?.url) return;
    if (needsServerPlayback(active, deviceCapabilities(video))) { void prepareRef.current(seekRef.current); return; }
    conversionRef.current = active.conversion;
    if (active.conversion) { setDuration(active.conversion.duration || 0); seekRef.current = 0; currentTimeRef.current = active.conversion.startAt; setPosition(active.conversion.startAt); }
    const generation = ++sourceGeneration.current;
    let disposed = false;
    let loaded = false;
    let mediaRecovery = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let adapter: Adapter | null = null;
    let playbackAttempt = active;
    let successEvidence = new PlaybackSuccessEvidence();
    let renewalPending = false;
    setBuffering(true);
    setAwaitingPlay(!playIntent.current);
    setQualities([]);
    setAudios([]);
    setCaptions([]);
    setQuality('auto');
    setCaption('off');
    captionSelectedRef.current = false;
    setAudio('0');
    setMeasuredQuality('');
    setBuffered(0);
    const current = () => !disposed && generation === sourceGeneration.current;
    const renewAttempt = async () => {
      if (renewalPending || !current() || !playbackAttempt.playbackAttemptToken) return;
      renewalPending = true;
      try {
        const response = await playbackFetch('/api/playback/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: active.id, playbackAttemptToken: playbackAttempt.playbackAttemptToken }) });
        const renewed = (await responseJson<{ source: Source }>(response)).source;
        if (!current()) return;
        // Renew reporting authorization without replacing media that is already playing.
        playbackAttempt = { ...playbackAttempt, playbackAttemptToken: renewed.playbackAttemptToken, playbackAttemptExpiresAt: renewed.playbackAttemptExpiresAt };
        sourcesRef.current = sourcesRef.current.map(entry => entry.id === active.id ? { ...entry, playbackAttemptToken: renewed.playbackAttemptToken, playbackAttemptExpiresAt: renewed.playbackAttemptExpiresAt } : entry);
        setSources(sourcesRef.current);
        successEvidence = new PlaybackSuccessEvidence();
        if (!video.paused && !video.seeking) successEvidence.playing(video.currentTime);
      } catch { /* A reporting outage does not interrupt a working video. */ }
      finally { renewalPending = false; }
    };
    const renewTimer = setInterval(() => {
      if (playbackAttempt.playbackAttemptExpiresAt && playbackAttempt.playbackAttemptExpiresAt <= Date.now() + 60_000) void renewAttempt();
    }, 30_000);
    const confirmPlaying = () => { if (current()) { transferRef.current = null; successEvidence.playing(video.currentTime); } };
    const confirmSeeking = () => successEvidence.seeking();
    const confirmSeeked = () => { if (current() && !video.paused) successEvidence.playing(video.currentTime); };
    const confirmAdvance = () => {
      if (!current() || attemptedRef.current.has(active.id) || !playbackAttempt.playbackAttemptToken || !successEvidence.advance(video.currentTime, video.paused, video.seeking)) return;
      const token = playbackAttempt.playbackAttemptToken;
      void playbackFetch('/api/playback/success', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: active.id, playbackAttemptToken: token }) })
        .then(response => responseJson<{ ok: boolean; restored: boolean }>(response)).then(result => {
          if (!current() || !result.ok || attemptedRef.current.has(active.id)) return;
          sourcesRef.current = sourcesRef.current.map(entry => entry.id === active.id ? { ...entry, health: 'healthy', playbackBlocked: false, playbackRetry: false } : entry);
          setSources(sourcesRef.current);
          if (result.restored) refreshCatalog();
        }).catch(() => { /* The next authorization renewal can record continued playback. */ });
    };
    let handlingFailure = false;
    const fail = (reason: string) => { if (!current() || handlingFailure) return; handlingFailure = true; void (async () => {
      if (!active.conversion && !bridgeAttemptRef.current.has(active.id)) { void prepareRef.current(Math.max(currentTimeRef.current, seekRef.current)); return; }
      if (active.conversion) {
        try {
          const status = await playbackFetch(`/api/playback/session/${active.conversion.sessionId}`, {}).then(response => responseJson<{ status: string; classification?: string; error?: string }>(response));
          if (!current()) return;
          if (status.classification === 'source') { failureRef.current(status.error || reason); return; }
        } catch { /* A local conversion outage must not hide the upstream title. */ }
        if (current()) { setSourceLoading(false); setBuffering(false); setPlaying(false); setError('Playback was interrupted. Press retry to keep watching from your place.'); } return;
      }
      if (current()) failureRef.current(reason);
    })(); };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let playSequence = 0;
    const rejectPlay = (reason: unknown, request: number) => {
      if (!current() || request !== playSequence) return;
      const rejection = playRejection(reason);
      // load() cancels an older play promise during a source/seek transition.
      if (rejection === 'interrupted') return;
      if (rejection === 'unsupported') { fail('This format needs compatible playback.'); return; }
      clearTimeout(timeout); timeout = undefined;
      transferRef.current = null; playIntent.current = false;
      setPlaying(false); setBuffering(false); setAwaitingPlay(true);
      setNotice(rejection === 'gesture' ? 'Tap play to continue.' : 'Playback could not start. Tap play to try again.');
    };
    const requestPlay = () => {
      if (!current()) return;
      const request = ++playSequence;
      // Keep this synchronous with the tap; awaiting metadata first can deadlock
      // WebKit when it defers loading a newly selected source until play().
      try { void video.play().catch(reason => rejectPlay(reason, request)); } catch (reason) { rejectPlay(reason, request); }
    };
    playRequestRef.current = requestPlay;
    const startLoading = () => {
      setAwaitingPlay(false);
      if (!loaded && !timeout) timeout = setTimeout(() => { if (!loaded && !video.paused) fail('The stream took too long to respond.'); }, active.conversion ? 65000 : 30000);
    };
    // A phone may defer media loading until the viewer taps.
    if (playIntent.current) startLoading();
    video.addEventListener('play', startLoading);
    const restore = () => {
      if (!current() || video.readyState < 1) return;
      // Metadata is enough to show the paused player; buffering is timed separately after play.
      loaded = true;
      clearTimeout(timeout);
      const resume = active.conversion || metadataRef.current.title?.type === 'live' ? null : resumeSeekTarget(seekRef.current, video.duration);
      if (resume !== null) {
        video.currentTime = resume;
        currentTimeRef.current = video.currentTime;
        setPosition(video.currentTime);
        seekRef.current = 0;
      }
      if (video.videoHeight > 0) setMeasuredQuality(`${video.videoHeight}p`);
      if (playIntent.current) { if (video.paused) requestPlay(); }
      else { transferRef.current = null; setBuffering(false); }
    };
    const nativeError = () => {
      if (video.error?.code === 1) return;
      fail(video.error?.code === 3 ? 'This stream could not be decoded.' : video.error?.code === 4 ? 'This stream uses a format or codec this browser cannot play.' : 'The playback connection failed.');
    };
    const loadedData = () => { loaded = true; clearTimeout(timeout); restore(); };
    const clearStall = () => { if (stallTimer) clearTimeout(stallTimer); stallTimer = null; };
    const waiting = () => {
      clearStall();
      if (playIntent.current) stallTimer = setTimeout(() => { if (!video.paused && current()) fail('The stream is buffering for too long.'); }, 20_000);
    };
    const nativeTracks = () => {
      if (!current()) return;
      if (active.conversion) {
        setAudios(active.conversion.audioTracks.map((track, index) => ({ id: String(track.index), label: trackLabel({ label: track.title, language: track.language }, index, 'Audio'), language: track.language })));
        setAudio(String(active.conversion.audioTrack ?? active.conversion.audioTracks[0]?.index ?? 0)); return;
      }
      const tracks = Array.from(video.textTracks);
      if (!captionSelectedRef.current) for (const track of tracks) track.mode = 'disabled';
      setCaptions(tracks.map((track, index) => ({ id: String(index), label: track.label || track.language || `Subtitle ${index + 1}`, language: track.language })));
      const audioTracks = (video as ExtendedVideo).audioTracks;
      if (audioTracks) {
        setAudios(Array.from({ length: audioTracks.length }, (_, index) => ({ id: String(index), label: trackLabel(audioTracks[index], index, 'Audio'), language: audioTracks[index].language })));
        const selected = Array.from({ length: audioTracks.length }, (_, index) => index).find(index => audioTracks[index].enabled);
        if (selected !== undefined) setAudio(String(selected));
      }
    };
    video.addEventListener('loadedmetadata', restore);
    video.addEventListener('durationchange', restore);
    video.addEventListener('loadeddata', loadedData);
    video.addEventListener('error', nativeError);
    video.addEventListener('resize', restore);
    video.addEventListener('waiting', waiting);
    video.addEventListener('playing', clearStall);
    video.addEventListener('playing', confirmPlaying);
    video.addEventListener('timeupdate', confirmAdvance);
    video.addEventListener('seeking', confirmSeeking);
    video.addEventListener('seeked', confirmSeeked);
    video.addEventListener('pause', clearStall);
    void (async () => {
      try {
        if ((active.format === 'hls' || /\.m3u8(?:[?#]|$)/i.test(active.url!)) && !deviceCapabilities(video).nativeHls) {
          const { default: Hls } = await import('hls.js');
          if (!current()) return;
          if (Hls.isSupported()) {
            const hls = new Hls({ enableWorker: true, capLevelToPlayerSize: true, backBufferLength: 60 });
            adapter = { destroy: () => hls.destroy(), quality: id => { hls.currentLevel = id === 'auto' ? -1 : Number(id); }, audio: id => { hls.audioTrack = Number(id); }, caption: id => { hls.subtitleTrack = id === 'off' ? -1 : Number(id); hls.subtitleDisplay = id !== 'off'; } };
            adapterRef.current = adapter;
            const refreshTracks = () => {
              if (!current()) return;
              setQualities(hls.levels.map((level, index) => ({ id: String(index), label: level.height ? `${level.height}p` : `${(level.bitrate / 1_000_000).toFixed(1)} Mb/s` })));
              setAudios(hls.audioTracks.map((track, index) => ({ id: String(index), label: trackLabel(track, index, 'Audio'), language: track.lang })));
              if (hls.audioTrack >= 0) setAudio(String(hls.audioTrack));
              setCaptions(hls.subtitleTracks.map((track, index) => ({ id: String(index), label: trackLabel(track, index, 'Subtitle'), language: track.lang })));
            };
            hls.on(Hls.Events.MANIFEST_PARSED, () => { hls.subtitleDisplay = false; hls.subtitleTrack = -1; refreshTracks(); });
            hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, refreshTracks);
            hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => { if (current()) setAudio(String(data.id)); });
            hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, refreshTracks);
            hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
              if (current()) setMeasuredQuality(hls.levels[data.level]?.height ? `${hls.levels[data.level].height}p` : '');
            });
            hls.on(Hls.Events.ERROR, (_, data) => {
              if (!current() || !data.fatal) return;
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovery) { mediaRecovery = true; hls.recoverMediaError(); return; }
              fail('This stream stopped responding.');
            });
            hls.loadSource(active.url!);
            hls.attachMedia(video);
            return;
          }
          if (!video.canPlayType('application/vnd.apple.mpegurl')) throw new Error('Adaptive playback is not supported in this browser.');
        } else if (active.format === 'dash' || /\.mpd(?:[?#]|$)/i.test(active.url!)) {
          const dash = await import('dashjs');
          if (!current()) return;
          const player = dash.MediaPlayer().create() as unknown as DashPlayer;
          adapter = {
            destroy: () => player.reset(),
            quality: id => { player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: id === 'auto' } } } }); if (id !== 'auto') player.setRepresentationForTypeById('video', id); },
            audio: id => { const track = player.getTracksFor('audio')[Number(id)]; if (track) player.setCurrentTrack(track); },
            caption: id => player.setTextTrack(id === 'off' ? -1 : Number(id)),
          };
          adapterRef.current = adapter;
          player.on('streamInitialized', () => {
            if (!current()) return;
            setQualities(player.getRepresentationsByType('video').map(entry => ({ id: entry.id, label: entry.height ? `${entry.height}p` : `${((entry.bandwidth ?? entry.bitrate ?? 0) / 1_000_000).toFixed(1)} Mb/s` })));
            setAudios(player.getTracksFor('audio').map((track, index) => ({ id: String(index), label: trackLabel({ label: track.labels?.[0]?.text, lang: track.lang }, index, 'Audio'), language: track.lang })));
            const currentAudio = player.getCurrentTrack('audio');
            const currentAudioIndex = player.getTracksFor('audio').findIndex(track => track === currentAudio || currentAudio && track.id !== undefined && track.id === currentAudio.id);
            if (currentAudioIndex >= 0) setAudio(String(currentAudioIndex));
            setCaptions(player.getTracksFor('text').map((track, index) => ({ id: String(index), label: track.labels?.[0]?.text || track.lang || `Subtitle ${index + 1}`, language: track.lang })));
            player.setTextTrack(-1);
          });
          player.on('error', () => fail('This adaptive stream could not be loaded.'));
          player.initialize(video, active.url!, false);
          return;
        }
        if (!current()) return;
        adapter = { destroy: () => {}, audio: id => { if (active.conversion) { void prepareRef.current(currentTimeRef.current, Number(id)); return; } const tracks = (video as ExtendedVideo).audioTracks; if (tracks) for (let index = 0; index < tracks.length; index++) tracks[index].enabled = index === Number(id); }, caption: id => { for (let index = 0; index < video.textTracks.length; index++) video.textTracks[index].mode = String(index) === id ? 'showing' : 'disabled'; } };
        adapterRef.current = adapter;
        video.addEventListener('loadedmetadata', nativeTracks);
        video.textTracks.addEventListener('addtrack', nativeTracks);
        video.src = active.url!;
        video.load();
        // Conversion, language changes and next episodes replace src after the
        // original tap. Try now; a fresh iOS gesture prompt must stay reachable.
        if (playIntent.current) requestPlay();
      } catch (reason) { fail(reason instanceof Error ? reason.message : 'This stream could not be loaded.'); }
    })();
    return () => {
      disposed = true;
      if (playRequestRef.current === requestPlay) playRequestRef.current = () => {};
      clearTimeout(timeout);
      clearInterval(renewTimer);
      clearStall();
      video.removeEventListener('play', startLoading);
      video.removeEventListener('loadedmetadata', restore);
      video.removeEventListener('durationchange', restore);
      video.removeEventListener('loadeddata', loadedData);
      video.removeEventListener('error', nativeError);
      video.removeEventListener('resize', restore);
      video.removeEventListener('waiting', waiting);
      video.removeEventListener('playing', clearStall);
      video.removeEventListener('playing', confirmPlaying);
      video.removeEventListener('timeupdate', confirmAdvance);
      video.removeEventListener('seeking', confirmSeeking);
      video.removeEventListener('seeked', confirmSeeked);
      video.removeEventListener('pause', clearStall);
      video.removeEventListener('loadedmetadata', nativeTracks);
      video.textTracks.removeEventListener('addtrack', nativeTracks);
      adapter?.destroy();
      if (adapterRef.current === adapter) adapterRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (active.conversion) void fetch('/api/playback/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: active.conversion.sessionId }), keepalive: true }).catch(() => {});
    };
  }, [activeId, sourceRevision]);

  useEffect(() => {
    setPipAvailable(document.pictureInPictureEnabled && !!videoRef.current?.requestPictureInPicture);
    const native = videoRef.current as ExtendedVideo | null;
    const updateFullscreen = () => setFullscreen(!!document.fullscreenElement || !!native?.webkitDisplayingFullscreen);
    document.addEventListener('fullscreenchange', updateFullscreen);
    native?.addEventListener('webkitbeginfullscreen', updateFullscreen);
    native?.addEventListener('webkitendfullscreen', updateFullscreen);
    try {
      const preference = JSON.parse(localStorage.getItem('luma.player.preferences') ?? '{}');
      if (typeof preference.volume === 'number' && preference.volume >= 0 && preference.volume <= 1) setVolume(preference.volume);
      if (typeof preference.muted === 'boolean') setMuted(preference.muted);
      if (typeof preference.autoNext === 'boolean') setAutoNext(preference.autoNext);
      const preferred = preference.audioLanguage === 'und' ? 'und' : normalizeLanguage(preference.audioLanguage);
      preferredLanguageRef.current = preferred;
      setPreferredAudioLanguage(preferred);
    } catch { /* Fall back to sensible defaults. */ }
    return () => { document.removeEventListener('fullscreenchange', updateFullscreen); native?.removeEventListener('webkitbeginfullscreen', updateFullscreen); native?.removeEventListener('webkitendfullscreen', updateFullscreen); };
  }, []);

  useEffect(() => {
    if (videoRef.current) { videoRef.current.volume = volume; videoRef.current.muted = muted; videoRef.current.playbackRate = metadataRef.current.title?.type === 'live' ? 1 : Number(speed); }
    try { const previous = JSON.parse(localStorage.getItem('luma.player.preferences') || '{}'); localStorage.setItem('luma.player.preferences', JSON.stringify({ ...previous, volume, muted, autoNext, audioLanguage: preferredAudioLanguage })); } catch { /* Playback remains available without storage. */ }
  }, [volume, muted, speed, autoNext, activeId, preferredAudioLanguage]);

  useEffect(() => {
    if (captionSelectedRef.current) return;
    const preferred = preferredSubtitle(captions, preferredCaptionRef.current);
    if (preferred) { setCaption(preferred.id); adapterRef.current?.caption?.(preferred.id); }
  }, [captions]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  const revealControls = useCallback(() => {
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), 3500);
  }, []);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || !activeRef.current || error || loading || sourceLoading) return;
    revealControls();
    if (video.paused) {
      playIntent.current = true;
      if (transferRef.current) transferRef.current.playing = true;
      setEnded(false);
      setAwaitingPlay(false);
      // Call play synchronously from the tap to retain iOS playback permission.
      playRequestRef.current();
    } else { playIntent.current = false; if (transferRef.current) transferRef.current.playing = false; video.pause(); }
  }, [error, loading, sourceLoading, revealControls]);

  const seekTo = useCallback((time: number) => {
    if (metadataRef.current.title?.type === 'live') return;
    const video = videoRef.current;
    if (!video) return;
    const total = mediaDuration(video.duration, conversionRef.current); if (!total) return;
    const target = Math.min(Math.max(0, total - 0.1), Math.max(0, time));
    if (conversionRef.current) {
      const seek = convertedSeek(target, conversionRef.current, video.buffered);
      if (seek.restart) { saveProgress(true); setPosition(target); setEnded(false); revealControls(); void prepareRef.current(target, conversionRef.current.audioTrack); return; }
      video.currentTime = seek.local;
    } else video.currentTime = target;
    currentTimeRef.current = target;
    if (transferRef.current) { transferRef.current.position = target; seekRef.current = target; }
    setPosition(target);
    setEnded(false);
    revealControls();
    saveProgress(true);
  }, [revealControls, saveProgress]);

  const toggleFullscreen = useCallback(async () => {
    try {
      const native = videoRef.current as ExtendedVideo | null;
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (native?.webkitDisplayingFullscreen && native.webkitExitFullscreen) native.webkitExitFullscreen();
      else if (frameRef.current?.requestFullscreen) await frameRef.current.requestFullscreen();
      else {
        if (native?.webkitEnterFullscreen) native.webkitEnterFullscreen();
        else setNotice('Fullscreen is unavailable in this browser.');
      }
    } catch { setNotice('Fullscreen could not open. Please try again.'); }
  }, []);

  const togglePip = useCallback(async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (videoRef.current?.requestPictureInPicture) await videoRef.current.requestPictureInPicture();
    } catch { setNotice('Picture in picture is unavailable for this stream.'); }
  }, []);

  const changeEpisode = useCallback((entry: Episode, autoplay = false) => {
    if (!entry.available || entry.id === metadataRef.current.episodeId) return;
    saveProgress(true);
    playIntent.current = autoplay || !!videoRef.current && !videoRef.current.paused;
    setEpisodeId(entry.id);
    setPanel(null);
    setEnded(false);
    setCountdown(8);
    const url = new URL(window.location.href);
    url.searchParams.set('episodeId', entry.id);
    url.searchParams.delete('episode');
    window.history.replaceState({}, '', url);
  }, [saveProgress]);

  useEffect(() => {
    if (!ended || !autoNext || !nextEpisode) return;
    setCountdown(8);
    const timer = setInterval(() => setCountdown(value => value - 1), 1000);
    return () => clearInterval(timer);
  }, [ended, autoNext, nextEpisode?.id]);

  useEffect(() => { if (ended && autoNext && nextEpisode && countdown <= 0) changeEpisode(nextEpisode, true); }, [ended, autoNext, nextEpisode, countdown, changeEpisode]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement) return;
      const video = videoRef.current;
      switch (event.key.toLowerCase()) {
        case ' ': case 'k': event.preventDefault(); togglePlay(); break;
        case 'arrowleft': event.preventDefault(); seekTo(currentTimeRef.current - 10); break;
        case 'arrowright': event.preventDefault(); seekTo(currentTimeRef.current + 10); break;
        case 'arrowup': event.preventDefault(); setVolume(value => Math.min(1, value + 0.05)); setMuted(false); revealControls(); break;
        case 'arrowdown': event.preventDefault(); setVolume(value => Math.max(0, value - 0.05)); revealControls(); break;
        case 'm': setMuted(value => !value); revealControls(); break;
        case 'f': void toggleFullscreen(); break;
        case 'p': if (pipAvailable) void togglePip(); break;
        case 'c': if (captions.length) { const selected = caption === 'off' ? captions[0].id : 'off'; captionSelectedRef.current = true; setCaption(selected); adapterRef.current?.caption?.(selected); } break;
        case 'escape': setPanel(null); break;
        case '?': setPanel(value => value === 'help' ? null : 'help'); revealControls(); break;
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [togglePlay, seekTo, toggleFullscreen, togglePip, pipAvailable, revealControls, captions, caption]);

  const selectServer = async (id: string) => {
    if (id === activeRef.current && !error) { setPanel(null); return; }
    const candidate = sourcesRef.current.find(entry => entry.id === id);
    if (!candidate) return;
    saveProgress(true);
    const generation = ++playbackGeneration.current;
    grantAbortRef.current?.abort();
    grantRefreshRef.current.reset();
    setSourceLoading(true);
    sourceGeneration.current++;
    const continuity = playbackTransferState(videoRef.current ? { currentTime: currentTimeRef.current, paused: videoRef.current.paused, ended: videoRef.current.ended } : null, currentTimeRef.current, transferRef.current);
    if (metadataRef.current.title?.type === 'live') continuity.position = 0;
    transferRef.current = continuity;
    seekRef.current = continuity.position;
    playIntent.current = continuity.playing;
    videoRef.current?.pause();
    try {
      const response = await playbackFetch('/api/playback/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: id, playbackAttemptToken: candidate.playbackAttemptToken }) });
      const fresh = (await responseJson<{ source: Source }>(response)).source;
      if (generation !== playbackGeneration.current) return;
      if (!fresh.url || !browserCompatible(fresh)) throw new Error('This server is not compatible with your browser.');
      sourcesRef.current = sourcesRef.current.map(entry => entry.id === id ? fresh : entry);
      setSources(sourcesRef.current);
      const selected = sourceLanguage(fresh);
      selectedLanguageRef.current = selected;
      preferredLanguageRef.current = selected;
      setSourceAudioLanguage(selected);
      setPreferredAudioLanguage(selected);
    } catch {
      if (generation !== playbackGeneration.current) return;
      setSourceLoading(false);
      setBuffering(false);
      setError('This server could not provide a fresh playback connection. Choose another server or try again.');
      return;
    }
    attemptedRef.current = new Set();
    bridgeAttemptRef.current.delete(id);
    setError('');
    setEnded(false);
    setPanel(null);
    activeRef.current = id;
    if (id === activeId) setSourceRevision(value => value + 1);
    else setActiveId(id);
    setNotice(metadataRef.current.title?.type === 'live' ? 'Switching to another live server.' : 'Switching servers. Your place will be kept.');
    setSourceLoading(false);
  };

  const selectSourceLanguage = (code: string) => {
    const candidate = rankSources(sourcesRef.current).find(entry => sourceLanguage(entry) === code);
    if (!candidate) return;
    preferredLanguageRef.current = code;
    setPreferredAudioLanguage(code);
    if (candidate.id === activeRef.current && !error) { selectedLanguageRef.current = code; setSourceAudioLanguage(code); return; }
    void selectServer(candidate.id);
  };

  const visible = controls || !playing || !!panel || ended || !!error;
  const percent = duration > 0 ? position / duration * 100 : 0;
  const togglePanel = (name: NonNullable<typeof panel>) => { revealControls(); setPanel(value => value === name ? null : name); };

  return (
    <main className="luma-watch" aria-label={title ? `Watching ${title.name}` : 'Video player'}>
      <div className={`player-frame ${visible ? 'chrome-visible' : ''} ${playing ? 'is-playing' : ''} ${title?.type === 'series' ? 'has-episodes' : ''}`} ref={frameRef} tabIndex={0} onMouseMove={revealControls} onTouchStart={revealControls} onFocus={revealControls}>
        <video ref={videoRef} className="player-video" playsInline preload="metadata" poster={title?.backdrop || title?.poster || undefined} onClick={togglePlay} onDoubleClick={() => void toggleFullscreen()}
          onPlay={() => { setAwaitingPlay(false); setPlaying(true); playIntent.current = true; hasPlayedRef.current = true; revealControls(); }}
          onPause={() => { setPlaying(false); saveProgress(true); }}
          onPlaying={() => { setBuffering(false); setPlaying(true); }}
          onWaiting={() => setBuffering(true)} onSeeking={() => setBuffering(true)} onSeeked={() => { setBuffering(false); saveProgress(true); }}
          onCanPlay={() => setBuffering(false)}
          onDurationChange={event => setDuration(mediaDuration(event.currentTarget.duration, conversionRef.current))}
          onTimeUpdate={event => { const media = event.currentTarget; const total = mediaDuration(media.duration, conversionRef.current); currentTimeRef.current = mediaPosition(media.currentTime, conversionRef.current); setPosition(currentTimeRef.current); if (media.buffered.length && total) setBuffered(mediaPosition(media.buffered.end(media.buffered.length - 1), conversionRef.current) / total * 100); saveProgress(); }}
          onVolumeChange={event => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted); }}
          onEnded={() => { saveProgress(true); setEnded(true); setPlaying(false); playIntent.current = false; setControls(true); }}
        />
        <div className="player-vignette" aria-hidden="true" />
        <header className="player-topbar">
          <Link className="player-back" href={title ? `/title/${title.id}` : '/'} aria-label="Back to title"><ArrowLeft size={22} /><span>Back to browse</span></Link>
          <Link className="player-wordmark" href="/" aria-label="Lume home">lume<span>✳</span></Link>
          <span className="player-top-hint">YOUR FRONT ROW SEAT</span>
        </header>

        {(loading || sourceLoading || buffering && !awaitingPlay && !error) && <div className="player-loading" role="status"><LoaderCircle size={38} className="spin" /><span>{loading ? 'Finding your next escape' : sourceLoading ? 'Finding a playback server' : 'Loading your stream'}</span></div>}
        {!loading && !sourceLoading && (!buffering || awaitingPlay) && !playing && !error && !ended && activeId && <button className="player-center-play" onClick={togglePlay} aria-label="Play video"><Play size={35} fill="currentColor" /></button>}
        {error && <div className="player-error" role="alert"><Wifi size={30} /><h1>{title ? 'A little interruption' : 'Title unavailable'}</h1><p>{error}</p><div className="player-error-actions"><button onClick={() => { saveProgress(true); if (activeRef.current && sourcesRef.current.some(entry => entry.id === activeRef.current)) void selectServer(activeRef.current); else setReload(value => value + 1); }}><RotateCcw size={16} /> Try again</button>{sources.length > 0 && <button className="secondary" onClick={() => togglePanel('servers')}>Choose a server</button>}<Link href={title?.type === 'live' ? '/?view=live' : '/'}>Back to browse</Link></div></div>}
        {notice && <div className="player-notice" role="status"><Info size={15} /><span>{notice}</span></div>}
        {skip && !error && <button className="player-skip-intro" onClick={() => seekTo(skip.end)}>{skip.label}<SkipForward size={17} /></button>}
        {ended && !error && <div className="player-ended"><span className="player-eyebrow">{title?.type === 'live' ? 'BROADCAST ENDED' : nextEpisode ? 'UP NEXT' : 'THE END'}</span><h2>{title?.type === 'live' ? 'This broadcast has stopped.' : nextEpisode ? nextEpisode.name : 'Stay a little longer.'}</h2>{nextEpisode ? <><p>Season {nextEpisode.season} · Episode {nextEpisode.number}{autoNext ? ` · Playing in ${Math.max(0, countdown)}s` : ''}</p><button onClick={() => changeEpisode(nextEpisode, true)}><Play size={18} fill="currentColor" /> Play next episode</button><label className="player-autonext"><input type="checkbox" checked={autoNext} onChange={event => setAutoNext(event.target.checked)} />Autoplay next episode</label></> : <><p>{title?.name}</p><div className="player-error-actions"><button onClick={() => { if (title?.type === 'live') { setReload(value => value + 1); return; } seekTo(0); togglePlay(); }}><RotateCcw size={16} /> {title?.type === 'live' ? 'Reconnect' : 'Watch again'}</button><Link href={title?.type === 'live' ? '/?view=live' : '/'}>Explore more</Link></div></>}</div>}

        {panel && <aside className="player-panel" aria-label={panel === 'settings' ? 'Playback settings' : panel === 'servers' ? 'Playback servers' : panel === 'episodes' ? 'Episodes' : 'Keyboard shortcuts'}>
          <div className="player-panel-title"><h2>{panel === 'settings' ? 'Make yourself comfortable' : panel === 'servers' ? 'Playback servers' : panel === 'episodes' ? 'One more episode' : 'At your fingertips'}</h2><button aria-label="Close panel" onClick={() => setPanel(null)}><X size={19} /></button></div>
          {panel === 'settings' && <div className="player-setting-list">
            <label><span>Volume</span><input aria-label="Playback volume" type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume} onChange={event => { setVolume(Number(event.target.value)); setMuted(false); }} /></label>
            {title?.type !== 'live' && <label><span>Playback speed</span><select value={speed} onChange={event => setSpeed(event.target.value)}>{['0.5', '0.75', '1', '1.25', '1.5', '1.75', '2'].map(value => <option key={value} value={value}>{value === '1' ? 'Normal' : `${value}×`}</option>)}</select></label>}
            <label><span>Picture quality<small>Available from this stream</small></span>{qualities.length > 1 ? <select value={quality} onChange={event => { setQuality(event.target.value); adapterRef.current?.quality?.(event.target.value); }}><option value="auto">Auto{measuredQuality ? ` · ${measuredQuality}` : ''}</option>{qualities.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}</select> : <span className="player-setting-value">{qualities[0]?.label || measuredQuality || 'Original'}</span>}</label>
            <label><span>Audio language<small>Available versions of this title</small></span>{languageChoices.length > 0 ? <select aria-label="Audio language version" value={sourceAudioLanguage} onChange={event => selectSourceLanguage(event.target.value)}>{!languageChoices.some(choice => choice.code === sourceAudioLanguage) && <option value={sourceAudioLanguage} disabled>{sourceAudioLanguage === 'und' ? 'Unspecified' : languageLabel(sourceAudioLanguage)} · unavailable</option>}{languageChoices.map(choice => <option value={choice.code} key={choice.code}>{choice.label}</option>)}</select> : <span className="player-setting-value">No working version</span>}</label>
            {audios.length > 0 && <label><span>Audio track<small>Tracks supplied by this stream</small></span><select aria-label="Stream audio track" value={audio} onChange={event => { setAudio(event.target.value); adapterRef.current?.audio?.(event.target.value); }}>{audios.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>}
            <label><span>Subtitles</span>{captions.length > 0 ? <select value={caption} onChange={event => { captionSelectedRef.current = true; setCaption(event.target.value); adapterRef.current?.caption?.(event.target.value); }}><option value="off">Off</option>{captions.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}</select> : <span className="player-setting-value">Not available</span>}</label>
            {title?.type === 'series' && <label><span>Autoplay next episode</span><input type="checkbox" checked={autoNext} onChange={event => setAutoNext(event.target.checked)} /></label>}
            <button className="player-setting-link" onClick={() => setPanel('servers')}>Playback servers <ChevronRight size={16} /></button>
            <button className="player-setting-link" onClick={() => setPanel('help')}>Keyboard shortcuts <ChevronRight size={16} /></button>
          </div>}
          {panel === 'servers' && <><p className="player-panel-description">Automatic switching keeps the same audio language. Choose another version here whenever you like.</p>{languageChoices.length > 1 && <div className="player-language-options" aria-label="Available audio language versions">{languageChoices.map(choice => <button key={choice.code} className={choice.code === sourceAudioLanguage ? 'selected' : ''} onClick={() => selectSourceLanguage(choice.code)}>{choice.label}</button>)}</div>}<div className="player-server-list">{sources.map((entry, index) => <button key={entry.id} className={entry.id === activeId ? 'selected' : ''} disabled={sourceLoading} onClick={() => void selectServer(entry.id)}><span className={`player-health ${attemptedRef.current.has(entry.id) ? 'failed' : entry.health}`} /><span><strong>{entry.name}</strong><small>{sourceLanguage(entry) === 'und' ? 'Unspecified audio' : languageLabel(sourceLanguage(entry))} · {attemptedRef.current.has(entry.id) || entry.playbackBlocked ? 'Unavailable · retry connection' : `${entry.format.toUpperCase()}${index === 0 ? ' · Recommended' : ''}`}</small></span>{entry.id === activeId && <Check size={18} />}</button>)}</div></>}
          {panel === 'episodes' && <div className="player-episode-list">{episodes.map(entry => <button key={entry.id} disabled={!entry.available} className={entry.id === episodeId ? 'selected' : ''} onClick={() => changeEpisode(entry)}><span className="player-episode-number">{entry.number.toString().padStart(2, '0')}</span><span><small>SEASON {entry.season}</small><strong>{entry.name}</strong><small>{entry.available ? entry.duration ? `${Math.round(entry.duration / 60)} min` : 'Available' : 'Unavailable'}</small></span>{entry.id === episodeId ? <span className="player-now">Playing</span> : entry.available && <Play size={16} />}</button>)}</div>}
          {panel === 'help' && <div className="player-shortcuts">{[['Play / pause', 'Space / K'], ['Seek 10 seconds', '← / →'], ['Adjust volume', '↑ / ↓'], ['Mute', 'M'], ['Fullscreen', 'F'], ['Subtitles', 'C'], ['Picture in picture', 'P'], ['Close this panel', 'Esc']].filter(([label]) => title?.type !== 'live' || label !== 'Seek 10 seconds').map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div>}
        </aside>}

        <footer className="player-bottom">
          <div className="player-title-line"><div><span className="player-eyebrow">{title?.demo ? 'THE OPEN CINEMA COLLECTION' : title?.type === 'live' ? 'LIVE ON LUME' : title?.type === 'series' ? 'NOW PLAYING' : 'SETTLE IN. PRESS PLAY.'}</span><h1>{title?.name || 'Lume'}</h1>{episode && <p>S{episode.season} E{episode.number} <span>·</span> {episode.name}</p>}</div><div className="player-stream-tag">{title?.type === 'live' && <span className="player-live">LIVE</span>}{measuredQuality && <span>{measuredQuality}</span>}<span className="player-stream-name" title={source ? `Last verified source health: ${source.health}` : undefined}><span className={`player-health ${source?.health || 'unknown'}`} />{source?.name || 'Connecting'}</span></div></div>
          {title?.type !== 'live' && <div className="player-timeline"><span className="player-buffered" style={{ width: `${Math.min(100, buffered)}%` }} /><span className="player-played" style={{ width: `${Math.min(100, percent)}%` }} /><input type="range" aria-label="Seek video" min={0} max={duration || 1} step={0.1} value={Math.min(position, duration || 1)} disabled={!duration} onChange={event => seekTo(Number(event.target.value))} /><span className="player-seek-dot" style={{ left: `${Math.min(100, percent)}%` }} /></div>}
          <div className="player-controls-row">
            <div className="player-controls-left"><button aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (K)' : 'Play (K)'} onClick={togglePlay}>{playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}</button>{title?.type !== 'live' && <button className="player-seek-back" onClick={() => seekTo(position - 10)} aria-label="Back 10 seconds" title="Back 10 seconds"><RotateCcw size={22} /><span>10</span></button>}<div className="player-volume"><button aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'} title="Mute (M)" onClick={() => setMuted(value => !value)}>{muted || volume === 0 ? <VolumeX size={24} /> : <Volume2 size={24} />}</button><input aria-label="Volume" type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume} onChange={event => { setVolume(Number(event.target.value)); setMuted(false); }} /></div><span className="player-time">{title?.type === 'live' ? 'LIVE' : <>{secondsLabel(position)}<span>/</span>{secondsLabel(duration)}</>}</span></div>
            <div className="player-controls-right">{title?.type === 'series' && <><button className="player-prev-episode" disabled={!previousEpisode} aria-label="Previous episode" title="Previous episode" onClick={() => previousEpisode && changeEpisode(previousEpisode)}><SkipBack size={22} /></button><button disabled={!nextEpisode} aria-label="Next episode" title="Next episode" onClick={() => nextEpisode && changeEpisode(nextEpisode, true)}><SkipForward size={22} /></button><button className={panel === 'episodes' ? 'active' : ''} aria-label="Select episode" title="Episodes" onClick={() => togglePanel('episodes')}><ListVideo size={22} /></button></>}{captions.length > 0 && <button className={caption !== 'off' ? 'active' : ''} aria-label="Subtitle settings" title="Subtitles (C)" onClick={() => togglePanel('settings')}><Subtitles size={22} /></button>}<button className={panel === 'servers' ? 'active' : ''} aria-label="Select playback server" title="Playback servers" onClick={() => togglePanel('servers')}><Wifi size={21} /></button><button className={panel === 'settings' ? 'active' : ''} aria-label="Playback settings" title="Playback settings" onClick={() => togglePanel('settings')}><Settings2 size={22} /></button>{pipAvailable && <button className="player-pip" aria-label="Picture in picture" title="Picture in picture (P)" onClick={() => void togglePip()}><PictureInPicture2 size={22} /></button>}<button aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title="Fullscreen (F)" onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize size={22} /> : <Maximize size={22} />}</button></div>
          </div>
          <div className="player-bottom-caption"><span>{title?.type === 'live' ? 'Live playback' : accountRef.current ? 'Progress saves to your account' : 'Progress saves on this device'}</span><button onClick={() => togglePanel('help')}>Press <kbd>?</kbd> for shortcuts</button></div>
        </footer>
      </div>
    </main>
  );
}
