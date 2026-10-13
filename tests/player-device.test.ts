import { afterEach, expect, it, vi } from 'vitest';
import { needsServerPlayback, playbackFetch, playRejection, type PlaybackCapabilities } from '../lib/player-device';
import type { Source } from '../lib/types';

const phone: PlaybackCapabilities = { pageUrl: 'https://lume.example/watch/movie', nativeHls: true, mediaSource: false, mp4: true, webm: false };
const source = (format: Source['format'], url = 'https://media.example/video'): Source => ({ id: 'one', titleId: 'movie', episodeId: null, name: 'One', format, health: 'healthy', enabled: true, priority: 0, quality: null, lastChecked: null, lastSuccess: null, error: null, url });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('routes insecure upstream video through same-origin conversion on an HTTPS phone or desktop', () => {
  for (const format of ['mp4', 'hls', 'dash', 'webm'] as const) expect(needsServerPlayback(source(format, 'http://media.example:8080/video'), phone)).toBe(true);
  expect(needsServerPlayback(source('mp4'), phone)).toBe(false);
  expect(needsServerPlayback(source('mp4', 'http://media.example/video'), { ...phone, pageUrl: 'http://localhost:3000' })).toBe(false);
});

it('uses native HLS on phones but converts unsupported DASH, WebM and MKV', () => {
  expect(needsServerPlayback(source('hls'), phone)).toBe(false);
  for (const format of ['dash', 'webm', 'unknown'] as const) expect(needsServerPlayback(source(format), phone)).toBe(true);
  expect(needsServerPlayback(source('dash'), { ...phone, mediaSource: true })).toBe(false);
  expect(needsServerPlayback({ ...source('hls', '/api/media/session/hls/index.m3u8'), conversion: { sessionId: 'session', duration: 300, startAt: 0, audioTracks: [] } }, phone)).toBe(false);
});

it('distinguishes browser gesture requirements and canceled source changes from decoding failures', () => {
  expect(playRejection(new DOMException('', 'NotAllowedError'))).toBe('gesture');
  expect(playRejection(new DOMException('', 'AbortError'))).toBe('interrupted');
  expect(playRejection(new DOMException('', 'NotSupportedError'))).toBe('unsupported');
});

it('bounds requests and propagates cancellation without AbortSignal.any or timeout', async () => {
  vi.useFakeTimers();
  const seen: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((_input, init) => new Promise((_resolve, reject) => {
    seen.push(init.signal);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  })));
  const timed = playbackFetch('/api/playback/prepare', {}, 100);
  const assertion = expect(timed).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(100); await assertion;
  const controller = new AbortController(); const canceled = playbackFetch('/api/playback/prepare', { signal: controller.signal });
  const canceledAssertion = expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await canceledAssertion;
  expect(seen.every(signal => signal.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps timeout and caller cancellation active after headers arrive while the JSON body is stalled', async () => {
  vi.useFakeTimers();
  let canceled = 0;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { canceled++; } }), { headers: { 'content-type': 'application/json' } })));
  const request = playbackFetch('/api/playback/prepare', {}, 100);
  const assertion = expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(100); await assertion;
  const controller = new AbortController();
  const second = playbackFetch('/api/playback/prepare', { signal: controller.signal });
  const secondAssertion = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1); controller.abort(); await secondAssertion;
  expect(canceled).toBe(2); expect(vi.getTimerCount()).toBe(0);
});

it('allows a separately bounded large merged-series detail without expanding control-response limits', async () => {
  const episodes = Array.from({ length: 12000 }, (_, number) => ({ id: `episode-${number}`, number, name: 'A long running multilingual series episode', sources: [{ id: `english-${number}`, language: 'en' }, { id: `german-${number}`, language: 'de' }] }));
  const body = JSON.stringify({ title: { episodes } });
  expect(body.length).toBeGreaterThan(2 * 1024 * 1024);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } })));
  await expect(playbackFetch('/api/playback/prepare')).rejects.toThrow('too large');
  const response = await playbackFetch('/api/titles/large-series', {}, 30000, 16 * 1024 * 1024);
  expect((await response.json()).title.episodes).toHaveLength(12000);
});
