import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB, type Row } from '../lib/server/db';
import { createTitle } from '../lib/server/pipeline';
import { mergeTitles } from '../lib/server/management';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });

async function insertRows(table: string, columns: string[], rows: unknown[][]) {
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    await db.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}`, batch.flat());
  }
}

function traceDatabase(database: DB, queries: string[]): DB {
  return {
    ...database,
    async all<T extends Row = Row>(sql: string, values?: unknown[]) { queries.push(sql); return database.all<T>(sql, values); },
    async get<T extends Row = Row>(sql: string, values?: unknown[]) { queries.push(sql); return database.get<T>(sql, values); },
    async run(sql, values = []) {
      queries.push(sql); expect((sql.match(/\?/g) || []).length).toBe(values.length);
      expect(values.length).toBeLessThanOrEqual(750); await database.run(sql, values);
    },
    transaction: fn => database.transaction(tx => fn(traceDatabase(tx, queries))),
  };
}

it('batches a large series merge while retaining source IDs, older redirects and account references', async () => {
  const from = await createTitle(db, { name: 'A Story German', type: 'series', year: 2021 });
  const to = await createTitle(db, { name: 'A Story', type: 'series', year: 2021 });
  await insertRows('seasons', ['id', 'title_id', 'number'], [['old-season-1', from, 1], ['old-season-2', from, 2], ['target-season-1', to, 1]]);
  const oldEpisodes = Array.from({ length: 650 }, (_, index) => {
    const season = index < 600 ? 1 : 2, number = index < 600 ? index + 1 : index - 599;
    return [`old-episode-${index + 1}`, from, `old-season-${season}`, season, number, index === 0 ? 'The Arrival' : `Episode ${number}`];
  });
  await insertRows('episodes', ['id', 'title_id', 'season_id', 'season', 'number', 'name'], oldEpisodes);
  await insertRows('episodes', ['id', 'title_id', 'season_id', 'season', 'number', 'name'], Array.from({ length: 300 }, (_, index) => [`target-episode-${index + 1}`, to, 'target-season-1', 1, index + 1, index === 1 ? 'A Supplied Name' : `Episode ${index + 1}`]));
  await db.run('UPDATE episodes SET duration=1800,intro_start=5,intro_end=40 WHERE id=?', ['old-episode-1']);
  await db.run('UPDATE episodes SET duration=2000 WHERE id=?', ['target-episode-2']);
  await insertRows('sources', ['id', 'title_id', 'episode_id', 'entry_key', 'name', 'url_encrypted', 'url_hash', 'health', 'language', 'playback_blocked', 'playback_blocked_at', 'error', 'created_at'], oldEpisodes.map((episode, index) => [`source-${index + 1}`, from, episode[0], `entry-${index + 1}`, 'Provider label', `private-ciphertext-${index + 1}`, `hash-${index + 1}`, index === 0 ? 'unavailable' : 'healthy', 'de', index === 0 ? 1 : 0, index === 0 ? 123 : null, index === 0 ? 'Browser failed' : null, 1]));
  const beforeSources = await db.all('SELECT id,url_encrypted,url_hash,health,language,playback_blocked,playback_blocked_at,error FROM sources ORDER BY id');
  await db.run('INSERT INTO episode_redirects(alias_id,episode_id,created_at) VALUES(?,?,1)', ['older-episode-url', 'old-episode-1']);
  await db.run('INSERT INTO title_redirects(alias_id,title_id,created_at) VALUES(?,?,1)', ['older-title-url', from]);
  await db.run("INSERT INTO users(id,email,name,password_hash,created_at) VALUES('viewer','merge@example.invalid','Viewer','unused',1)");
  await db.run("INSERT INTO profiles(id,user_id,name,created_at) VALUES('profile','viewer','Viewer',1)");
  await insertRows('playback_progress', ['user_id', 'profile_id', 'title_id', 'episode_id', 'item_key', 'position', 'duration', 'updated_at'], [
    ['viewer', 'profile', from, 'old-episode-1', 'old-episode-1', 50, 1800, 10],
    ['viewer', 'profile', to, 'target-episode-1', 'target-episode-1', 100, 1800, 20],
    ['viewer', 'profile', from, 'old-episode-650', 'old-episode-650', 150, 1800, 30],
  ]);
  await db.run("INSERT INTO watch_history(id,user_id,title_id,episode_id,position,duration,updated_at) VALUES('history','viewer',?,'old-episode-1',50,1800,10)", [from]);
  for (const table of ['watchlist', 'favorites']) await db.run(`INSERT INTO ${table}(user_id,title_id,created_at) VALUES('viewer',?,1)`, [from]);
  await db.run("INSERT INTO metadata_identifiers(id,title_id,provider,external_id) VALUES('identity',?,'imdb','tt-test')", [from]);
  await db.run("INSERT INTO title_aliases(id,title_id,name,normalized) VALUES('alias',?,'Alternate Story','alternate story')", [from]);
  await db.run('UPDATE titles SET synopsis=? WHERE id=?', ['A supplied synopsis', from]);

  const queries: string[] = [];
  await mergeTitles(traceDatabase(db, queries), from, to, { automatic: true });

  expect(queries.filter(sql => /^SELECT/.test(sql)).length).toBeLessThan(20);
  expect(queries.length).toBeLessThan(45);
  expect(queries.some(sql => /FROM seasons WHERE title_id=\? AND number=\?/.test(sql))).toBe(false);
  expect(queries.some(sql => /FROM episodes WHERE title_id=\? AND season=\? AND number=\?/.test(sql))).toBe(false);
  expect(queries.filter(sql => sql.startsWith('WITH mappings') && sql.includes('UPDATE sources'))).toHaveLength(2);
  expect(await db.all('SELECT id,url_encrypted,url_hash,health,language,playback_blocked,playback_blocked_at,error FROM sources ORDER BY id')).toEqual(beforeSources);
  expect((await db.get('SELECT COUNT(*) AS count FROM episodes WHERE title_id=?', [to]))?.count).toBe(650);
  expect((await db.get('SELECT COUNT(*) AS count FROM sources WHERE title_id=?', [to]))?.count).toBe(650);
  expect(await db.get('SELECT name,duration,intro_start,intro_end FROM episodes WHERE id=?', ['target-episode-1'])).toEqual({ name: 'The Arrival', duration: 1800, intro_start: 5, intro_end: 40 });
  expect(await db.get('SELECT name,duration FROM episodes WHERE id=?', ['target-episode-2'])).toEqual({ name: 'A Supplied Name', duration: 2000 });
  expect(await db.get('SELECT title_id,season,number FROM episodes WHERE id=?', ['old-episode-650'])).toEqual({ title_id: to, season: 2, number: 50 });
  expect(await db.get('SELECT episode_id FROM episode_redirects WHERE alias_id=?', ['older-episode-url'])).toEqual({ episode_id: 'target-episode-1' });
  expect((await db.get('SELECT COUNT(*) AS count FROM episode_redirects'))?.count).toBe(301);
  expect(await db.get('SELECT title_id FROM title_redirects WHERE alias_id=?', ['older-title-url'])).toEqual({ title_id: to });
  expect(await db.all('SELECT profile_id,title_id,episode_id,position,updated_at FROM playback_progress ORDER BY updated_at')).toEqual([
    { profile_id: 'profile', title_id: to, episode_id: 'target-episode-1', position: 100, updated_at: 20 },
    { profile_id: 'profile', title_id: to, episode_id: 'old-episode-650', position: 150, updated_at: 30 },
  ]);
  expect(await db.get("SELECT title_id,episode_id FROM watch_history WHERE id='history'")).toEqual({ title_id: to, episode_id: 'target-episode-1' });
  for (const table of ['watchlist', 'favorites']) expect(await db.all(`SELECT title_id FROM ${table}`)).toEqual([{ title_id: to }]);
  expect(await db.get("SELECT title_id FROM metadata_identifiers WHERE id='identity'")).toEqual({ title_id: to });
  expect((await db.all('SELECT normalized FROM title_aliases WHERE title_id=?', [to])).map(row => row.normalized)).toEqual(expect.arrayContaining(['alternate story', 'a story german']));
  expect(await db.get('SELECT synopsis FROM titles WHERE id=?', [to])).toEqual({ synopsis: 'A supplied synopsis' });
  expect(await db.get('SELECT id FROM titles WHERE id=?', [from])).toBeUndefined();
});

it('retains manual target metadata locks and transfers source locks during an explicit merge', async () => {
  const from = await createTitle(db, { name: 'Source', type: 'series' }), to = await createTitle(db, { name: 'Target', type: 'series' });
  await db.run('UPDATE titles SET synopsis=? WHERE id=?', ['Protected missing synopsis', from]);
  const timestamp = Date.now() + 10000;
  await insertRows('title_metadata_locks', ['title_id', 'updated_at'], [[from, timestamp], [to, 1]]);
  await mergeTitles(db, from, to);
  expect(await db.get('SELECT synopsis FROM titles WHERE id=?', [to])).toEqual({ synopsis: '' });
  expect(await db.get('SELECT updated_at FROM title_metadata_locks WHERE title_id=?', [to])).toEqual({ updated_at: timestamp });
});
