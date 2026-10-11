import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../lib/server/db';
import { openDatabase } from '../lib/server/db';
import { handleApi } from '../lib/server/api';
import { decrypt, encrypt, id, passwordHash, session } from '../lib/server/security';
import { parseM3U } from '../lib/server/m3u';
import { synchronizePlaylist } from '../lib/server/pipeline';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
async function account(role = 'admin') {
  const userId = id();
  await db.run('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', [userId, `${userId}@test.dev`, 'Upload test', passwordHash('secure-upload-test-password'), role, Date.now()]);
  return (await session(db, userId)).split(';')[0];
}
function upload(data: unknown, cookie?: string, contentLength?: number) {
  const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
  return new Request(`${origin}/api/admin/playlists`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(contentLength ? { 'content-length': String(contentLength) } : {}) }, body: JSON.stringify(data) });
}
const largePlaylist = () => '#EXTM3U\n#' + 'x'.repeat(12 * 1024 * 1024) + '\n#EXTINF:-1 type="movie",Large Upload Film (2026)\nhttp://127.0.0.1:8080/film.mp4\n';

describe('playlist uploads without application size limits', () => {
  it('persists and synchronizes an authenticated upload above the former API and parser limits', async () => {
    const content = largePlaylist();
    const response = await handleApi(upload({ name: 'Large uploaded library', content, authorized: true }, await account(), Buffer.byteLength(content) + 1000), db);
    expect(response.status).toBe(201);
    const { playlist } = await response.json();
    const stored = await db.get('SELECT content_encrypted FROM playlists WHERE id=?', [playlist.id]);
    expect(decrypt(stored!.content_encrypted)).toBe(content.trim());
    expect(await synchronizePlaylist(db, playlist.id)).toMatchObject({ valid: 1, added: 1 });
    const source = await db.get('SELECT url_encrypted FROM sources WHERE playlist_id=?', [playlist.id]);
    expect(decrypt(source!.url_encrypted)).toBe('http://127.0.0.1:8080/film.mp4');
  });
  it('requests complete remote playlists and preserves content above the former download limit', async () => {
    const playlistId = id(); const content = largePlaylist();
    await db.run('INSERT INTO playlists(id,name,url_encrypted,created_at) VALUES(?,?,?,?)', [playlistId, 'Remote large library', encrypt('http://localhost:8080/library.m3u'), Date.now()]);
    expect(await synchronizePlaylist(db, playlistId, async (url, options) => {
      expect(options?.maxBytes).toBe(0);
      return { status: 200, headers: {}, body: Buffer.from(content), url, truncated: false };
    })).toMatchObject({ valid: 1, added: 1 });
    expect(decrypt((await db.get('SELECT content_encrypted FROM playlist_versions WHERE playlist_id=?', [playlistId]))!.content_encrypted)).toBe(content);
  });
  it('retains authentication and role checks before accepting unlimited import bodies', async () => {
    const data = { name: 'Library', content: '#EXTM3U', authorized: true };
    expect((await handleApi(upload(data, undefined, 20 * 1024 * 1024), db)).status).toBe(401);
    expect((await handleApi(upload(data, await account('user'), 20 * 1024 * 1024), db)).status).toBe(403);
    expect((await db.get('SELECT COUNT(*) AS n FROM playlists'))!.n).toBe(0);
  });
  it('accepts playlists with more than the former 100000-entry maximum', () => {
    const content = '#EXTM3U\n' + Array.from({ length: 100001 }, (_, index) => `#EXTINF:-1 type="movie",A Film (2020)\nhttp://localhost:8080/film.mp4?server=${index}\n`).join('');
    const result = parseM3U(content);
    expect(result.entries).toHaveLength(100001);
    expect(result.errors).toEqual([]);
  }, 60000); // Functional size-limit regression; allow a busy development machine to parse 100,001 entries.
});
