import { expect, it, vi } from 'vitest';
import { MediaHlsWindow } from '../lib/server/media-hls';

function box(type: string, body: Buffer) { const header = Buffer.alloc(8); header.writeUInt32BE(body.length + 8); header.write(type, 4); return Buffer.concat([header, body]); }
function fragment() {
  const tfhd = Buffer.alloc(12); tfhd.writeUIntBE(8, 1, 3); tfhd.writeUInt32BE(1, 4); tfhd.writeUInt32BE(1000, 8);
  const trun = Buffer.alloc(8); trun.writeUInt32BE(48, 4);
  return Buffer.concat([box('moof', box('traf', Buffer.concat([box('tfhd', tfhd), box('trun', trun)]))), box('mdat', Buffer.from('frames'))]);
}
const names = (body: Buffer) => body.toString().split('\n').filter(line => /^segment-/.test(line));

it('keeps a paused viewer within a bounded HLS window even when many fragments arrive together', async () => {
  let canceled = false;
  const bytes = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', Buffer.alloc(0)), ...Array.from({ length: 100 }, fragment)]);
  const window = new MediaHlsWindow(async () => new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { canceled = true; } }));
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const first = await window.resource('index.m3u8');
    expect(names(first.body)).toHaveLength(8);
    expect(first.body.toString()).toContain('#EXTINF:2.000000,');
    expect(names((await window.resource('index.m3u8')).body)).toHaveLength(8);
    await window.resource('segment-7.m4s');
    // Allow the already-blocked producer to resume, rather than requesting a future segment.
    await new Promise(resolve => setTimeout(resolve, 0));
    const advanced = await window.resource('index.m3u8');
    expect(names(advanced.body).length).toBeLessThanOrEqual(11);
    expect(advanced.body.toString()).toContain('#EXT-X-MEDIA-SEQUENCE:5');
    // A slow or reordered request from the previous manifest remains valid.
    expect((await window.resource('segment-0.m4s')).body.length).toBeGreaterThan(0);
    clock.mockReturnValue(now + 60000);
    await expect(window.resource('segment-0.m4s')).rejects.toThrow(/expired/);
  } finally { window.stop(); clock.mockRestore(); }
  expect(canceled).toBe(true);
});

it('ends the manifest for finite video, rejects unknown paths and cancels an idle producer', async () => {
  const bytes = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', Buffer.alloc(0)), fragment()]);
  const window = new MediaHlsWindow(async () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
  expect((await window.resource('index.m3u8')).body.toString()).toContain('#EXT-X-ENDLIST');
  await expect(window.resource('../private')).rejects.toThrow(/Unknown/);
  window.stop();
  await expect(window.resource('init.mp4')).rejects.toThrow(/expired/);
});

it('cancels the producer after malformed converted output instead of retaining a failed window', async () => {
  let canceled = false;
  const window = new MediaHlsWindow(async () => new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(8)); }, cancel() { canceled = true; } }));
  await expect(window.resource('index.m3u8')).rejects.toThrow(/segment limit/);
  expect(canceled).toBe(true);
  await expect(window.resource('init.mp4')).rejects.toThrow(/segment limit/);
});
