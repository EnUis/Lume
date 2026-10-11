import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { handleApi } from '../lib/server/api';
import { isSqliteBusy, openDatabase, type DB } from '../lib/server/db';
import { hash, id, passwordHash, verifyPassword } from '../lib/server/security';

const databases: DB[] = [], directories: string[] = [], workers: Worker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate();
  for (const db of databases.splice(0)) await db.close();
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.split(/[\\/]/).at(-1)?.startsWith('lume-auth-test-')) throw new Error('Unsafe test cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.doUnmock('node:sqlite'); vi.resetModules();
});
function temporaryDatabase() { const directory = mkdtempSync(join(tmpdir(), 'lume-auth-test-')); directories.push(directory); return join(directory, 'isolated.sqlite'); }
function login(email: string, password: string) { const origin = process.env.APP_ORIGIN || 'http://localhost:3000'; return new Request(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); }
async function heldWriter(path: string, milliseconds: number | null = 1200) {
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(workerData.path);
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
    const insert=db.prepare('INSERT INTO contention_fixture(value) VALUES(?)');
    for(let index=0;index<2000;index++)insert.run(index);
    let released=false;
    function release(){if(released)return;released=true;db.exec('COMMIT');db.close();parentPort.postMessage('released');}
    parentPort.on('message',message=>{if(message==='release')release();});
    parentPort.postMessage('locked');
    if(workerData.milliseconds!==null)setTimeout(release,workerData.milliseconds);
  `, { eval: true, workerData: { path, milliseconds } });
  workers.push(worker);
  await new Promise<void>((resolveLocked, reject) => { worker.once('error', reject); worker.once('message', message => message === 'locked' ? resolveLocked() : reject(new Error('Unexpected fixture state'))); });
  return worker;
}

describe('authentication and database startup resilience', () => {
  it('treats malformed stored password data as invalid credentials without throwing or accepting partial hex', async () => {
    const password = 'valid-password-123'; const valid = passwordHash(password);
    expect(verifyPassword(password, valid)).toBe(true); expect(verifyPassword('incorrect', valid)).toBe(false);
    for (const malformed of [undefined, null, 12, {}, '', 'broken', valid + ':extra', valid.slice(0, -1), valid + 'xx']) expect(verifyPassword(password, malformed)).toBe(false);
    const db = await openDatabase(':memory:'); databases.push(db);
    await db.run('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)', [id(), 'malformed@example.test', 'Fixture', 'broken', Date.now()]);
    const result = await handleApi(login('malformed@example.test', password), db);
    expect(result.status).toBe(401); expect(await result.json()).toEqual({ error: 'Email or password is incorrect' });
    expect((await db.get('SELECT COUNT(*) AS count FROM sessions'))!.count).toBe(0);
  }, 20000);

  it('lets a valid login succeed during an independent bulk SQLite writer without changing the account', async () => {
    const path = temporaryDatabase(), db = await openDatabase(path); databases.push(db);
    const userId = id(), email = 'contention@example.test', password = 'valid-password-123';
    await db.run('CREATE TABLE contention_fixture(value INTEGER NOT NULL)');
    await db.run("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,'admin',?)", [userId, email, 'Fixture', passwordHash(password), Date.now()]);
    const before = await db.get('SELECT * FROM users WHERE id=?', [userId]);
    const writer = await heldWriter(path, null); let ticks = 0, released = false; const timer = setInterval(() => ticks++, 10);
    const release = setTimeout(() => { released = true; writer.postMessage('release'); }, 300);
    let result: Response; try { result = await handleApi(login(email, password), db); } finally { clearInterval(timer); clearTimeout(release); }
    expect(result!.status).toBe(200); expect(released).toBe(true); expect(ticks).toBeGreaterThan(0);
    const cookie = result!.headers.get('set-cookie'); expect(cookie).toContain('HttpOnly');
    const token = cookie!.match(/luma_session=([a-f0-9]{64})/)![1];
    expect(await db.get('SELECT user_id FROM sessions WHERE id=?', [hash(token)])).toEqual({ user_id: userId });
    expect(await db.get('SELECT * FROM users WHERE id=?', [userId])).toEqual(before);
    expect((await db.get('SELECT COUNT(*) AS count FROM contention_fixture'))!.count).toBe(2000);
  }, 20000);

  it('waits for a writer before changing journal mode or applying startup migrations', async () => {
    const path = temporaryDatabase(), initial = new DatabaseSync(path);
    initial.exec('CREATE TABLE contention_fixture(value INTEGER NOT NULL)'); initial.close();
    const writer = await heldWriter(path, null); let released = false;
    const release = setTimeout(() => { released = true; writer.postMessage('release'); }, 300);
    let db: DB; try { db = await openDatabase(path); databases.push(db); } finally { clearTimeout(release); }
    expect(released).toBe(true);
    expect((await db.get('PRAGMA journal_mode'))!.journal_mode).toBe('wal');
    expect((await db.get('SELECT MAX(version) AS latest FROM schema_migrations'))!.latest).toBeGreaterThanOrEqual(7);
    expect((await db.get('SELECT COUNT(*) AS count FROM contention_fixture'))!.count).toBe(2000);
  }, 20000);

  it('recovers after a rejected singleton initialization and shares the next opening across requests', async () => {
    vi.stubEnv('SQLITE_PATH', ':memory:'); vi.resetModules(); let openings = 0;
    vi.doMock('node:sqlite', async () => {
      const actual = await vi.importActual<typeof import('node:sqlite')>('node:sqlite');
      return { ...actual, DatabaseSync: new Proxy(actual.DatabaseSync, { construct(target, args) { if (++openings === 1) throw new Error('Transient startup failure'); return Reflect.construct(target, args); } }) };
    });
    const module = await import('../lib/server/db');
    await expect(module.database()).rejects.toThrow('Transient startup failure');
    const first = module.database(), second = module.database(); expect(first).toBe(second);
    const db = await first; databases.push(db); expect(await db.get('SELECT 1 AS ok')).toEqual({ ok: 1 }); expect(openings).toBe(2);
  });

  it('returns a retryable database-busy response without confusing unrelated failures with lock contention', async () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    expect(isSqliteBusy(busy)).toBe(true); expect(isSqliteBusy({ code: 'ERR_SQLITE_ERROR', errcode: 517 })).toBe(true);
    expect(isSqliteBusy(new Error('database is locked'))).toBe(false); expect(isSqliteBusy({ code: 'ERR_SQLITE_ERROR', errcode: 19 })).toBe(false);
    const db = await openDatabase(':memory:'); databases.push(db);
    const unavailable: DB = { ...db, get: async () => { throw busy; } };
    const result = await handleApi(login('busy@example.test', 'valid-password-123'), unavailable);
    expect(result.status).toBe(503); expect(result.headers.get('retry-after')).toBe('1');
    expect(await result.json()).toEqual({ error: 'The database is busy. Please try again shortly.' });
  });
});
