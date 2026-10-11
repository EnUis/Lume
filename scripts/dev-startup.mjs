import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEV_STATUS_PATH = '/__lume/dev-status';
export function workspaceIdentity(directory) {
  const path = resolve(directory); return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
}
export function localOrigin(hostname, port) {
  const host = hostname === '0.0.0.0' ? '127.0.0.1' : hostname === '::' ? '::1' : hostname;
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}
function request(origin, path, timeoutMs) {
  return new Promise(resolveResult => {
    let finished = false, body = '', timer;
    const finish = value => { if (finished) return; finished = true; clearTimeout(timer); resolveResult(value); };
    const req = http.get(new URL(path, origin), { headers: { Accept: 'application/json,text/html' } }, response => {
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        // We only need a small JSON response or the document title.
        if (body.length > 65536) { finish({ status: response.statusCode, body: body.slice(0, 65536) }); req.destroy(); }
      });
      response.on('end', () => finish({ status: response.statusCode, body }));
      response.on('error', () => finish({ status: response.statusCode, body, error: 'response' }));
    });
    req.on('error', error => finish({ error: error.code || 'connection' }));
    timer = setTimeout(() => { finish({ error: 'timeout' }); req.destroy(); }, timeoutMs);
  });
}
function json(response) { try { return JSON.parse(response.body); } catch { return null; } }
/** Read-only probe. Reusing a listener never starts or takes ownership of its worker. */
export async function inspectDevPort({ hostname, port, directory, timeoutMs = 3000 }) {
  const origin = localOrigin(hostname, port);
  const markerResponse = await request(origin, DEV_STATUS_PATH, timeoutMs);
  if (markerResponse.error === 'ECONNREFUSED') return { state: 'free', origin };
  const marker = json(markerResponse);
  if (markerResponse.status === 200 && marker?.service === 'lume-development') {
    if (marker.workspace !== workspaceIdentity(directory)) return { state: 'other', origin, reason: 'A different Lume project is using this address.' };
    if (!marker.ready) return { state: 'starting', origin, reason: 'Lume is still starting in its existing terminal.' };
    const health = await request(origin, '/api/health', timeoutMs);
    return health.status === 200 && json(health)?.ok === true && json(health)?.database === 'connected'
      ? { state: 'reuse', origin }
      : { state: 'unhealthy', origin, reason: 'Lume is running, but its health check is not ready. Check the existing terminal.' };
  }
  // Older Lume launchers do not have the marker endpoint. Verify both their
  // application-specific document title and database-health response.
  const [health, page] = await Promise.all([request(origin, '/api/health', timeoutMs), request(origin, '/', timeoutMs)]);
  const isLume = page.status === 200 && /<title>\s*Lume\s*(?:·|&middot;|&#183;)\s*A little wonder\. A lot to watch\.<\/title>/i.test(page.body || '');
  if (isLume) return health.status === 200 && json(health)?.ok === true && json(health)?.database === 'connected'
    ? { state: 'reuse', origin }
    : { state: 'unhealthy', origin, reason: 'Lume is running, but its health check is not ready. Check the existing terminal.' };
  return { state: 'other', origin, reason: 'This address is already in use or not responding. Stop its server in the terminal that started it, or choose another PORT.' };
}
/** Next 16.3 owns an OS lock, not a PID-file lease. Never unlink it by PID. */
export async function inspectNextDevLock(directory, acquire) {
  const path = resolve(directory, '.next/dev/lock');
  let content;
  try { content = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { state: 'free' }; throw error; }
  // Obtaining and releasing the native exclusive lock safely recovers an old
  // unlocked file, even if its JSON contains a PID that no longer exists.
  const lock = await acquire(path);
  if (lock) { await lock.unlock(); return { state: 'free' }; }
  let info; try { info = JSON.parse(content); } catch { /* The lock still belongs to another process. */ }
  return { state: 'busy', port: Number.isInteger(info?.port) && info.port > 0 && info.port < 65536 ? info.port : undefined };
}
