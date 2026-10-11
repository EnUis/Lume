import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, requestJson } from '../lib/client';
import { handleApi } from '../lib/server/api';
import { openDatabase, type DB } from '../lib/server/db';
import { id, session } from '../lib/server/security';

let db: DB;
let cookie: string;
let responses: Response[];
const origin = process.env.APP_ORIGIN || 'http://localhost:3000';

beforeEach(async () => {
  db = await openDatabase(':memory:'); responses = [];
  const userId = id();
  await db.run("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,'admin',?)", [userId, 'client-session@test.invalid', 'Test administrator', 'unused-test-hash', Date.now()]);
  cookie = (await session(db, userId)).split(';')[0];
  // Adapt browser fetch to the real API, including browser-supplied session/origin.
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set('origin', origin);
    if (options.credentials === 'same-origin') headers.set('cookie', cookie);
    const response = await handleApi(new Request(new URL(url, origin), { ...options, headers }), db);
    responses.push(response); return response;
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); await db.close(); });

describe('bodyless browser JSON actions against the real API', () => {
  it('signs out through both browser request entry points and revokes the authenticated session', async () => {
    await expect(api('/auth/me')).resolves.toMatchObject({ user: { role: 'admin' } });
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toEqual({ ok: true });
    expect(responses[1].headers.get('set-cookie')).toContain('Max-Age=0');
    await expect(api('/auth/me')).resolves.toEqual({ user: null });
    expect((await db.get('SELECT COUNT(*) AS count FROM sessions'))?.count).toBe(0);
    await expect(requestJson('/api/auth/logout', { method: 'POST' })).resolves.toEqual({ ok: true });
  });

  it('queues an administrator playlist synchronization without a caller payload', async () => {
    const playlistId = id();
    await db.run('INSERT INTO playlists(id,name,created_at) VALUES(?,?,?)', [playlistId, 'Authorized test playlist', Date.now()]);
    const result = await requestJson<{ queued: boolean; jobId: string }>(`/api/admin/playlists/${playlistId}/sync`, { method: 'POST' });
    expect(result.queued).toBe(true);
    const job = await db.get('SELECT type,status,payload FROM jobs WHERE id=?', [result.jobId]);
    expect(job).toMatchObject({ type: 'sync', status: 'queued' });
    expect(JSON.parse(job!.payload)).toEqual({ playlistId });
  });
});
