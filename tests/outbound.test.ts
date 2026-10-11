import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { safeFetch, validateSourceUrl, validateBrowserSafeUrl, resolveDestination, resolvePublicDestination } from '../lib/server/outbound';
import { verifyStream } from '../lib/server/health';

const servers: http.Server[] = [];
const media = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(1024)]);
async function serve(handler: http.RequestListener, host?: string) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); const listening = () => { server.removeListener('error', reject); resolve(); }; if (host) server.listen(0, host, listening); else server.listen(0, listening); });
  const port = (server.address() as AddressInfo).port;
  return { server, port, base: `http://localhost:${port}` };
}
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

describe('administrator-configured media destinations', () => {
  it('accepts private/local IPv4/IPv6 hosts, internal names, valid custom ports and embedded credentials', () => {
    for (const value of ['http://localhost:3007/movie.mp4', 'http://127.0.0.1:65535/playlist.m3u', 'http://10.0.0.2:8080/a', 'https://192.168.1.2:8443/b', 'http://[::1]:3008/c', 'https://media.internal:9443/d', 'http://media.local:8888/e', 'http://alice:p%40ss@example.com:7777/f']) expect(validateSourceUrl(value).toString()).toBe(value);
    for (const value of ['not a URL', 'file:///etc/passwd', 'ftp://example.com/movie', 'http://example.com:65536/movie', 'http://example.com:-1/movie']) expect(() => validateSourceUrl(value)).toThrow();
  });
  it('resolves and connects to a real localhost HTTP server on its dynamically assigned custom port', async () => {
    const { base, port } = await serve((_request, response) => { response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.end(media); }, '127.0.0.1');
    expect((await resolveDestination(new URL(base))).some(address => address.address === '::1' || address.address === '127.0.0.1')).toBe(true);
    const response = await safeFetch(`${base}/movie.mp4`, { maxBytes: 65536, range: true }); expect(response.status).toBe(200); expect(response.body).toEqual(media);
    const ipv4 = await safeFetch(`http://127.0.0.1:${port}/movie.mp4`); expect(ipv4.body).toEqual(media);
    expect(await verifyStream(`${base}/movie.mp4`, 'mp4')).toMatchObject({ ok: true, format: 'mp4' });
  });
  it('supports percent-encoded embedded HTTP credentials through Node basic authentication', async () => {
    let authorization = '';
    const { port } = await serve((request, response) => { authorization = request.headers.authorization || ''; response.end('authorized'); });
    const response = await safeFetch(`http://alice:p%40ss%20word@localhost:${port}/auth`);
    expect(response.body.toString()).toBe('authorized'); expect(authorization).toBe(`Basic ${Buffer.from('alice:p@ss word').toString('base64')}`);
  });
  it('follows redirects between allowed private/custom-port destinations without forwarding authorization to a different origin', async () => {
    let forwardedAuthorization: string | undefined;
    const target = await serve((request, response) => { forwardedAuthorization = request.headers.authorization; response.end('redirected'); });
    const initial = await serve((_request, response) => { response.writeHead(302, { Location: `${target.base}/movie` }); response.end(); });
    const response = await safeFetch(`${initial.base}/redirect`, { headers: { Authorization: 'Bearer fixture-secret' } });
    expect(response.body.toString()).toBe('redirected'); expect(response.url).toBe(`${target.base}/movie`); expect(forwardedAuthorization).toBeUndefined();
  });
  it('still enforces redirect count, malformed redirect schemes and request timeouts', async () => {
    const { base } = await serve((request, response) => {
      if (request.url === '/slow') return;
      response.writeHead(302, { Location: request.url === '/invalid' ? 'file:///unavailable' : '/loop' }); response.end();
    });
    await expect(safeFetch(`${base}/loop`)).rejects.toThrow(/redirect/i);
    await expect(safeFetch(`${base}/invalid`)).rejects.toThrow(/HTTP or HTTPS/);
    await expect(safeFetch(`${base}/slow`, { timeoutMs: 50 })).rejects.toThrow(/timeout/i);
  });
  it('supports explicitly unlimited playlist responses beyond 12 MiB without adding a Range header', async () => {
    const content = Buffer.alloc(13 * 1024 * 1024 + 19, 'a'); let range: string | undefined;
    const { base } = await serve((request, response) => { range = request.headers.range; response.end(content); });
    const response = await safeFetch(`${base}/large.m3u`, { maxBytes: 0, range: true });
    expect(response.body.length).toBe(content.length); expect(response.truncated).toBe(false); expect(range).toBeUndefined();
  });
  it('retains ordinary response caps and bounded Range samples', async () => {
    const content = Buffer.alloc(2 * 1024 * 1024, 'a'); const ranges: Array<string | undefined> = [];
    const { base } = await serve((request, response) => { ranges.push(request.headers.range); response.end(content); });
    const ordinary = await safeFetch(`${base}/resource`); expect(ordinary.body.length).toBe(1024 * 1024); expect(ordinary.truncated).toBe(true);
    const sample = await safeFetch(`${base}/resource`, { maxBytes: 32, range: true }); expect(sample.body.length).toBe(32); expect(sample.truncated).toBe(true); expect(ranges).toEqual([undefined, 'bytes=0-31']);
  });
});

describe('browser-safe signed-grant policy', () => {
  it('accepts public custom signed-grant ports while keeping private/local hosts and embedded credentials restricted', async () => {
    for (const value of ['https://localhost/media', 'https://127.0.0.1/media', 'https://[::1]/media', 'https://10.1.1.1/media', 'https://alice:password@example.com/media']) expect(() => validateBrowserSafeUrl(value)).toThrow();
    expect(validateBrowserSafeUrl('https://example.com:8443/media').port).toBe('8443');
    expect(validateBrowserSafeUrl('https://cdn.example.com/movie?signature=short-lived').protocol).toBe('https:');
    await expect(resolvePublicDestination(new URL('https://127.0.0.1/media'))).rejects.toThrow(/Private/);
  });
});
