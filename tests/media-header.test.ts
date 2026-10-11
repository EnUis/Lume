import { describe, expect, it } from 'vitest';
import { isMediaBytes, verifyStream } from '../lib/server/health';
import type { SafeFetcher } from '../lib/server/outbound';

const magic = Buffer.from('1a45dfa3', 'hex');
function vint(value: number, width?: number) {
  let count = width || 1; while (!width && BigInt(value) >= (1n << BigInt(count * 7)) - 1n) count++;
  const buffer = Buffer.alloc(count); let encoded = BigInt(value) | 1n << BigInt(count * 7);
  for (let index = count - 1; index >= 0; index--) { buffer[index] = Number(encoded & 255n); encoded >>= 8n; } return buffer;
}
function field(id: string, body: Buffer, width?: number) { return Buffer.concat([Buffer.from(id, 'hex'), vint(body.length, width), body]); }
function document(header: Buffer, sizeWidth?: number) {
  return Buffer.concat([magic, vint(header.length, sizeWidth), header, Buffer.from('18538067ff', 'hex'), Buffer.alloc(16)]);
}
const defaults = Buffer.concat([field('4286', Buffer.from([1])), field('42f7', Buffer.from([1])), field('42f2', Buffer.from([4])), field('42f3', Buffer.from([8])), field('4287', Buffer.from([4])), field('4285', Buffer.from([2]))]);
function container(docType: string) { return document(Buffer.concat([defaults, field('4282', Buffer.from(docType))])); }
function fetcher(body: Buffer): SafeFetcher { return async url => ({ url, status: 206, body, headers: { 'content-type': 'application/octet-stream' }, truncated: true }); }
async function verify(body: Buffer, format: 'unknown' | 'webm' = 'unknown') { return verifyStream('https://media.example/movie.bin', format, fetcher(body)); }

describe('bounded EBML container detection', () => {
  it('verifies WebM by the declared DocType rather than a URL or MIME hint', async () => {
    const body = container('webm'); expect(isMediaBytes(body)).toBe(true);
    expect(await verify(body)).toMatchObject({ ok: true, format: 'webm', error: null });
  });

  it('accepts Matroska through a real video probe even when mislabeled WebM, without trusting its header alone', async () => {
    const body = container('matroska'); expect(isMediaBytes(body)).toBe(false);
    const video = { duration: 90, videoIndex: 0, videoCodec: 'mpeg4', height: 576, audioTracks: [] };
    expect(await verifyStream('https://media.example/movie.bin', 'webm', fetcher(body), async () => video)).toMatchObject({ ok: true, format: 'unknown', quality: '576p', error: null });
    expect(await verifyStream('https://media.example/movie.bin', 'webm', fetcher(body), async () => { throw new Error('No readable video'); })).toMatchObject({ ok: false, error: 'No readable video' });
  });

  it('handles padded strings, reordered fields and multibyte header/field lengths', async () => {
    const body = document(Buffer.concat([field('ec', Buffer.alloc(160)), field('4282', Buffer.from('webm\0\0'), 2), defaults]), 3);
    expect(isMediaBytes(body)).toBe(true); expect((await verify(body)).ok).toBe(true);
  });

  it('does not find a spoofed WebM DocType inside a skipped Void payload or outside the header', async () => {
    const spoof = field('4282', Buffer.from('webm'));
    const insideVoid = document(Buffer.concat([defaults, field('ec', spoof)]));
    const outsideHeader = Buffer.concat([document(defaults), spoof]);
    for (const body of [insideVoid, outsideHeader]) { expect(isMediaBytes(body)).toBe(false); expect(await verify(body)).toMatchObject({ ok: false, error: 'EBML header is missing its document type' }); }
  });

  it('rejects incomplete IDs, sizes, header bodies and child payloads without reading beyond bounds', async () => {
    const valid = container('webm');
    const malformed = [
      magic,
      Buffer.concat([magic, Buffer.from([0x40])]),
      valid.subarray(0, 12),
      document(Buffer.from([0x42])),
      document(Buffer.from([0x42, 0x82, 0x40])),
      document(Buffer.from([0x42, 0x82, 0x88, 0x77, 0x65, 0x62, 0x6d])),
      Buffer.concat([magic, Buffer.from([0]), Buffer.alloc(24)]),
    ];
    for (const body of malformed) { expect(isMediaBytes(body)).toBe(false); expect(await verify(body)).toMatchObject({ ok: false, error: 'Invalid or truncated EBML header' }); }
  });

  it('rejects unknown-sized headers, reserved IDs, excessive header sizes and field counts', async () => {
    const cases: [Buffer, string][] = [
      [Buffer.concat([magic, Buffer.from([0xff]), Buffer.alloc(32)]), 'Unknown-sized EBML header fields are unsupported'],
      [document(Buffer.from([0x42, 0x82, 0xff])), 'Unknown-sized EBML header fields are unsupported'],
      [document(Buffer.from([0xff, 0x80])), 'Invalid EBML header element ID'],
      [document(Buffer.concat([field('ec', Buffer.alloc(4100)), field('4282', Buffer.from('webm'))])), 'EBML header exceeds the verification limit'],
      [document(Buffer.concat([...Array(129)].map(() => field('ec', Buffer.alloc(0))).concat([field('4282', Buffer.from('webm'))]))), 'EBML header field limit exceeded'],
    ];
    for (const [body, error] of cases) { expect(isMediaBytes(body)).toBe(false); expect(await verify(body)).toMatchObject({ ok: false, error }); }
  });

  it('rejects duplicate, empty, invalid ASCII and unrecognized document types', async () => {
    const invalid = [
      document(Buffer.concat([field('4282', Buffer.from('webm')), field('4282', Buffer.from('matroska'))])),
      document(field('4282', Buffer.alloc(0))),
      document(field('4282', Buffer.from([0x77, 0x65, 0x62, 0xed]))),
      document(field('4282', Buffer.from('webm\0other'))),
    ];
    for (const body of invalid) { expect(isMediaBytes(body)).toBe(false); expect(await verify(body)).toMatchObject({ ok: false, error: 'Invalid EBML document type' }); }
    expect(await verify(container('other'))).toMatchObject({ ok: false, format: 'unknown', error: 'Unsupported EBML document type for browser playback' });
  });

  it('retains MP4 and MPEG-TS sample detection', async () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
    const ts = Buffer.alloc(564); ts[0] = 0x47; ts[188] = 0x47; ts[376] = 0x47;
    expect(isMediaBytes(mp4)).toBe(true); expect((await verify(mp4)).ok).toBe(true); expect(isMediaBytes(ts)).toBe(true);
  });
});
