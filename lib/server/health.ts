import type { Source } from '../types';
import { safeFetch, type FetchResult, type SafeFetcher } from './outbound';
import { sanitizeError } from './security';
import { createDecipheriv } from 'node:crypto';
import { probeMedia, MediaRuntimeError, type MediaProbe } from './media-runtime';

export interface HealthResult { ok: boolean; format: Source['format']; error: string | null; latencyMs: number; quality: string | null; retryable?: boolean; }
function ensureOk(response: FetchResult) { if (![200, 206].includes(response.status)) throw new Error(`Upstream HTTP ${response.status}${response.status === 401 || response.status === 403 ? ' (authentication or authorization required)' : ''}`); }
const ebmlMagic = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
function isEbml(bytes: Buffer) { return bytes.subarray(0, 4).equals(ebmlMagic); }
function ebmlVint(bytes: Buffer, offset: number, end: number, id = false) {
  if (offset >= end) throw new Error('Invalid or truncated EBML header');
  const first = bytes[offset]; let width = 1; let mask = 0x80;
  while (width <= (id ? 4 : 8) && !(first & mask)) { width++; mask >>= 1; }
  if (width > (id ? 4 : 8) || offset + width > end) throw new Error('Invalid or truncated EBML header');
  let value = BigInt(id ? first : first & (mask - 1));
  for (let index = 1; index < width; index++) value = value * 256n + BigInt(bytes[offset + index]);
  const maximum = (1n << BigInt(width * 7)) - 1n;
  if (id && (value & maximum) === maximum) throw new Error('Invalid EBML header element ID');
  if (!id && value === maximum) throw new Error('Unknown-sized EBML header fields are unsupported');
  return { value, end: offset + width };
}
function ebmlDocType(bytes: Buffer) {
  // The bounded, finite EBML Header identifies the container. WebM and
  // Matroska share the outer signature; finding a string elsewhere is unsafe.
  const size = ebmlVint(bytes, 4, bytes.length);
  if (size.value > 4096n) throw new Error('EBML header exceeds the verification limit');
  const end = size.end + Number(size.value); if (end > bytes.length) throw new Error('Invalid or truncated EBML header');
  let offset = size.end; let fields = 0; let docType: string | null = null;
  while (offset < end) {
    if (++fields > 128) throw new Error('EBML header field limit exceeded');
    const id = ebmlVint(bytes, offset, end, true); const length = ebmlVint(bytes, id.end, end);
    if (length.value > BigInt(end - length.end)) throw new Error('Invalid or truncated EBML header');
    const next = length.end + Number(length.value);
    if (id.value === 0x4282n) {
      if (docType !== null || length.value < 1n || length.value > 32n) throw new Error('Invalid EBML document type');
      const value = bytes.subarray(length.end, next); const zero = value.indexOf(0); const text = zero < 0 ? value : value.subarray(0, zero);
      if (!text.length || text.some(byte => byte < 0x20 || byte > 0x7e) || zero >= 0 && value.subarray(zero).some(byte => byte !== 0)) throw new Error('Invalid EBML document type');
      docType = text.toString('ascii');
    }
    offset = next;
  }
  if (docType === null) throw new Error('EBML header is missing its document type');
  return docType;
}
export function isMediaBytes(bytes: Buffer) {
  if (bytes.length < 16) return false;
  if (isEbml(bytes)) { try { return ebmlDocType(bytes) === 'webm'; } catch { return false; } }
  for (const offset of [4, 8, 12]) if (/^(ftyp|styp|moof|moov|mdat)$/.test(bytes.toString('ascii', offset, offset + 4))) return true;
  if (bytes[0] === 0x47 && (bytes[188] === 0x47 || bytes[376] === 0x47)) return true;
  return false;
}
async function sample(url: string, fetcher: SafeFetcher) {
  const response = await fetcher(url, { range: true, maxBytes: 65536, timeoutMs: 10000 }); ensureOk(response);
  if (!isMediaBytes(response.body)) throw new Error('Resource did not contain a supported video container');
  return response;
}
type HlsKey = { uri: string; iv: Buffer | null };
type HlsRange = { uri: string; offset: number; length: number };
type HlsMap = { uri: string; range: HlsRange | null; key: HlsKey | null };
type HlsSegment = { uri: string; range: HlsRange | null; key: HlsKey | null; map: HlsMap | null; index: number };
function hlsAttributes(line: string) {
  return Object.fromEntries([...line.slice(line.indexOf(':') + 1).matchAll(/(?:^|,)\s*([A-Z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,]*))/g)].map(match => [match[1], match[2] ?? match[3].trim()]));
}
function hlsRange(value: string, uri: string, previous: HlsRange | null): HlsRange {
  const parts = value.match(/^(\d+)(?:@(\d+))?$/); if (!parts) throw new Error('Invalid HLS byte range');
  const length = Number(parts[1]); const offset = parts[2] === undefined ? previous?.uri === uri ? previous.offset + previous.length : NaN : Number(parts[2]);
  if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + length)) throw new Error('Invalid or missing HLS byte range offset');
  return { uri, offset, length };
}
async function hlsResource(uri: string, range: HlsRange | null, fetcher: SafeFetcher) {
  const length = Math.min(range?.length || 65536, 65536);
  const resource = await fetcher(uri, { range: !range, maxBytes: length, timeoutMs: 10000, ...(range ? { headers: { Range: `bytes=${range.offset}-${range.offset + length - 1}` } } : {}) }); ensureOk(resource);
  if (range) {
    const contentRange = resource.headers['content-range']?.match(/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i);
    if (resource.status === 206 && (!contentRange || Number(contentRange[1]) !== range.offset) || resource.status === 200 && range.offset > 0) throw new Error('Upstream did not honor the HLS byte range');
  }
  return resource.body;
}
async function hls(response: FetchResult, fetcher: SafeFetcher, depth = 0): Promise<string | null> {
  if (depth > 2) throw new Error('HLS playlist nesting exceeds supported depth');
  if (response.truncated) throw new Error('HLS manifest is too large');
  const text = response.body.toString('utf8').replace(/^\uFEFF/, '');
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS manifest');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.some(line => line.startsWith('#EXT-X-STREAM-INF:'))) {
    const variants: { uri: string; height: string | null }[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
      let following = index + 1;
      while (following < lines.length && lines[following].startsWith('#') && !lines[following].startsWith('#EXT-X-STREAM-INF:')) following++;
      if (following >= lines.length || lines[following].startsWith('#')) continue;
      const uri = new URL(lines[following], response.url).toString();
      if (!variants.some(variant => variant.uri === uri)) variants.push({ uri, height: hlsAttributes(lines[index]).RESOLUTION?.match(/^\d+x(\d+)$/)?.[1] || null });
    }
    if (!variants.length) throw new Error('HLS master has no playable variant');
    let failure: unknown = new Error('HLS master has no verified variant');
    // A missing rendition must not hide another working quality. The shared
    // verification budget also bounds retries across nested master playlists.
    for (const variant of variants.slice(0, 3)) {
      try {
        const nested = await fetcher(variant.uri, { maxBytes: 512000, timeoutMs: 10000 }); ensureOk(nested);
        const quality = await hls(nested, fetcher, depth + 1); return variant.height ? `${variant.height}p` : quality;
      } catch (error) { failure = error; }
    }
    throw failure;
  }
  const segments: HlsSegment[] = []; let key: HlsKey | null = null; let map: HlsMap | null = null;
  let timed = false; let pendingRange: string | null = null; let previousRange: HlsRange | null = null; let previousMapRange: HlsRange | null = null;
  const sequenceText = lines.find(line => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))?.split(':')[1] || '0'; if (!/^\d{1,20}$/.test(sequenceText)) throw new Error('Invalid HLS media sequence');
  const sequence = BigInt(sequenceText); if (sequence > 0xffffffffffffffffn) throw new Error('Invalid HLS media sequence');
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:')) {
      const attributes = hlsAttributes(line);
      if (attributes.METHOD === 'NONE') { key = null; continue; }
      if (!attributes.METHOD) throw new Error('HLS encryption method is missing');
      if (attributes.METHOD !== 'AES-128' || attributes.KEYFORMAT && attributes.KEYFORMAT !== 'identity') throw new Error('Licensed DRM integration required for this HLS source');
      if (!attributes.URI) throw new Error('HLS encryption key is missing');
      const iv = attributes.IV;
      if (iv !== undefined && !/^0x[0-9a-f]{1,32}$/i.test(iv)) throw new Error('Invalid HLS initialization vector');
      key = { uri: new URL(attributes.URI, response.url).toString(), iv: iv === undefined ? null : Buffer.from(iv.slice(2).padStart(32, '0'), 'hex') };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = hlsAttributes(line); if (!attributes.URI) throw new Error('HLS initialization URI is missing');
      if (key && !key.iv) throw new Error('Encrypted HLS initialization requires an explicit IV');
      const uri = new URL(attributes.URI, response.url).toString(); const range: HlsRange | null = attributes.BYTERANGE ? hlsRange(attributes.BYTERANGE, uri, previousMapRange) : null;
      map = { uri, range, key }; previousMapRange = range;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      if (pendingRange !== null) throw new Error('HLS byte range has no segment'); pendingRange = line.slice(17).trim();
    } else if (line.startsWith('#EXTINF:')) {
      if (timed || !/^#EXTINF:(?:\d+(?:\.\d*)?|\.\d+)(?:,|$)/.test(line)) throw new Error('Invalid HLS segment duration'); timed = true;
    } else if (!line.startsWith('#')) {
      if (!timed) throw new Error('HLS media URI has no timed segment');
      const uri = new URL(line, response.url).toString(); const range: HlsRange | null = pendingRange === null ? null : hlsRange(pendingRange, uri, previousRange);
      segments.push({ uri, range, key, map, index: segments.length }); previousRange = range; pendingRange = null; timed = false;
    }
  }
  if (!segments.length || timed || pendingRange !== null) throw new Error('HLS media manifest contains missing or no timed segments');
  if (sequence + BigInt(segments.length - 1) > 0xffffffffffffffffn) throw new Error('Invalid HLS media sequence');
  const keys = new Map<HlsKey, Buffer>(); const verifiedMaps = new Set<HlsMap>();
  const decode = async (body: Buffer, state: HlsKey | null, index: number) => {
    if (!state) return body;
    if (body.length < 16) throw new Error('HLS encrypted segment is empty');
    let aesKey = keys.get(state);
    if (!aesKey) { const resource = await fetcher(state.uri, { maxBytes: 32, timeoutMs: 10000 }); ensureOk(resource); if (resource.body.length !== 16) throw new Error('Invalid HLS AES-128 key'); aesKey = resource.body; keys.set(state, aesKey); }
    const iv = state.iv || Buffer.alloc(16); if (!state.iv) iv.writeBigUInt64BE(sequence + BigInt(index), 8);
    const cipher = createDecipheriv('aes-128-cbc', aesKey, iv); cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(body.subarray(0, Math.floor(body.length / 16) * 16)), cipher.final()]);
  };
  // Sample both start and latest/end segment for VOD and live playlists.
  for (const index of [...new Set([0, segments.length - 1])]) {
    const segment = segments[index];
    if (segment.map && !verifiedMaps.has(segment.map)) {
      const initialization = await hlsResource(segment.map.uri, segment.map.range, fetcher);
      if (!isMediaBytes(await decode(initialization, segment.map.key, segment.index))) throw new Error('HLS initialization is missing or invalid');
      verifiedMaps.add(segment.map);
    }
    const body = await hlsResource(segment.uri, segment.range, fetcher);
    if (!isMediaBytes(await decode(body, segment.key, segment.index))) throw new Error('HLS segment is missing or invalid');
  }
  return null;
}
function attr(text: string, name: string) { return text.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1]; }
async function dash(response: FetchResult, fetcher: SafeFetcher): Promise<string | null> {
  if (response.truncated) throw new Error('DASH manifest is too large');
  const xml = response.body.toString('utf8');
  if (!/<(?:\w+:)?MPD\b/.test(xml) || !/<\/(?:\w+:)?MPD>/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid DASH manifest');
  if (/<ContentProtection\b/i.test(xml)) throw new Error('Licensed DRM integration required for this DASH source');
  const representation = xml.match(/<Representation\b([^>]*)(?:\/\s*>|>([\s\S]*?)<\/Representation>)/i);
  if (!representation) throw new Error('DASH has no representation');
  const representationId = attr(representation[1], 'id') || ''; const bandwidth = attr(representation[1], 'bandwidth') || '';
  const representationBody = representation[2] || '';
  const firstBase = xml.match(/<BaseURL(?:\s[^>]*)?>([^<]+)<\/BaseURL>/i)?.[1]?.trim();
  if ((xml.match(/<BaseURL(?:\s|>)/gi) || []).length > 1) throw new Error('Nested or multiple DASH BaseURL addressing requires an integration adapter');
  const base = firstBase ? new URL(firstBase.replace(/&amp;/g, '&'), response.url).toString() : response.url;
  const segmentList = representationBody.match(/<SegmentURL\b[^>]*\bmedia=["']([^"']+)["']/i) || xml.match(/<SegmentURL\b[^>]*\bmedia=["']([^"']+)["']/i);
  const template = representationBody.match(/<SegmentTemplate\b([^>]*)/i) || xml.match(/<SegmentTemplate\b([^>]*)/i);
  const init = representationBody.match(/<Initialization\b[^>]*\bsourceURL=["']([^"']+)["']/i) || xml.match(/<Initialization\b[^>]*\bsourceURL=["']([^"']+)["']/i);
  if (template && /\$Time\$/.test(attr(template[1], 'media') || '') && !/<SegmentTimeline\b[\s\S]*?<S\b[^>]*\bd=["']\d+["']/i.test(xml)) throw new Error('DASH time addressing requires a valid segment timeline');
  const substitute = (value: string) => value.replace(/\$RepresentationID\$/g, representationId).replace(/\$Bandwidth\$/g, bandwidth).replace(/\$Number(?:%0(\d+)d)?\$/g, (_match, width) => String(Number(attr(template?.[1] || '', 'startNumber') || 1)).padStart(Number(width || 0), '0')).replace(/\$Time\$/g, xml.match(/<S\b[^>]*\bt=["'](\d+)["']/)?.[1] || '0').replace(/\$\$/g, '$');
  const initUrl = init?.[1] || (template && attr(template[1], 'initialization'));
  if (initUrl) await sample(new URL(substitute(initUrl), base).toString(), fetcher);
  const media = segmentList?.[1] || (template && attr(template[1], 'media'));
  if (media) await sample(new URL(substitute(media), base).toString(), fetcher);
  else if (/\.(mp4|webm)(\?|$)/i.test(base)) await sample(base, fetcher);
  else throw new Error('DASH segment addressing is unsupported or missing');
  const height = attr(representation[1], 'height'); return height ? `${height}p` : null;
}
export async function verifyStream(url: string, expectedFormat: Source['format'] = 'unknown', fetcher: SafeFetcher = safeFetch, probe: (url: string) => Promise<MediaProbe> = probeMedia): Promise<HealthResult> {
  const started = Date.now(); let format = expectedFormat;
  let requests = 0; const deadline = started + 30000;
  const boundedFetcher: SafeFetcher = async (value, options = {}) => {
    if (++requests > 20) throw new Error('Stream verification request limit exceeded');
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('Stream verification timeout');
    const timeoutMs = Math.min(options.timeoutMs || 10000, remaining); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([fetcher(value, { ...options, timeoutMs }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Stream verification timeout')), timeoutMs); timer.unref(); })]);
      if (Date.now() > deadline) throw new Error('Stream verification timeout'); return response;
    } finally { clearTimeout(timer); }
  };
  try {
    const sampleBytes = expectedFormat === 'hls' || expectedFormat === 'dash' ? 512000 : 65536;
    let response = await boundedFetcher(url, { range: sampleBytes === 65536, maxBytes: sampleBytes, timeoutMs: 10000 }); ensureOk(response);
    let text = response.body.subarray(0, 1000).toString('utf8'); let quality: string | null = null;
    // Unknown MKV/TS links need only a small signature sample before the full
    // media probe. A manifest discovered by sniffing still requires its complete
    // existing-size download, including later segments and protection markers.
    if (sampleBytes < 512000 && response.truncated && (text.trimStart().startsWith('#EXTM3U') || /<(?:\w+:)?MPD\b/.test(text))) {
      response = await boundedFetcher(response.url, { maxBytes: 512000, timeoutMs: 10000 }); ensureOk(response);
      text = response.body.subarray(0, 1000).toString('utf8');
    }
    if (text.trimStart().startsWith('#EXTM3U')) { format = 'hls'; quality = await hls(response, boundedFetcher); }
    else if (/<(?:\w+:)?MPD\b/.test(text)) { format = 'dash'; quality = await dash(response, boundedFetcher); }
    else {
      let conversion = false;
      if (isEbml(response.body)) {
        const docType = ebmlDocType(response.body);
        if (docType === 'matroska') conversion = true;
        else if (docType !== 'webm') { format = 'unknown'; throw new Error('Unsupported EBML document type for browser playback'); }
      }
      if (!isMediaBytes(response.body) && !conversion) {
        const prefix = text.trimStart();
        if (response.body.length < 16 || /^[<{[]/.test(prefix) || !response.body.subarray(0, 256).some(byte => byte < 9 || byte > 126)) throw new Error('HTTP success did not contain supported video data');
        conversion = true;
      }
      // Raw transport streams also need remuxing/transcoding for browser playback.
      conversion ||= response.body[0] === 0x47 && response.body[188] === 0x47;
      if (conversion) { format = 'unknown'; const media = await probe(response.url); quality = media.height ? `${media.height}p` : null; }
      else format = isEbml(response.body) ? 'webm' : 'mp4';
    }
    return { ok: true, format, error: null, latencyMs: Date.now() - started, quality };
  } catch (error) { return { ok: false, format, error: sanitizeError(error), latencyMs: Date.now() - started, quality: null, ...(error instanceof MediaRuntimeError && error.classification !== 'source' ? { retryable: true } : {}) }; }
}
export function nextHealth(_previous: string, _failures: number, ok: boolean, _threshold?: number) {
  return ok ? 'healthy' : 'unavailable';
}
