import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv } from 'node:crypto';
import { verifyStream } from '../lib/server/health';
import type { FetchResult, SafeFetcher } from '../lib/server/outbound';

const media = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
const fragment = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('moof'), Buffer.alloc(68)]);
function response(url: string, body: string | Buffer, status = 200, headers: Record<string, string> = {}): FetchResult { return { url, body: Buffer.isBuffer(body) ? body : Buffer.from(body), status, headers, truncated: false }; }
function encrypt(body: Buffer, key: Buffer, sequence: number | Buffer) {
  const iv = Buffer.isBuffer(sequence) ? sequence : Buffer.alloc(16); if (typeof sequence === 'number') iv.writeBigUInt64BE(BigInt(sequence), 8);
  const cipher = createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([cipher.update(body), cipher.final()]);
}
function fixture(manifest: string, resources: Record<string, Buffer | string>, calls: string[] = []): SafeFetcher {
  return async url => { const name = new URL(url).pathname.slice(1); calls.push(name); if (name === 'playlist.m3u8') return response(url, manifest); return resources[name] === undefined ? response(url, 'missing', 404) : response(url, resources[name]); };
}
afterEach(() => vi.restoreAllMocks());

describe('bounded HLS verification', () => {
  it('verifies a working variant after the first rendition fails', async () => {
    const calls: string[] = [];
    const fetcher = fixture('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360\nbroken.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=1280x720\nworking.m3u8', { 'working.m3u8': '#EXTM3U\n#EXTINF:6,\nvideo.mp4\n#EXT-X-ENDLIST', 'video.mp4': media }, calls);
    expect(await verifyStream('https://media.example/playlist.m3u8', 'hls', fetcher)).toMatchObject({ ok: true, format: 'hls', quality: '720p' });
    expect(calls).toEqual(['playlist.m3u8', 'broken.m3u8', 'working.m3u8', 'video.mp4']);
  });

  it('attempts at most three distinct variants instead of probing an unbounded list', async () => {
    const calls: string[] = [];
    const manifest = '#EXTM3U\n' + Array.from({ length: 30 }, (_, index) => `#EXT-X-STREAM-INF:BANDWIDTH=${index + 1}\nvariant${index}.m3u8`).join('\n');
    const fetcher = fixture(manifest, { 'variant3.m3u8': '#EXTM3U\n#EXTINF:6,\nvideo.mp4', 'video.mp4': media }, calls);
    expect((await verifyStream('https://media.example/playlist.m3u8', 'hls', fetcher)).ok).toBe(false);
    expect(calls).toEqual(['playlist.m3u8', 'variant0.m3u8', 'variant1.m3u8', 'variant2.m3u8']);
  });

  it('shares a twenty-request budget across nested fallback branches', async () => {
    let requests = 0;
    const fetcher: SafeFetcher = async url => { requests++; return response(url, '#EXTM3U\n' + ['a', 'b', 'c'].map(name => `#EXT-X-STREAM-INF:BANDWIDTH=1\n${new URL(url).pathname}/${name}.m3u8`).join('\n')); };
    const result = await verifyStream('https://media.example/playlist.m3u8', 'hls', fetcher);
    expect(result).toMatchObject({ ok: false, error: 'Stream verification request limit exceeded' }); expect(requests).toBe(20);
  });

  it('shares the total deadline instead of resetting it for each rendition', async () => {
    let now = 0; let requests = 0; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher: SafeFetcher = async url => { requests++; now = 30001; return response(url, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo.m3u8'); };
    expect(await verifyStream('https://media.example/playlist.m3u8', 'hls', fetcher)).toMatchObject({ ok: false, error: 'Stream verification timeout' }); expect(requests).toBe(1);
  });

  it('uses each sampled segment key and implicit media-sequence IV after rotation', async () => {
    const firstKey = Buffer.alloc(16, 2), lastKey = Buffer.alloc(16, 3); const calls: string[] = [];
    const manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:90\n#EXT-X-KEY:METHOD=AES-128,URI="first.key"\n#EXTINF:6,\nfirst.ts\n#EXT-X-KEY:METHOD=AES-128,URI="last.key"\n#EXTINF:6,\nmiddle.ts\n#EXTINF:6,\nlast.ts\n#EXT-X-ENDLIST';
    const fetcher = fixture(manifest, { 'first.key': firstKey, 'last.key': lastKey, 'first.ts': encrypt(media, firstKey, 90), 'last.ts': encrypt(media, lastKey, 92) }, calls);
    expect((await verifyStream('https://media.example/playlist.m3u8', 'hls', fetcher)).ok).toBe(true);
    expect(calls).toContain('first.key'); expect(calls).toContain('last.key'); expect(calls).not.toContain('middle.ts');
  });

  it('preserves per-segment explicit IVs and the transition to METHOD=NONE', async () => {
    const key = Buffer.alloc(16, 8); const firstIv = Buffer.alloc(16); firstIv[15] = 1;
    const lastIv = Buffer.alloc(16); lastIv[15] = 2;
    const rotated = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01\n#EXTINF:6,\nfirst.ts\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x02\n#EXTINF:6,\nlast.ts';
    expect((await verifyStream('https://media.example/playlist.m3u8', 'hls', fixture(rotated, { 'key.bin': key, 'first.ts': encrypt(media, key, firstIv), 'last.ts': encrypt(media, key, lastIv) }))).ok).toBe(true);
    const clear = rotated.replace('METHOD=AES-128,URI="key.bin",IV=0x02', 'METHOD=NONE');
    expect((await verifyStream('https://media.example/playlist.m3u8', 'hls', fixture(clear, { 'key.bin': key, 'first.ts': encrypt(media, key, firstIv), 'last.ts': media }))).ok).toBe(true);
    expect((await verifyStream('https://media.example/playlist.m3u8', 'hls', fixture(clear, { 'key.bin': key, 'first.ts': encrypt(media, key, firstIv), 'last.ts': Buffer.alloc(64) }))).ok).toBe(false);
  });

  it('keeps initialization-map encryption state distinct from later segment keys', async () => {
    const key = Buffer.alloc(16, 2);
    const manifest = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nfragment.mp4';
    expect((await verifyStream('https://media.example/playlist.m3u8', 'hls', fixture(manifest, { 'init.mp4': media, 'key.bin': key, 'fragment.mp4': encrypt(fragment, key, 0) }))).ok).toBe(true);
  });

  it('verifies map replacement and rotated map keys without reusing the first initialization', async () => {
    const firstKey = Buffer.alloc(16, 2), lastKey = Buffer.alloc(16, 3); const firstIv = Buffer.alloc(16, 1), lastIv = Buffer.alloc(16, 2); const calls: string[] = [];
    const manifest = `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="first.key",IV=0x${firstIv.toString('hex')}\n#EXT-X-MAP:URI="first-init.mp4"\n#EXTINF:6,\nfirst.mp4\n#EXT-X-KEY:METHOD=AES-128,URI="last.key",IV=0x${lastIv.toString('hex')}\n#EXT-X-MAP:URI="last-init.mp4"\n#EXTINF:6,\nlast.mp4`;
    const resources = { 'first.key': firstKey, 'last.key': lastKey, 'first-init.mp4': encrypt(media, firstKey, firstIv), 'last-init.mp4': encrypt(media, lastKey, lastIv), 'first.mp4': encrypt(fragment, firstKey, firstIv), 'last.mp4': encrypt(fragment, lastKey, lastIv) };
    expect((await verifyStream('https://media.example/playlist.m3u8', 'hls', fixture(manifest, resources, calls))).ok).toBe(true);
    expect(calls).toContain('first-init.mp4'); expect(calls).toContain('last-init.mp4');
    expect((await verifyStream('https://media.example/playlist.m3u8', 'hls', fixture(manifest, { ...resources, 'last-init.mp4': Buffer.alloc(64) }))).ok).toBe(false);
  });

  it('samples both byte ranges when segments reuse a URI and honors map offsets', async () => {
    const requests: { name: string; range?: string }[] = [];
    const manifest = '#EXTM3U\n#EXT-X-MAP:URI="shared.mp4",BYTERANGE="76@20"\n#EXTINF:6,\n#EXT-X-BYTERANGE:76@96\nshared.mp4\n#EXTINF:6,\n#EXT-X-BYTERANGE:76\nshared.mp4';
    const fetcher: SafeFetcher = async (url, options) => {
      const name = new URL(url).pathname.slice(1); requests.push({ name, range: options?.headers?.Range });
      if (name === 'playlist.m3u8') return response(url, manifest);
      const range = options?.headers?.Range!; const [offset, end] = range.slice(6).split('-').map(Number);
      return response(url, offset === 20 ? media : fragment, 206, { 'content-range': `bytes ${offset}-${end}/248` });
    };
    expect((await verifyStream('https://media.example/playlist.m3u8', 'hls', fetcher)).ok).toBe(true);
    expect(requests.map(request => request.range).filter(Boolean)).toEqual(['bytes=20-95', 'bytes=96-171', 'bytes=172-247']);
    const ignored: SafeFetcher = async (url, options) => url.endsWith('.m3u8') ? fetcher(url, options) : response(url, media);
    expect((await verifyStream('https://media.example/playlist.m3u8', 'hls', ignored)).ok).toBe(false);
  });

  it('rejects DRM, malformed IVs, missing keys, invalid ranges and incomplete segments', async () => {
    const invalid = [
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"\n#EXTINF:6,\nvideo.mp4',
      '#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="licensed-drm",URI="key.bin"\n#EXTINF:6,\nvideo.mp4',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0xGHI\n#EXTINF:6,\nvideo.mp4',
      '#EXT-X-KEY:METHOD=AES-128\n#EXTINF:6,\nvideo.mp4',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nvideo.mp4',
      '#EXTINF:6,\n#EXT-X-BYTERANGE:76\nvideo.mp4',
      '#EXTINF:6,',
    ];
    for (const tags of invalid) expect((await verifyStream('https://media.example/playlist.m3u8', 'hls', fixture(`#EXTM3U\n${tags}`, { 'key.bin': Buffer.alloc(16), 'init.mp4': media, 'video.mp4': media }))).ok, tags).toBe(false);
  });
});
