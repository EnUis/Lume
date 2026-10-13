import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hash } from './security';
import { validateSourceUrl } from './outbound';
import { MediaHlsWindow } from './media-hls';
import { mediaRateArguments, MEDIA_RATE_LIMITS } from './media-encoding';

export type MediaFailure = 'source' | 'capacity' | 'config' | 'transient';
export class MediaRuntimeError extends Error {
  constructor(public classification: MediaFailure, message: string, public code = 'media_unavailable') { super(message); }
}
export interface MediaAudioTrack { index: number; language?: string; title?: string; codec?: string; channels?: number; default: boolean }
export interface MediaProbe { duration: number | null; videoIndex: number; videoCodec: string; height: number; audioTracks: MediaAudioTrack[] }
interface MediaSession {
  id: string; sourceId: string; url: string; urlHash: string; viewer: string; startAt: number; audioTrack?: number; live?: boolean; probe: MediaProbe;
  touched: number; created: number; process?: ChildProcessWithoutNullStreams; status: 'ready' | 'playing' | 'complete' | 'failed' | 'expired';
  classification?: MediaFailure; error?: string; bytes: number; sequence: number; hls?: MediaHlsWindow;
}
type Runtime = { sessions: Map<string, MediaSession>; probes: Map<string, { until: number; result: MediaProbe }>; probing: number; timer?: ReturnType<typeof setInterval> };
const globals = globalThis as typeof globalThis & { __lumeMediaRuntime?: Runtime };
const state: Runtime = globals.__lumeMediaRuntime ||= { sessions: new Map(), probes: new Map(), probing: 0 };
const binary = (kind: 'FFMPEG' | 'FFPROBE') => process.env[`${kind}_PATH`] || kind.toLowerCase();
const inputOptions = (url: string, timeoutMs = 15000) => ['-protocol_whitelist', 'http,https,tcp,tls,crypto,httpproxy', ...(new URL(url).protocol === 'https:' ? ['-tls_verify', '1'] : []), '-rw_timeout', String(Math.min(15000, timeoutMs) * 1000), '-analyzeduration', '5000000', '-probesize', '5000000'];
const allowed = (url: string) => validateSourceUrl(url).toString();
// Completed HLS encoders still own buffered fragments until release/expiry.
// Count those windows too so rapid short videos cannot accumulate 100 × 32 MiB.
function running() { return [...state.sessions.values()].filter(session => session.process || session.hls).length; }
function maximum() { return Math.max(1, Math.min(8, Number(process.env.MEDIA_MAX_PROCESSES) || 2)); }
function stop(session: MediaSession, preserveHls = false) { if (!preserveHls) { const hls = session.hls; session.hls = undefined; hls?.stop(); } const child = session.process; session.process = undefined; if (child && child.exitCode === null) child.kill('SIGKILL'); }
function fail(session: MediaSession, classification: MediaFailure, error: string) { session.classification = classification; session.error = error; session.status = 'failed'; stop(session); }
if (!state.timer) {
  state.timer = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of state.sessions) {
      // Output backpressure means a paused viewer does not keep downloading a film.
      if (now - session.touched > 120000 || now - session.created > 8 * 3600000) { stop(session); session.status = 'expired'; }
      if (session.status === 'expired' || session.status === 'failed' && now - session.touched > 120000) state.sessions.delete(key);
    }
    for (const [key, value] of state.probes) if (value.until < now) state.probes.delete(key);
  }, 15000); state.timer.unref();
  process.once('exit', () => { for (const session of state.sessions.values()) stop(session); });
}

/** Only administrator-saved HTTP(S) sources reach this module; never accept a browser URL. */
export async function probeMedia(value: string, options: { timeoutMs?: number } = {}): Promise<MediaProbe> {
  if (process.env.MEDIA_CONVERSION === 'false') throw new MediaRuntimeError('config', 'Video conversion is disabled on this server.');
  const url = allowed(value), key = hash(url), cached = state.probes.get(key);
  if (cached && cached.until > Date.now()) return cached.result;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(30000, Math.floor(options.timeoutMs!))) : 30000;
  if (state.probing >= 4) throw new MediaRuntimeError('capacity', 'The video server is busy. Please try again shortly.');
  state.probing++;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary('FFPROBE'), ['-v', 'error', ...inputOptions(url, timeoutMs), '-show_entries', 'format=duration:stream=index,codec_type,codec_name,width,height,duration,channels:stream_tags=language,title:stream_disposition=default,attached_pic', '-of', 'json', url], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.end(); let chunks: Buffer[] = [], size = 0, settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); error ? reject(error) : resolve(Buffer.concat(chunks).toString('utf8')); };
      const timer = setTimeout(() => finish(new MediaRuntimeError('source', 'The video server did not respond while opening the file.', 'upstream_timeout')), timeoutMs); timer.unref();
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 524288) finish(new MediaRuntimeError('source', 'This file has excessive or invalid video metadata.')); else chunks.push(chunk); });
      child.stderr.resume(); // Never expose private upstream addresses or credentials.
      child.on('error', () => finish(new MediaRuntimeError('config', 'FFmpeg and ffprobe must be installed on the video server.', 'media_tools_missing')));
      child.on('close', code => finish(code === 0 ? undefined : new MediaRuntimeError('source', 'The server could not open this video. The link may be unavailable, damaged or require access.', 'upstream_unreadable')));
    });
    let data: any; try { data = JSON.parse(output); } catch { throw new MediaRuntimeError('source', 'The file did not contain readable video metadata.'); }
    const streams: any[] = Array.isArray(data.streams) ? data.streams : [];
    const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic && stream.width > 0 && stream.height > 0);
    if (!video || !Number.isInteger(video.index)) throw new MediaRuntimeError('source', 'This link does not contain a playable video stream.', 'no_video');
    const duration = Number(data.format?.duration || video.duration);
    const result: MediaProbe = { duration: Number.isFinite(duration) && duration > 0 ? duration : null, videoIndex: video.index, videoCodec: String(video.codec_name || ''), height: Number(video.height) || 0,
      audioTracks: streams.filter(stream => stream.codec_type === 'audio' && Number.isInteger(stream.index)).map(stream => ({ index: stream.index, language: String(stream.tags?.language || '').slice(0, 32) || undefined, title: String(stream.tags?.title || '').slice(0, 100) || undefined, codec: stream.codec_name, channels: stream.channels, default: !!stream.disposition?.default })) };
    if (state.probes.size >= 500) state.probes.delete(state.probes.keys().next().value!);
    state.probes.set(key, { until: Date.now() + 300000, result }); return result;
  } finally { state.probing--; }
}

export async function startMediaSession(input: { sourceId: string; url: string; urlHash: string; viewer: string; startAt?: number; audioTrack?: number; live?: boolean }) {
  const probe = await probeMedia(input.url);
  if (running() >= maximum()) throw new MediaRuntimeError('capacity', 'The video server is busy. Please try again shortly.', 'media_capacity');
  if (input.audioTrack !== undefined && !probe.audioTracks.some(track => track.index === input.audioTrack)) throw new MediaRuntimeError('transient', 'That audio language is no longer available.');
  if (state.sessions.size >= 100) throw new MediaRuntimeError('capacity', 'The video server has too many pending requests. Please try again shortly.');
  const startAt = input.live ? 0 : Math.max(0, Math.min(Number(input.startAt) || 0, probe.duration ? Math.max(0, probe.duration - 0.1) : 86400));
  const id = randomBytes(24).toString('hex'); const now = Date.now();
  const session: MediaSession = { ...input, url: allowed(input.url), id, startAt, probe, touched: now, created: now, status: 'ready', bytes: 0, sequence: 0 };
  state.sessions.set(id, session);
  return { sessionId: id, duration: input.live ? null : probe.duration, startAt, audioTrack: input.audioTrack ?? probe.audioTracks.find(track => track.default)?.index ?? probe.audioTracks[0]?.index, audioTracks: probe.audioTracks };
}
function sessionFor(id: string, viewer: string) {
  const session = /^[a-f0-9]{48}$/.test(id) ? state.sessions.get(id) : undefined;
  if (!session || session.viewer !== viewer) throw new MediaRuntimeError('transient', 'This playback session expired. Press retry to continue.', 'media_expired');
  return session;
}
export function mediaSessionStatus(id: string, viewer: string) {
  const session = sessionFor(id, viewer); session.touched = Date.now();
  return { status: session.status, classification: session.classification, error: session.error, sourceId: session.sourceId, urlHash: session.urlHash };
}
export function stopMediaSession(id: string, viewer: string) { const session = state.sessions.get(id); if (session?.viewer === viewer) { stop(session); state.sessions.delete(id); } }

/** Native HLS devices request short, authorized same-origin fragments. */
export async function mediaHlsResource(id: string, viewer: string, name: string, query = '') {
  const session = sessionFor(id, viewer); session.touched = Date.now();
  if (!session.hls && !session.process && running() >= maximum()) throw new MediaRuntimeError('capacity', 'The video server is busy. Please try again shortly.', 'media_capacity');
  session.hls ||= new MediaHlsWindow(signal => streamMedia(id, viewer, signal, true));
  try { return await session.hls.resource(name, query); }
  catch (error) { if (error instanceof MediaRuntimeError) throw error; throw new MediaRuntimeError('transient', 'This video segment is unavailable. Press retry to continue.', 'media_segment_unavailable'); }
}

/** Stream fragmented H.264/AAC MP4 with bounded memory and no full-file download/cache. */
export async function streamMedia(id: string, viewer: string, signal: AbortSignal, hls = false): Promise<ReadableStream<Uint8Array>> {
  const session = sessionFor(id, viewer);
  if (signal.aborted) throw new MediaRuntimeError('transient', 'Playback request was canceled.');
  if (session.status === 'failed') throw new MediaRuntimeError(session.classification || 'source', session.error || 'This video could not start.');
  if (running() >= maximum() && !session.process && !session.hls) throw new MediaRuntimeError('capacity', 'The video server is busy. Please try again shortly.', 'media_capacity');
  stop(session, hls); const sequence = ++session.sequence;
  const track = session.audioTrack ?? session.probe.audioTracks.find(track => track.default)?.index ?? session.probe.audioTracks[0]?.index;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputOptions(session.url), '-threads', '2', '-readrate', '1.3', ...(session.startAt ? ['-ss', session.startAt.toFixed(3)] : []), '-i', session.url, '-map', `0:${session.probe.videoIndex}`, ...(track === undefined ? ['-an'] : ['-map', `0:${track}`, '-c:a', 'aac', '-ac', '2', '-b:a', String(MEDIA_RATE_LIMITS.audio)]), '-sn', '-dn', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', ...mediaRateArguments, '-threads', '2', '-vf', 'scale=trunc(min(1280\\,iw)/2)*2:-2', '-pix_fmt', 'yuv420p', '-r', '24', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-video_track_timescale', '24000', '-avoid_negative_ts', 'make_zero', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
  const child = spawn(binary('FFMPEG'), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); child.stdin.end();
  session.process = child; session.status = 'playing'; session.touched = Date.now(); session.bytes = 0;
  const current = () => session.sequence === sequence;
  let settled = false, closed = false, controller: ReadableStreamDefaultController<Uint8Array> | undefined, startupResolve: (value: ReadableStream<Uint8Array>) => void, startupReject: (error: Error) => void;
  const startup = new Promise<ReadableStream<Uint8Array>>((resolve, reject) => { startupResolve = resolve; startupReject = reject; });
  const abort = () => { if (current()) { stop(session); if (!['failed', 'expired'].includes(session.status)) session.status = 'ready'; } end(new MediaRuntimeError('transient', 'Playback request was canceled.', 'media_canceled')); };
  const end = (error?: MediaRuntimeError) => {
    if (closed) return; closed = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
    if (!settled) { settled = true; startupReject(error || new MediaRuntimeError('source', 'The video did not produce playable frames.')); }
    try { error ? controller?.error(error) : controller?.close(); } catch { /* Canceled response. */ }
  };
  const timer = setTimeout(() => { if (current()) fail(session, 'transient', 'Video preparation took too long. Please retry.'); end(new MediaRuntimeError('transient', 'Video preparation took too long. Please retry.', 'media_startup_timeout')); }, 45000); timer.unref();
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { session.touched = Date.now(); child.stdout.resume(); }, cancel() { abort(); } }, { highWaterMark: 262144, size: chunk => chunk.byteLength });
  signal.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', (chunk: Buffer) => {
    if (closed || !current()) return; session.bytes += chunk.length; session.touched = Date.now();
    controller!.enqueue(new Uint8Array(chunk)); if ((controller!.desiredSize || 0) <= 0) child.stdout.pause();
    // Wait for more than the empty MP4 header before confirming that preparation started.
    if (!settled && session.bytes > 4096) { settled = true; clearTimeout(timer); startupResolve(stream); }
  });
  child.stderr.resume();
  child.on('error', () => { if (current()) fail(session, 'config', 'FFmpeg is not available on the video server.'); end(new MediaRuntimeError('config', 'FFmpeg is not available on the video server.', 'media_tools_missing')); });
  child.on('close', code => {
    if (closed || !current()) return; session.process = undefined;
    if (code !== 0 || session.bytes < 4096) { fail(session, 'source', 'The server could not decode this video, or its connection stopped.'); end(new MediaRuntimeError('source', session.error!, 'media_decode_failed')); }
    else { session.status = 'complete'; if (!settled) { settled = true; startupResolve(stream); } end(); }
  });
  return startup;
}
