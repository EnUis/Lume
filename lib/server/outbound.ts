import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { AppError } from './security';

export interface FetchResult { status: number; headers: Record<string, string>; body: Buffer; url: string; truncated: boolean; }
export type SafeFetcher = (url: string, options?: { maxBytes?: number; timeoutMs?: number; range?: boolean; headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string }) => Promise<FetchResult>;
// Public routable addresses only, including IPv4-mapped IPv6 and transition ranges.
export function isPublicIp(address: string): boolean {
  const input = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (isIP(input) === 4) {
    const [a, b] = input.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0);
  }
  if (isIP(input) === 6) {
    // Allow ordinary global unicast only; block mapped IPv4, link/site local, ULA,
    // multicast, loopback, documentation, Teredo, 6to4 and NAT64 destinations.
    return /^[23][0-9a-f]{0,3}:/.test(input) && !/^(2001:(db8|0):|2002:|3fff:)/.test(input);
  }
  return false;
}
export function validateSourceUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new AppError(400, 'Invalid source URL'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new AppError(400, 'Use an HTTP or HTTPS URL');
  url.hash = ''; return url;
}
// Signed playback grants have a distinct browser-safe policy. Administrator
// media URLs deliberately permit private networks, custom ports and userinfo.
export function validateBrowserSafeUrl(value: string): URL {
  const url = validateSourceUrl(value);
  if (url.username || url.password) throw new AppError(400, 'Browser-safe URLs cannot contain embedded credentials');
  if (url.hostname.endsWith('.local') || url.hostname.endsWith('.internal') || url.hostname === 'localhost') throw new AppError(400, 'Private hosts are not permitted');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicIp(host)) throw new AppError(400, 'Private network addresses are not permitted');
  return url;
}
export async function resolveDestination(url: URL, timeoutMs = 10000) {
  const host = url.hostname.replace(/^\[|\]$/g, ''); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([lookup(host, { all: true, verbatim: true }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timeout')), timeoutMs); timer.unref(); })]);
    if (!addresses.length) throw new Error('Upstream hostname has no addresses'); return addresses;
  } finally { clearTimeout(timer); }
}
export async function resolvePublicDestination(url: URL, timeoutMs = 10000) {
  validateBrowserSafeUrl(url.toString()); const addresses = await resolveDestination(url, timeoutMs);
  if (addresses.some(a => !isPublicIp(a.address))) throw new AppError(400, 'Playback destination resolved to a restricted network'); return addresses;
}
export const safeFetch: SafeFetcher = async (value, options = {}) => {
  // Zero explicitly opts administrator playlist downloads out of the response
  // byte cap. Stream samples and ordinary callers retain bounded defaults.
  const maxBytes = options.maxBytes === 0 ? Infinity : Math.max(1, Math.min(options.maxBytes || 1024 * 1024, 12 * 1024 * 1024));
  const timeoutMs = Math.min(options.timeoutMs || 10000, 30000);
  const deadline = Date.now() + timeoutMs;
  let current = validateSourceUrl(value);
  const originalOrigin = current.origin;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const host = current.hostname.replace(/^\[|\]$/g, '');
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('Upstream timeout');
    const addresses = await resolveDestination(current, remaining);
    const pinned = addresses[0];
    const response = await new Promise<FetchResult>((resolve, reject) => {
      let settled = false;
      const transport = current.protocol === 'https:' ? https : http;
      const request = transport.request(current, {
        method: options.method || 'GET', headers: { 'User-Agent': 'Lume-Authorized-Media-Health/1.0', 'Accept-Encoding': 'identity', ...(current.origin === originalOrigin ? options.headers : {}), ...(options.body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(options.body)) } : {}), ...(options.range && Number.isFinite(maxBytes) ? { Range: `bytes=0-${maxBytes - 1}` } : {}) },
        // Pin the DNS snapshot while allowing Node's address-family fallback.
        // localhost can resolve to both ::1 and 127.0.0.1 with only one listener.
        lookup: ((_hostname: string, opts: any, callback: any) => { const address = addresses.find(a => a.family === opts?.family) || pinned; return opts?.all ? callback(null, addresses) : callback(null, address.address, address.family); }) as any,
      }, response => {
        const headers = Object.fromEntries(Object.entries(response.headers).map(([key, v]) => [key, Array.isArray(v) ? v.join(', ') : v || '']));
        const chunks: Buffer[] = []; let size = 0;
        const finish = (truncated = false) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status: response.statusCode || 0, headers, body: Buffer.concat(chunks), url: current.toString(), truncated }); };
        response.on('data', (chunk: Buffer) => { const available = maxBytes - size; if (available > 0) { chunks.push(chunk.subarray(0, available)); size += Math.min(available, chunk.length); } if (size >= maxBytes) { finish(true); response.destroy(); request.destroy(); } });
        response.on('end', () => finish(false));
        response.on('error', error => { if (!settled) reject(error); });
      });
      const timer = setTimeout(() => request.destroy(new Error('Upstream timeout')), Math.max(1, deadline - Date.now()));
      request.on('error', error => { clearTimeout(timer); if (!settled) reject(error); }); request.end(options.body);
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (options.method === 'POST') throw new Error('Sensitive integration POST redirects are not permitted');
      if (!response.headers.location || redirects === 4) throw new Error('Invalid or excessive upstream redirects');
      const destination = validateSourceUrl(new URL(response.headers.location, current).toString());
      current = destination; continue;
    }
    return response;
  }
  throw new Error('Too many redirects');
};
