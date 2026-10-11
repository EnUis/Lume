import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { createTitle } from '../lib/server/pipeline';
import { backfillSourceLanguages, previewLanguageRepair, repairEpisodeNames, repairImportedClassifications, repairLanguageCatalog } from '../lib/server/language-repair';
import { resolveTitleId, titleDetails } from '../lib/server/catalog';
import { encrypt, hash, id } from '../lib/server/security';
let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
async function movie(name: string, year: number | null = 2020) {
  const titleId = await createTitle(db, { name, year }); const sourceId = id();
  await db.run("INSERT INTO sources(id,title_id,entry_key,name,url_encrypted,url_hash,health,created_at) VALUES(?,?,?,?,?,?,'healthy',?)", [sourceId, titleId, sourceId, 'Original provider', encrypt('https://media.example.test/file.mp4'), sourceId, Date.now()]);
  return { titleId, sourceId };
}
it('merges matching dated language versions and retains distinct remake years and source identities', async () => {
  const en = await movie('(EN) The Film'); const de = await movie('(DE) The Film'); const remake = await movie('(DE) The Film', 2025);
  const report = await repairLanguageCatalog(db); expect(report).toMatchObject({ renamed: 3, merged: 1 });
  const survivor = await resolveTitleId(db, de.titleId); expect(await resolveTitleId(db, en.titleId)).toBe(survivor);
  expect(await resolveTitleId(db, remake.titleId)).not.toBe(survivor);
  const sources = await db.all('SELECT id,language,name FROM sources WHERE title_id=? ORDER BY language', [survivor]);
  expect(sources.map(row => row.language)).toEqual(['de', 'en']); expect(new Set(sources.map(row => row.id))).toEqual(new Set([en.sourceId, de.sourceId]));
  expect(sources.every(row => row.name === 'Original provider')).toBe(true);
});
it('merges explicit unknown-year language copies but keeps unknown-year same-language identities separate', async () => {
  await movie('(EN) Shared Film', null); await movie('(DE) Shared Film', null);
  await movie('(DE) Ambiguous Film', null); await movie('(DE) Ambiguous Film', null);
  expect(await repairLanguageCatalog(db)).toMatchObject({ merged: 1 });
  expect((await db.get('SELECT COUNT(*) AS n FROM titles WHERE normalized=?', ['ambiguous film']))?.n).toBe(2);
});
it('keeps conflicting external identities for review instead of guessing language equivalence', async () => {
  const en = await movie('(EN) Shared Film'); const de = await movie('(DE) Shared Film');
  for (const [titleId, external] of [[en.titleId, 'tt1000001'], [de.titleId, 'tt1000002']]) await db.run('INSERT INTO metadata_identifiers(id,title_id,provider,external_id) VALUES(?,?,?,?)', [id(), titleId, 'imdb', external]);
  expect(await repairLanguageCatalog(db)).toMatchObject({ merged: 0, uncertainGroups: 1 });
  expect((await db.get('SELECT COUNT(*) AS n FROM review_queue'))?.n).toBe(1);
});
it('preserves browser blocks, metadata locks and saved progress without automatically merging locked identities', async () => {
  const de = await movie('(DE) The Film'); const en = await movie('(EN) The Film'); const userId = id();
  await db.run('UPDATE sources SET playback_blocked=1,playback_blocked_at=? WHERE id=?', [Date.now(), de.sourceId]);
  await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,?)', [en.titleId, Date.now()]);
  await db.run('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)', [userId, 'repair@example.test', 'Viewer', 'not-used', Date.now()]);
  await db.run('INSERT INTO playback_progress(user_id,title_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [userId, en.titleId, en.titleId, 65, 120, Date.now()]);
  expect(await repairLanguageCatalog(db)).toMatchObject({ merged: 0, protectedTitles: 1, uncertainGroups: 1 }); const survivor = await resolveTitleId(db, en.titleId);
  expect((await db.get('SELECT playback_blocked FROM sources WHERE id=?', [de.sourceId]))?.playback_blocked).toBe(1);
  expect(await db.get('SELECT title_id,position FROM playback_progress WHERE user_id=?', [userId])).toMatchObject({ title_id: survivor, position: 65 });
  expect(await db.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [survivor])).toBeTruthy();
  expect((await titleDetails(db, en.titleId))?.name).toBe('The Film');
  expect((await db.get('SELECT name FROM titles WHERE id=?', [en.titleId]))?.name).toBe('(EN) The Film');
  expect(await resolveTitleId(db, de.titleId)).not.toBe(survivor);
});
it('recovers attribute languages from saved snapshots without replacing provider names or health', async () => {
  const film = await movie('The Film'); const playlistId = id(); const url = 'https://media.example.test/file.mp4';
  await db.run('INSERT INTO playlists(id,name,created_at) VALUES(?,?,?)', [playlistId, 'Provider', Date.now()]);
  await db.run('UPDATE sources SET playlist_id=?,url_hash=?,playback_blocked=1 WHERE id=?', [playlistId, hash(url), film.sourceId]);
  await db.run('INSERT INTO playlist_versions(id,playlist_id,content_encrypted,content_hash,report,created_at) VALUES(?,?,?,?,?,?)', [id(), playlistId, encrypt(`#EXTM3U\n#EXTINF:-1 audio-language="de",The Film (2020)\n${url}`), 'fixture', '{}', Date.now()]);
  expect(await backfillSourceLanguages(db)).toBe(1);
  expect(await db.get('SELECT language,original_name,name,playback_blocked FROM sources WHERE id=?', [film.sourceId])).toEqual({ language: 'de', original_name: 'The Film (2020)', name: 'Original provider', playback_blocked: 1 });
  expect(await backfillSourceLanguages(db)).toBe(0);
});
it('joins an explicit undated language version to its unique dated work', async () => {
  await movie('(EN) The Film', 2020); await movie('(DE) The Film', null);
  expect(await repairLanguageCatalog(db)).toMatchObject({ merged: 1, uncertainGroups: 0 });
  expect((await db.get('SELECT COUNT(*) AS n FROM titles'))?.n).toBe(1);
  expect((await db.get('SELECT year FROM titles'))?.year).toBe(2020);
});
it('does not use another language to join multiple undated same-language films', async () => {
  await movie('(DE) Ambiguous Film', null); await movie('(DE) Ambiguous Film', null); await movie('(EN) Ambiguous Film', null);
  expect(await repairLanguageCatalog(db)).toMatchObject({ merged: 0, uncertainGroups: 1 });
  expect((await db.get('SELECT COUNT(*) AS n FROM titles'))?.n).toBe(3);
});

it('cleans watermarks, recovers a missing year and remains idempotent without changing blocked sources', async () => {
  const original = await movie('After.Life (2009) | 🌟 FREE IPTV WORLD 🌟', null);
  const ordinary = await movie('Animale | Umano', 2024);
  await db.run("UPDATE sources SET playback_blocked=1,playback_blocked_at=101,health='unavailable',error='Browser decoder failed',language='en' WHERE id=?", [original.sourceId]);
  const sourceBefore = await db.get('SELECT * FROM sources WHERE id=?', [original.sourceId]);
  expect(await repairLanguageCatalog(db)).toMatchObject({ renamed: 1, recoveredYears: 1, merged: 0 });
  expect(await db.get('SELECT id,name,normalized,year FROM titles WHERE id=?', [original.titleId])).toEqual({ id: original.titleId, name: 'After.Life', normalized: 'after life', year: 2009 });
  expect(await db.get('SELECT name FROM titles WHERE id=?', [ordinary.titleId])).toEqual({ name: 'Animale | Umano' });
  expect(await db.get('SELECT * FROM sources WHERE id=?', [original.sourceId])).toEqual(sourceBefore);
  expect(await db.get('SELECT name FROM title_aliases WHERE title_id=?', [original.titleId])).toEqual({ name: 'After.Life (2009) | 🌟 FREE IPTV WORLD 🌟' });
  expect(await repairLanguageCatalog(db)).toMatchObject({ renamed: 0, recoveredYears: 0, merged: 0 });
});

it('merges unknown-year quality versions but preserves multiple stated remake years', async () => {
  await movie('[EN] Shared Film [FHD]', null); await movie('[EN] Shared Film [4K]', null);
  await movie('[EN] Remake (1990)', null); await movie('[DE] Remake (2020)', null); await movie('[FR] Remake', null);
  expect(await repairLanguageCatalog(db)).toMatchObject({ merged: 1, recoveredYears: 2, uncertainGroups: 1 });
  expect((await db.get("SELECT COUNT(*) AS n FROM titles WHERE normalized='shared film'"))?.n).toBe(1);
  expect((await db.get("SELECT COUNT(*) AS n FROM titles WHERE normalized='remake'"))?.n).toBe(3);
});

it('keeps explicit stored release years when an imported label states a conflicting year', async () => {
  const original = await movie('[EN] The Film (2021)', 2020); await movie('[DE] The Film (2021)', 2021);
  expect(await repairLanguageCatalog(db)).toMatchObject({ merged: 0, uncertainGroups: 1 });
  expect(await db.get('SELECT name,year FROM titles WHERE id=?', [original.titleId])).toEqual({ name: '[EN] The Film (2021)', year: 2020 });
});

it('preserves account references and fills only missing metadata when compatible versions merge', async () => {
  const original = await movie('[EN] The Film'); const alternate = await movie('[DE] The Film'); const userId = id();
  await db.run('UPDATE titles SET synopsis=?,poster=? WHERE id=?', ['A supplied description', '/images/supplied.jpg', original.titleId]);
  await db.run('UPDATE titles SET director=? WHERE id=?', ['Director Example', alternate.titleId]);
  await db.run("UPDATE sources SET playback_blocked=1,playback_blocked_at=99,health='unavailable',error='Browser failed' WHERE id=?", [alternate.sourceId]);
  const sourceBefore = await db.get('SELECT id,url_hash,url_encrypted,playback_blocked,playback_blocked_at,health,error FROM sources WHERE id=?', [alternate.sourceId]);
  await db.run('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,1)', [userId, 'preservation@example.test', 'Viewer', 'unused']);
  for (const reference of [original, alternate]) {
    await db.run('INSERT INTO watchlist(user_id,title_id,created_at) VALUES(?,?,1)', [userId, reference.titleId]);
    await db.run('INSERT INTO favorites(user_id,title_id,created_at) VALUES(?,?,1)', [userId, reference.titleId]);
  }
  await db.run('INSERT INTO playback_progress(user_id,title_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [userId, original.titleId, original.titleId, 75, 300, 10]);
  await db.run('INSERT INTO playback_progress(user_id,title_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [userId, alternate.titleId, alternate.titleId, 95, 300, 20]);
  await db.run('INSERT INTO watch_history(id,user_id,title_id,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [id(), userId, alternate.titleId, 95, 300, 20]);
  expect(await repairLanguageCatalog(db)).toMatchObject({ merged: 1 });
  const survivor = await resolveTitleId(db, alternate.titleId);
  expect(await resolveTitleId(db, original.titleId)).toBe(survivor);
  expect(await db.get('SELECT synopsis,poster,director FROM titles WHERE id=?', [survivor])).toEqual({ synopsis: 'A supplied description', poster: '/images/supplied.jpg', director: 'Director Example' });
  expect(await db.get('SELECT title_id,position,updated_at FROM playback_progress WHERE user_id=?', [userId])).toEqual({ title_id: survivor, position: 95, updated_at: 20 });
  expect(await db.get('SELECT title_id,position FROM watch_history WHERE user_id=?', [userId])).toEqual({ title_id: survivor, position: 95 });
  for (const table of ['watchlist', 'favorites']) expect(await db.all(`SELECT title_id FROM ${table} WHERE user_id=?`, [userId])).toEqual([{ title_id: survivor }]);
  expect(await db.get('SELECT id,url_hash,url_encrypted,playback_blocked,playback_blocked_at,health,error FROM sources WHERE id=?', [alternate.sourceId])).toEqual(sourceBefore);
});

it('previews exact cleanup and merges while rolling back all catalog mutations', async () => {
  await movie('[EN] The Film (2020) [HD]', null); await movie('[DE] The Film (2020) [4K]', null);
  const before = await db.all('SELECT * FROM titles ORDER BY id'); const sources = await db.all('SELECT * FROM sources ORDER BY id');
  expect((await previewLanguageRepair(db)).report).toMatchObject({ renamed: 2, recoveredYears: 2, merged: 1 });
  expect(await db.all('SELECT * FROM titles ORDER BY id')).toEqual(before);
  expect(await db.all('SELECT * FROM sources ORDER BY id')).toEqual(sources);
  for (const table of ['title_aliases', 'title_redirects', 'episode_redirects', 'review_queue']) expect((await db.get(`SELECT COUNT(*) AS n FROM ${table}`))?.n).toBe(0);
  expect(await repairLanguageCatalog(db)).toMatchObject({ renamed: 2, recoveredYears: 2, merged: 1 });
});

it('repairs confirmed saved transport channels without changing source state or protected movie identities', async () => {
  const channel = await movie('CINESTAR 1 ()', null), locked = await movie('STAR TV', null), dated = await movie('The Film', 2020), explicit = await movie('Another Film', null);
  const playlistId = id(); const entries = [
    { title: channel, name: 'CINESTAR 1 (HD)', attributes: '' },
    { title: locked, name: 'STAR TV', attributes: '' },
    { title: dated, name: 'The Film (2020)', attributes: '' },
    { title: explicit, name: 'Another Film', attributes: 'type="movie"' },
  ];
  const content = '#EXTM3U\n' + entries.map((entry, index) => `#EXTINF:-1 group-title="FILMSKI / MOVIE" ${entry.attributes},${entry.name}\nhttp://media.example.test:8080/${index}.ts\n`).join('');
  await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,1)', [playlistId, 'Saved channel fixture', encrypt(content)]);
  for (let index = 0; index < entries.length; index++) await db.run('UPDATE sources SET playlist_id=?,url_hash=?,original_name=? WHERE id=?', [playlistId, hash(`http://media.example.test:8080/${index}.ts`), entries[index].name, entries[index].title.sourceId]);
  await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,1)', [locked.titleId]);
  await db.run("UPDATE sources SET playback_blocked=1,playback_blocked_at=99,health='unavailable',error='Browser failed' WHERE id=?", [channel.sourceId]);
  const sources = await db.all('SELECT * FROM sources ORDER BY id');
  expect(await repairImportedClassifications(db)).toEqual({ reclassified: 1, renamed: 1 });
  expect(await db.get('SELECT id,name,type FROM titles WHERE id=?', [channel.titleId])).toEqual({ id: channel.titleId, name: 'CINESTAR 1', type: 'live' });
  for (const retained of [locked, dated, explicit]) expect((await db.get('SELECT type FROM titles WHERE id=?', [retained.titleId]))?.type).toBe('movie');
  expect(await db.all('SELECT * FROM sources ORDER BY id')).toEqual(sources);
  expect(await repairImportedClassifications(db)).toEqual({ reclassified: 0, renamed: 0 });
});

it('does not reclassify a source whose URL identity changed after saved-label inspection', async () => {
  const channel = await movie('STAR TV', null), playlistId = id(), url = 'http://media.example.test:8080/142.ts';
  await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,1)', [playlistId, 'Race fixture', encrypt(`#EXTM3U\n#EXTINF:-1 group-title="FILMSKI / MOVIE",STAR TV\n${url}`)]);
  await db.run('UPDATE sources SET playlist_id=?,url_hash=?,original_name=? WHERE id=?', [playlistId, hash(url), 'STAR TV', channel.sourceId]);
  const guarded: DB = { ...db, transaction: async fn => { await db.run('UPDATE sources SET url_hash=? WHERE id=?', [hash('https://media.example.test/movie/replacement.mp4'), channel.sourceId]); return db.transaction(fn); } };
  expect(await repairImportedClassifications(guarded)).toEqual({ reclassified: 0, renamed: 0 });
  expect((await db.get('SELECT type FROM titles WHERE id=?', [channel.titleId]))?.type).toBe('movie');
});

it('replaces pure provider episode labels but retains narrative names and protected manual episode edits', async () => {
  const titleId = await createTitle(db, { name: 'A Show', type: 'series' }), lockedId = await createTitle(db, { name: 'A Protected Show', type: 'series' });
  const seasons = new Map<string, string>();
  for (const title of [titleId, lockedId]) { const seasonId = id(); seasons.set(title, seasonId); await db.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,1)', [seasonId, title]); }
  const names = ['🌟 FREE IPTV WORLD 🌟', '[1080p]', '[EN]', '', 'Pilot', 'The Arrival [FHD]', '(HD)']; const episodeIds: string[] = [];
  for (let number = 1; number <= names.length; number++) {
    const episodeId = id(); episodeIds.push(episodeId);
    await db.run('INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES(?,?,?,1,?,?)', [episodeId, titleId, seasons.get(titleId), number, names[number - 1]]);
  }
  await db.run("INSERT INTO audit_log(id,action,entity_id,created_at) VALUES(?,'episode.update',?,1)", [id(), episodeIds[6]]);
  const protectedEpisode = id(); await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,1)', [lockedId]);
  await db.run('INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES(?,?,?,1,1,?)', [protectedEpisode, lockedId, seasons.get(lockedId), '🌟 FREE IPTV WORLD 🌟']);
  expect(await repairEpisodeNames(db)).toBe(4);
  expect((await db.all('SELECT name FROM episodes WHERE title_id=? ORDER BY number', [titleId])).map(row => row.name)).toEqual(['Episode 1', 'Episode 2', 'Episode 3', 'Episode 4', 'Pilot', 'The Arrival [FHD]', '(HD)']);
  expect((await db.get('SELECT name FROM episodes WHERE id=?', [protectedEpisode]))?.name).toBe('🌟 FREE IPTV WORLD 🌟');
  expect(await repairEpisodeNames(db)).toBe(0);
});
