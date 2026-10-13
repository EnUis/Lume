import type { Source } from './types';

export type PlaybackCapabilities = { pageUrl: string; nativeHls: boolean; mediaSource: boolean; mp4: boolean; webm: boolean };

export function needsServerPlayback(source: Source, device: PlaybackCapabilities): boolean {
  if (source.conversion) return false;
  if (source.conversionRequired || source.format === 'unknown') return true;
  try { if (new URL(device.pageUrl).protocol === 'https:' && new URL(source.url || '', device.pageUrl).protocol === 'http:') return true; } catch { return true; }
  if (source.format === 'dash') return !device.mediaSource;
  if (source.format === 'hls') return !device.nativeHls && !device.mediaSource;
  return source.format === 'webm' ? !device.webm : source.format === 'mp4' && !device.mp4;
}

export function playRejection(error: unknown): 'gesture' | 'interrupted' | 'unsupported' | 'other' {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotAllowedError' ? 'gesture' : name === 'AbortError' ? 'interrupted' : name === 'NotSupportedError' ? 'unsupported' : 'other';
}

/** Bounded JSON requests for mobile browsers without AbortSignal.any/timeout. */
export async function playbackFetch(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 8000, maxBytes = 2 * 1024 * 1024): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Playback request timed out.', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (!response.body) return response;
    const reader = response.body.getReader();
    const cancelBody = () => { void reader.cancel(controller.signal.reason).catch(() => {}); };
    controller.signal.addEventListener('abort', cancelBody, { once: true });
    try {
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const next = await reader.read();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (next.done) break;
        length += next.value.byteLength;
        if (length > maxBytes) { await reader.cancel(); throw new Error('Playback response is too large.'); }
        chunks.push(next.value);
      }
      const body = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.delete('content-length');
      return new Response(body, { status: response.status, statusText: response.statusText, headers });
    } finally { controller.signal.removeEventListener('abort', cancelBody); reader.releaseLock(); }
  }
  finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
}
