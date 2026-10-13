import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { createTitle, synchronizePlaylist } from '../lib/server/pipeline';
import { genericPlaylistArtwork, previewGenericArtworkRepair, applyGenericArtworkRepair } from '../lib/server/catalog-artwork';
import { encrypt, id } from '../lib/server/security';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
const generic = 'https://images.example.test/provider-banner.jpg';
it('detects unrelated film logos without treating language copies or channel networks as unrelated films', () => {
  const copies = Array.from({ length: 12 }, () => ({ type: 'movie' as const, normalized: 'same film', poster: generic }));
  expect(genericPlaylistArtwork(copies).size).toBe(0);
  const channels = Array.from({ length: 12 }, (_, i) => ({ type: 'live' as const, normalized: `channel ${i}`, poster: generic }));
  expect(genericPlaylistArtwork(channels).size).toBe(0);
  const movies = copies.map((entry, i) => ({ ...entry, normalized: `distinct film ${i}` }));
  expect(genericPlaylistArtwork(movies).has(generic)).toBe(true);
  const episodes = copies.map((entry, i) => ({ ...entry, normalized: `the simpsons s01 episode ${i}` }));
  expect(genericPlaylistArtwork(episodes).size).toBe(0);
});
it('imports unique identities while discarding shared provider decoration', async () => {
  const playlist = id();
  const content = '#EXTM3U\n' + Array.from({ length: 8 }, (_, n) => `#EXTINF:-1 type="movie" tvg-logo="${generic}",Distinct Film ${n} (2020)\nhttps://media.example.test/${n}.mp4`).join('\n');
  await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,?)', [playlist, 'Fixture', encrypt(content), 1]);
  await synchronizePlaylist(db, playlist);
  expect((await db.get('SELECT COUNT(*) n FROM titles'))?.n).toBe(8);
  expect((await db.get("SELECT COUNT(*) n FROM titles WHERE poster<>''"))?.n).toBe(0);
});
it('previews without mutation, audits old art and preserves confirmed/manual/channel artwork', async () => {
  const ids = await Promise.all(Array.from({ length: 10 }, (_, n) => createTitle(db, { name: `Separate movie ${n}`, poster: generic })));
  await db.run('UPDATE titles SET backdrop=poster WHERE id=?', [ids[0]]);
  await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,1)', [ids[1]]);
  await db.run("INSERT INTO metadata_lookups(title_id,identity_hash,status,checked_at,retry_after,result) VALUES(?,'fixture','matched',1,2,?)", [ids[2], JSON.stringify({ fields: ['poster'] })]);
  const channel = await createTitle(db, { name: 'Network channel', type: 'live', poster: generic });
  const plan = await previewGenericArtworkRepair(db);
  expect(plan).toHaveLength(8);
  expect((await db.get('SELECT poster FROM titles WHERE id=?', [ids[0]]))?.poster).toBe(generic);
  await db.run("UPDATE titles SET name='Edited after preview' WHERE id=?", [ids[3]]);
  expect(await applyGenericArtworkRepair(db, plan)).toEqual({ repaired: 7, skipped: 1 });
  expect(await db.get('SELECT poster,backdrop FROM titles WHERE id=?', [ids[0]])).toEqual({ poster: '', backdrop: '' });
  for (const protectedId of [ids[1], ids[2], ids[3], channel]) expect((await db.get('SELECT poster FROM titles WHERE id=?', [protectedId]))?.poster).toBe(generic);
  expect(JSON.parse((await db.get('SELECT details FROM audit_log WHERE entity_id=?', [ids[0]]))!.details).poster).toBe(generic);
});
