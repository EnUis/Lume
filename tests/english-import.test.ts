import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB, type Row } from '../lib/server/db';
import { synchronizePlaylist } from '../lib/server/pipeline';
import { enrichTitleMetadata } from '../lib/server/metadata';
import { catalog } from '../lib/server/catalog';
import { cleanDisplayTitle } from '../lib/server/m3u';
import { encrypt, id } from '../lib/server/security';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
const content = (name: string, type: string, year: number | null, source: number, attributes = '') => `#EXTM3U\n#EXTINF:-1 type="${type}" audio-language="de" ${attributes},${name}${year === null ? '' : ` (${year})`}${type === 'series' ? ' S01E01 - Arrival' : ''}\nhttps://provider.example/${type}/${source}.mp4\n`;
async function imported(value: string) {
  const playlistId = id();
  await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,?)', [playlistId, 'English import fixture', encrypt(value), Date.now()]);
  const report = await synchronizePlaylist(db, playlistId); return { playlistId, report };
}
async function renamed(name: string, english: string, type: 'movie' | 'series' | 'live', year: number | null) {
  const first = await imported(content(name, type, year, 1)); const source = (await db.get('SELECT id,title_id,episode_id FROM sources'))!;
  let time = Date.now();
  const result = await enrichTitleMetadata(db, source.title_id, {
    configuration: { enabled: true, language: 'en', licensedUrl: 'https://metadata.example/lookup', licensedKey: 'fixture' },
    now: () => time, sleep: async ms => { time += ms; },
    fetcher: async url => ({ url, status: 200, headers: {}, truncated: false, body: Buffer.from(JSON.stringify({ id: `verified-${year}`, name: cleanDisplayTitle(name, type), englishTitle: english, type, year, synopsis: 'Verified fixture description' })) }),
  });
  expect(result).toMatchObject({ matched: true });
  expect((await db.get('SELECT name FROM titles WHERE id=?', [source.title_id]))?.name).toBe(english);
  return { ...first, source };
}

it.each([
  ['Das Leben der Anderen', 'The Lives of Others', 'movie', 2006],
  ['Der Pass', 'Pagan Peak', 'series', 2019],
] as const)('retains verified English %s identity during original-language refreshes and imports', async (name, english, type, year) => {
  const { playlistId, source } = await renamed(name, english, type, year);
  await db.run("UPDATE sources SET playback_blocked=1,playback_blocked_at=20,health='unavailable',error='Browser fixture block' WHERE id=?", [source.id]);
  await db.run('UPDATE playlists SET content_encrypted=? WHERE id=?', [encrypt(content(name, type, year, 1) + '# changed playlist comment\n'), playlistId]);
  expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ added: 0, removed: 0, reviews: 0, unchanged: 1 });
  expect(await db.get('SELECT id,title_id,episode_id,playback_blocked,error FROM sources WHERE id=?', [source.id])).toMatchObject({ ...source, playback_blocked: 1, error: 'Browser fixture block' });
  expect((await imported(content(name, type, year, 2))).report).toMatchObject({ added: 1, reviews: 0 });
  expect((await imported(content(name, type, null, 3))).report).toMatchObject({ added: 1, reviews: 0 });
  expect(await db.get('SELECT COUNT(*) AS n FROM titles')).toMatchObject({ n: 1 });
  expect(await db.get('SELECT COUNT(*) AS n FROM sources WHERE title_id=?', [source.title_id])).toMatchObject({ n: 3 });
  expect(await db.get('SELECT name,synopsis,year FROM titles WHERE id=?', [source.title_id])).toMatchObject({ name: english, synopsis: 'Verified fixture description', year });
  expect(await db.get("SELECT COUNT(*) AS n FROM review_queue WHERE status='pending'")).toMatchObject({ n: 0 });
  if (type === 'series') expect(await db.get('SELECT COUNT(*) AS n FROM episodes')).toMatchObject({ n: 1 });
});

it('keeps explicit conflicting years separate and reviews an undated alias collision', async () => {
  const { source } = await renamed('Das Leben der Anderen', 'The Lives of Others', 'movie', 2006);
  const second = await imported(content('Das Leben der Anderen', 'movie', 2020, 2));
  expect(second.report).toMatchObject({ reviews: 0 });
  expect(await db.get('SELECT title_id FROM sources WHERE playlist_id=?', [second.playlistId])).not.toMatchObject({ title_id: source.title_id });
  const ambiguous = await imported(content('Das Leben der Anderen', 'movie', null, 3));
  expect(ambiguous.report).toMatchObject({ reviews: 1 });
  expect(await db.get('SELECT t.published FROM titles t JOIN sources s ON s.title_id=t.id WHERE s.playlist_id=?', [ambiguous.playlistId])).toMatchObject({ published: 0 });
  expect(await db.get('SELECT name,year FROM titles WHERE id=?', [source.title_id])).toMatchObject({ name: 'The Lives of Others', year: 2006 });
});

it('never bypasses a conflicting external identifier through a translated alias', async () => {
  const { source, playlistId } = await renamed('Das Leben der Anderen', 'The Lives of Others', 'movie', 2006);
  await db.run('INSERT INTO metadata_identifiers(id,title_id,provider,external_id) VALUES(?,?,?,?)', [id(), source.title_id, 'imdb', 'tt0405094']);
  await db.run('UPDATE playlists SET content_encrypted=? WHERE id=?', [encrypt(content('Das Leben der Anderen', 'movie', 2006, 1, 'imdb-id="tt9999999"')), playlistId]);
  expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ reviews: 1, added: 0 });
  const conflicting = await imported(content('Das Leben der Anderen', 'movie', 2006, 2, 'imdb-id="tt9999999"'));
  expect(conflicting.report).toMatchObject({ reviews: 1 });
  expect(await db.get('SELECT title_id FROM sources WHERE playlist_id=?', [conflicting.playlistId])).not.toMatchObject({ title_id: source.title_id });
  expect(await db.get('SELECT name FROM titles WHERE id=?', [source.title_id])).toMatchObject({ name: 'The Lives of Others' });
});

it('searches the retained imported spelling while loading aliases only for matching title IDs', async () => {
  const { source } = await renamed('Das Leben der Anderen', 'The Lives of Others', 'movie', 2006);
  await db.run("UPDATE sources SET health='healthy' WHERE id=?", [source.id]);
  await db.run("INSERT INTO titles(id,name,normalized,type,created_at,updated_at) VALUES('unrelated','Unrelated','unrelated','movie',1,1)");
  await db.run("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<650) INSERT INTO title_aliases(id,title_id,name,normalized) SELECT 'unrelated-alias-'||n,'unrelated','Other spelling '||n,'other spelling '||n FROM seq");
  const reads: unknown[][] = [];
  const traced: DB = { ...db, all: async <T extends Row = Row>(sql: string, values: unknown[] = []) => {
    if (sql.startsWith('SELECT title_id,normalized FROM title_aliases')) { expect(sql).toContain('WHERE title_id IN'); reads.push(values); }
    return db.all<T>(sql, values);
  } };
  const result = await catalog(traced, new URLSearchParams({ q: 'Das Leben' }));
  expect(result.total).toBe(1); expect(result.titles[0]?.name).toBe('The Lives of Others');
  expect(reads).toEqual([[source.title_id]]);
});

it('assigns an older unassigned episode through its verified original-name alias without changing English metadata or blocks', async () => {
  const { source, playlistId } = await renamed('Der Pass', 'Pagan Peak', 'series', 2019);
  const before = await db.get('SELECT name,normalized,synopsis,year FROM titles WHERE id=?', [source.title_id]);
  await db.run("UPDATE sources SET episode_id=NULL,playback_blocked=1,playback_blocked_at=25,health='unavailable',error='Browser fixture block' WHERE id=?", [source.id]);
  await db.run('UPDATE playlists SET content_encrypted=? WHERE id=?', [encrypt(content('Der Pass', 'series', 2019, 1) + '# reconcile old EP assignment\n'), playlistId]);
  expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ repaired: 1, reviews: 0, added: 0, removed: 0 });
  expect(await db.get('SELECT id,title_id,episode_id,playback_blocked,playback_blocked_at,health,error FROM sources WHERE id=?', [source.id])).toMatchObject({ ...source, playback_blocked: 1, playback_blocked_at: 25, health: 'unavailable', error: 'Browser fixture block' });
  expect(await db.get('SELECT name,normalized,synopsis,year FROM titles WHERE id=?', [source.title_id])).toEqual(before);
  expect(await db.get('SELECT COUNT(*) AS n FROM episodes WHERE title_id=?', [source.title_id])).toMatchObject({ n: 1 });
});

it.each(['administrator lock', 'conflicting release year'] as const)('keeps an unassigned source untouched after %s', async reason => {
  const { source, playlistId } = await renamed('Der Pass', 'Pagan Peak', 'series', 2019);
  await db.run('UPDATE sources SET episode_id=NULL WHERE id=?', [source.id]);
  if (reason === 'administrator lock') await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,?)', [source.title_id, Date.now()]);
  await db.run('UPDATE playlists SET content_encrypted=? WHERE id=?', [encrypt(content('Der Pass', 'series', reason === 'conflicting release year' ? 2020 : 2019, 1) + '# changed label\n'), playlistId]);
  expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ repaired: 0, added: 0 });
  expect(await db.get('SELECT episode_id FROM sources WHERE id=?', [source.id])).toMatchObject({ episode_id: null });
  expect(await db.get('SELECT name,year FROM titles WHERE id=?', [source.title_id])).toMatchObject({ name: 'Pagan Peak', year: 2019 });
});

it('preserves an English channel name and verified source during original Arabic upload refreshes without merging other playlists by alias', async () => {
  const original = 'الجزيرة HD'; const { source, playlistId } = await renamed(original, 'Al Jazeera', 'live', null);
  await db.run("UPDATE sources SET health='healthy',last_success=30,last_checked=30 WHERE id=?", [source.id]);
  await db.run('UPDATE playlists SET content_encrypted=? WHERE id=?', [encrypt(content(original, 'live', null, 1) + '# refreshed provider upload\n'), playlistId]);
  expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ added: 0, removed: 0, updated: 0, unchanged: 1, reviews: 0 });
  expect(await db.get('SELECT name,type,published,synopsis FROM titles WHERE id=?', [source.title_id])).toMatchObject({ name: 'Al Jazeera', type: 'live', published: 1, synopsis: 'Verified fixture description' });
  expect(await db.get('SELECT id,title_id,episode_id,health,last_success,last_checked,playback_blocked FROM sources WHERE id=?', [source.id])).toMatchObject({ ...source, episode_id: null, health: 'healthy', last_success: 30, last_checked: 30, playback_blocked: 0 });
  const other = await imported(content(original, 'live', null, 2));
  expect((await db.get('SELECT title_id FROM sources WHERE playlist_id=?', [other.playlistId]))?.title_id).not.toBe(source.title_id);
  await db.run('UPDATE playlists SET content_encrypted=? WHERE id=?', [encrypt(content(original, 'movie', null, 1).replace('/movie/1.mp4', '/live/1.mp4')), playlistId]);
  expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ added: 0, reviews: 1 });
  expect(await db.get('SELECT name,type FROM titles WHERE id=?', [source.title_id])).toMatchObject({ name: 'Al Jazeera', type: 'live' });
});
