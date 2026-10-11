import { describe, expect, it } from 'vitest';
import { verifyStream } from '../lib/server/health';
import type { SafeFetcher } from '../lib/server/outbound';

const video = { duration: null, videoIndex: 0, videoCodec: 'h264', height: 720, audioTracks: [] };
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
const transport = Buffer.alloc(188 * 3); transport[0] = transport[188] = transport[376] = 0x47;
const padding = '# provider comment\n'.repeat(4000);

describe('bounded initial video samples', () => {
  it('samples unknown transport streams with 64 KB while retaining the real media probe', async () => {
    let probes = 0; const calls: Parameters<SafeFetcher>[1][] = [];
    const fetcher: SafeFetcher = async (url, options) => { calls.push(options); return { url, status: 206, headers: {}, body: transport, truncated: true }; };
    const result = await verifyStream('https://fixture.example/video.bin', 'unknown', fetcher, async () => { probes++; return video; });
    expect(result).toMatchObject({ ok: true, format: 'unknown', quality: '720p' });
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ range: true, maxBytes: 65536, timeoutMs: 10000 }); expect(probes).toBe(1);
    expect(await verifyStream('https://fixture.example/broken.bin', 'unknown', fetcher, async () => { throw new Error('No playable video'); })).toMatchObject({ ok: false });
  });

  it('refetches a large discovered HLS manifest and still verifies its final segment', async () => {
    for (const brokenEnd of [false, true]) {
      const manifest = Buffer.from(`#EXTM3U\n${padding}#EXTINF:4,\nfirst.ts\n#EXTINF:4,\nlast.ts\n`);
      const calls: Array<{ url: string; options: Parameters<SafeFetcher>[1] }> = [];
      const fetcher: SafeFetcher = async (url, options) => {
        calls.push({ url, options });
        const body = url.endsWith('/playlist') ? manifest : brokenEnd && url.endsWith('/last.ts') ? Buffer.from('<html>expired stream</html>') : transport;
        const limit = options?.maxBytes || body.length;
        return { url, status: 200, headers: {}, body: body.subarray(0, limit), truncated: body.length > limit };
      };
      const result = await verifyStream('https://fixture.example/playlist', 'unknown', fetcher);
      expect(result.ok).toBe(!brokenEnd);
      const manifests = calls.filter(call => call.url.endsWith('/playlist'));
      expect(manifests.map(call => call.options?.maxBytes)).toEqual([65536, 512000]);
      expect(manifests[0].options?.range).toBe(true); expect(manifests[1].options?.range).toBeUndefined();
      expect(calls.some(call => call.url.endsWith('/last.ts'))).toBe(true);
    }
  });

  it('refetches discovered DASH before checking initialization and media segments', async () => {
    const manifest = Buffer.from(`<MPD><!--${'x'.repeat(70000)}--><Period><AdaptationSet><SegmentTemplate initialization="init.mp4" media="segment-$Number$.m4s" startNumber="1"/><Representation id="video" bandwidth="1000" height="720"/></AdaptationSet></Period></MPD>`);
    const calls: string[] = [];
    const fetcher: SafeFetcher = async (url, options) => {
      calls.push(url); const body = url.endsWith('/manifest') ? manifest : mp4, limit = options?.maxBytes || body.length;
      return { url, status: 200, headers: {}, body: body.subarray(0, limit), truncated: body.length > limit };
    };
    expect(await verifyStream('https://fixture.example/manifest', 'unknown', fetcher)).toMatchObject({ ok: true, format: 'dash', quality: '720p' });
    expect(calls.filter(url => url.endsWith('/manifest'))).toHaveLength(2);
    expect(calls).toContain('https://fixture.example/init.mp4'); expect(calls).toContain('https://fixture.example/segment-1.m4s');
  });

  it('retains the 512 KB manifest cap and rejects protection data beyond the sniff', async () => {
    for (const manifest of [`#EXTM3U\n${'#'.repeat(520000)}\n#EXTINF:4,\nsegment.ts`, `<MPD><!--${'x'.repeat(70000)}--><ContentProtection/><Representation id="video"/></MPD>`]) {
      const requests: number[] = [];
      const fetcher: SafeFetcher = async (url, options) => {
        const body = Buffer.from(manifest), limit = options?.maxBytes || body.length; requests.push(limit);
        return { url, status: 200, headers: {}, body: body.subarray(0, limit), truncated: body.length > limit };
      };
      expect((await verifyStream('https://fixture.example/protected', 'unknown', fetcher)).ok).toBe(false);
      expect(requests).toEqual([65536, 512000]);
    }
  });
});
