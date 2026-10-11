import http from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { workerRestart } from './worker-restart.mjs';
import { DEV_STATUS_PATH, inspectDevPort, inspectNextDevLock, workspaceIdentity } from './dev-startup.mjs';

const port = Number(process.env.PORT || 3000), hostname = process.env.HOSTNAME || '127.0.0.1';
const directory = process.cwd();
process.env.NODE_ENV = 'development';
function reportExisting(result) {
  if (result.state === 'free') return false;
  if (result.state === 'reuse') {
    console.log(`Lume is already running · ${result.origin}`);
    console.log('Keep its existing terminal open. No additional server or background worker was started.');
  } else { console.error(result.reason); process.exitCode = 1; }
  return true;
}
async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a number from 1 to 65535.');
  if (reportExisting(await inspectDevPort({ hostname, port, directory }))) return;
  const lock = await inspectNextDevLock(directory, async path => {
    const { loadBindings } = await import('next/dist/build/swc/index.js');
    const { Lockfile } = await import('next/dist/build/lockfile.js');
    await loadBindings(); return Lockfile.tryAcquire(path);
  });
  if (lock.state === 'busy') {
    if (lock.port && reportExisting(await inspectDevPort({ hostname, port: lock.port, directory }))) return;
    console.error('This project is still open in another Next.js process or finishing a previous session. Close that terminal, wait a moment, then run npm run dev again.');
    process.exitCode = 1; return;
  }
  const { default: next } = await import('next');
  const app = next({ dev: true, hostname, port });
  await app.prepare();
  const handler = app.getRequestHandler();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.split('?')[0] === DEV_STATUS_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ service: 'lume-development', workspace: workspaceIdentity(directory), ready: true })); return;
    }
    handler(req, res);
  });
  let worker, stopping = false, restart, restartFailures = 0;
  function launchWorker() {
    if (stopping || process.env.DEV_WORKER_AUTOSTART === 'false') return;
    const started = Date.now();
    worker = spawn(process.execPath, [resolve('scripts/run.cjs'), 'worker'], { cwd: directory, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'inherit', windowsHide: true });
    worker.on('error', error => console.error(`Background imports could not start: ${error.message}. Run npm run worker in another terminal.`));
    worker.on('exit', () => {
      worker = undefined;
      if (!stopping) { const next = workerRestart(restartFailures, Date.now() - started); restartFailures = next.failures; console.error(`Background import worker stopped. Reconnecting in ${next.delayMs / 1000} seconds.`); restart = setTimeout(launchWorker, next.delayMs); }
    });
  }
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, hostname, resolveListen); });
  } catch (error) {
    await app.close();
    if (error.code === 'EADDRINUSE' && reportExisting(await inspectDevPort({ hostname, port, directory }))) return;
    throw error;
  }
  console.log(`Lume · http://${hostname}:${port}`); launchWorker();
  async function shutdown() {
    if (stopping) return; stopping = true; clearTimeout(restart); worker?.kill('SIGTERM');
    const force = setTimeout(() => { worker?.kill('SIGKILL'); process.exit(0); }, 10000); force.unref();
    await new Promise(resolveClose => server.close(resolveClose));
    if (worker) await new Promise(resolveExit => worker.once('exit', resolveExit));
    await app.close(); clearTimeout(force); process.exit(0);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
  process.on('exit', () => worker?.kill());
}
try { await main(); } catch (error) { console.error(`Lume could not start: ${error.message}`); process.exitCode = 1; }
