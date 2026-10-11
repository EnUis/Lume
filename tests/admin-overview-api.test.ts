import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApi } from '../lib/server/api';
import { openDatabase, type DB, type Row } from '../lib/server/db';
import { hash, id } from '../lib/server/security';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { vi.restoreAllMocks(); await db.close(); });
async function viewer(role = 'admin') {
  const userId = id(), token = id() + id();
  await db.run('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', [userId, `${userId}@example.test`, 'Fixture', 'fixture', role, Date.now()]);
  await db.run('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)', [hash(token), userId, Date.now() + 60000, Date.now()]);
  return `luma_session=${token}`;
}
function request(cookie?: string) { return new Request(`${process.env.APP_ORIGIN || 'http://localhost:3000'}/api/admin/overview`, { headers: cookie ? { cookie } : {} }); }
const statsQuery = (sql: string) => /AS movies\b/.test(sql);

describe('administrator overview request isolation', () => {
  it('coalesces concurrent authorized reads and starts a fresh query after completion', async () => {
    const cookie = await viewer(); let reads = 0; let began!: () => void, release!: () => void;
    const started = new Promise<void>(resolveStarted => { began = resolveStarted; });
    const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
    const adapter: DB = { ...db, get: async <T extends Row = Row>(sql: string, values?: unknown[]) => { if (statsQuery(sql)) { reads++; began(); await held; } return db.get<T>(sql, values); } };
    const first = handleApi(request(cookie), adapter); await started;
    const second = handleApi(request(cookie), adapter); await new Promise(resolveTick => setTimeout(resolveTick, 0));
    expect(reads).toBe(1); release();
    const [one, two] = await Promise.all([first, second]); expect(one.status).toBe(200); expect(two.status).toBe(200);
    const firstResult = await one.json(); expect(await two.json()).toEqual(firstResult);
    expect(firstResult.stats).toMatchObject({ movies: 0, series: 0, sources: 0 });
    expect((await handleApi(request(cookie), adapter)).status).toBe(200); expect(reads).toBe(2);
  });

  it('keeps authorization outside shared work and allows editors without granting users access', async () => {
    const editor = await viewer('editor'), user = await viewer('user'); let reads = 0;
    const adapter: DB = { ...db, get: async <T extends Row = Row>(sql: string, values?: unknown[]) => { if (statsQuery(sql)) reads++; return db.get<T>(sql, values); } };
    expect((await handleApi(request(), adapter)).status).toBe(401);
    expect((await handleApi(request(user), adapter)).status).toBe(403); expect(reads).toBe(0);
    expect((await handleApi(request(editor), adapter)).status).toBe(200); expect(reads).toBe(1);
  });

  it('tolerates malformed job reports and audit JSON while returning the remaining overview', async () => {
    const cookie = await viewer(); const jobIds = [id(), id()];
    for (const [index, report] of ['{broken', '["unexpected array"]'].entries()) await db.run('INSERT INTO jobs(id,type,payload,run_after,created_at,report) VALUES(?,?,?,?,?,?)', [jobIds[index], 'health', '{}', Date.now(), Date.now(), report]);
    const auditId = id(); await db.run('INSERT INTO audit_log(id,action,entity_id,details,created_at) VALUES(?,?,?,?,?)', [auditId, 'fixture', 'fixture', '{broken', Date.now()]);
    const result = await handleApi(request(cookie), db); expect(result.status).toBe(200); const data = await result.json();
    expect(data.stats).toMatchObject({ movies: 0, sources: 0 });
    for (const jobId of jobIds) { const job = data.jobs.find((row: { id: string }) => row.id === jobId); expect(job).toBeDefined(); expect(job.report).toEqual({ error: 'Stored job report could not be read' }); }
    expect(data.audit.find((row: { id: string }) => row.id === auditId).details).toEqual({ error: 'Stored audit details could not be read' });
  });

  it('drops rejected in-flight work so the next authorized request can recover', async () => {
    const cookie = await viewer(); let reads = 0; vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter: DB = { ...db, get: async <T extends Row = Row>(sql: string, values?: unknown[]) => { if (statsQuery(sql) && ++reads === 1) throw new Error('Temporary overview fixture failure'); return db.get<T>(sql, values); } };
    expect((await handleApi(request(cookie), adapter)).status).toBe(500);
    expect((await handleApi(request(cookie), adapter)).status).toBe(200); expect(reads).toBe(2);
  });
});
