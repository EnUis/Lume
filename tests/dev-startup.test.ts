import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEV_STATUS_PATH, inspectDevPort, inspectNextDevLock, localOrigin, workspaceIdentity } from '../scripts/dev-startup.mjs';

const servers: http.Server[] = [], directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done())); }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function listener(handler: http.RequestListener) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test listener unavailable');
  return { server, port: address.port, hostname: '127.0.0.1', directory: process.cwd(), timeoutMs: 1000 };
}
function reply(res: http.ServerResponse, value: unknown, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }

describe('development server startup checks', () => {
  it('allows an unused port and formats wildcard/IPv6 listener addresses', async () => {
    const options = await listener((req, res) => res.end());
    await new Promise<void>(done => options.server.close(() => done()));
    expect(await inspectDevPort(options)).toMatchObject({ state: 'free' });
    expect(localOrigin('0.0.0.0', 3000)).toBe('http://127.0.0.1:3000');
    expect(localOrigin('::', 3000)).toBe('http://[::1]:3000');
  });
  it('recognizes a healthy instance of this project without starting another worker', async () => {
    const requests: string[] = [];
    const options = await listener((req, res) => {
      requests.push(req.url!);
      if (req.url === DEV_STATUS_PATH) reply(res, { service: 'lume-development', workspace: workspaceIdentity(process.cwd()), ready: true });
      else reply(res, { ok: true, database: 'connected' });
    });
    expect(await inspectDevPort(options)).toMatchObject({ state: 'reuse' });
    expect(requests).toEqual([DEV_STATUS_PATH, '/api/health']);
  });
  it('does not mistake another project or unrelated health endpoint for this application', async () => {
    for (const otherProject of [false, true]) {
      const options = await listener((req, res) => {
        if (otherProject && req.url === DEV_STATUS_PATH) reply(res, { service: 'lume-development', workspace: 'another-workspace', ready: true });
        else if (req.url === '/api/health') reply(res, { ok: true, database: 'connected' });
        else res.end('<title>Another app</title>');
      });
      expect(await inspectDevPort(options)).toMatchObject({ state: 'other' });
    }
  });
  it('reuses an older healthy Lume launcher only with matching page identity and health', async () => {
    const options = await listener((req, res) => {
      if (req.url === '/api/health') reply(res, { ok: true, database: 'connected' });
      else if (req.url === '/') res.end('<html><head><title>Lume · A little wonder. A lot to watch.</title></head></html>');
      else reply(res, { error: 'Not found' }, 404);
    });
    expect(await inspectDevPort(options)).toMatchObject({ state: 'reuse' });
  });
  it('reports an existing unhealthy instance without starting another instance', async () => {
    const options = await listener((req, res) => {
      if (req.url === DEV_STATUS_PATH) reply(res, { service: 'lume-development', workspace: workspaceIdentity(process.cwd()), ready: true });
      else reply(res, { ok: false }, 503);
    });
    expect(await inspectDevPort(options)).toMatchObject({ state: 'unhealthy' });
  });
  it('bounds a stalled listener instead of hanging startup', async () => {
    const options = await listener(() => {});
    expect(await inspectDevPort({ ...options, timeoutMs: 40 })).toMatchObject({ state: 'other' });
  });
  it('recovers stale lock metadata only by obtaining Next’s native exclusive lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lume-dev-lock-')); directories.push(directory);
    const lockPath = join(directory, '.next/dev/lock'); await mkdir(join(directory, '.next/dev'), { recursive: true });
    const content = JSON.stringify({ pid: 99999999, port: 3000 }); await writeFile(lockPath, content);
    let acquired = '', releases = 0;
    expect(await inspectNextDevLock(directory, async (path: string) => { acquired = path; return { unlock: async () => { releases++; } }; })).toEqual({ state: 'free' });
    expect(acquired).toBe(lockPath); expect(releases).toBe(1);
    // The wrapper never deletes/replaces a file based on an obsolete PID.
    expect(await readFile(lockPath, 'utf8')).toBe(content);
    expect(await inspectNextDevLock(directory, async () => undefined)).toEqual({ state: 'busy', port: 3000 });
    expect(await readFile(lockPath, 'utf8')).toBe(content);
  });
});
