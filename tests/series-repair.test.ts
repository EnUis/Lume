import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { createTitle } from '../lib/server/pipeline';
import { cleanSeriesTitle, parseEpisodeTitle, parseM3U } from '../lib/server/m3u';
import { previewSeriesRepair, repairImportedSeries, repairSeriesCatalog } from '../lib/server/language-repair';
import { resolveEpisodeId, resolveTitleId } from '../lib/server/catalog';
import { encrypt, hash, id } from '../lib/server/security';
import * as management from '../lib/server/management';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { vi.restoreAllMocks(); await db.close(); });
async function split(name: string, year: number | null = null, type = 'movie', originalName: string | null = name) {
  const titleId = await createTitle(db, { name, type, year }), sourceId = id(), url = `https://fixture.example.test/${sourceId}.mp4`;
  await db.run("INSERT INTO sources(id,title_id,entry_key,name,original_name,url_encrypted,url_hash,health,created_at) VALUES(?,?,?,?,?,?,?,'healthy',1)", [sourceId, titleId, sourceId, 'Saved provider label', originalName, encrypt(url), hash(url)]);
  return { titleId, sourceId, url };
}
function playlist(names: string[]) { return '#EXTM3U\n' + names.map((name, index) => `#EXTINF:-1,${name}\nhttps://fixture.example.test/${index}.mp4`).join('\n'); }
function postgresFixtureReads(): DB {
  const prefilter = (sql: string) => sql.replace(/COALESCE\((?:t\.name|s\.original_name),''\) ~\* '[^']+'/g, '1=1');
  return { ...db, dialect: 'postgres', all: (sql, values) => db.all(prefilter(sql).replace(/ FOR UPDATE$/g, ''), values), get: (sql, values) => db.get(sql.replace(/ FOR UPDATE$/g, ''), values) };
}
async function structuredFamily(name: string, copies: number) {
  const ids: string[] = [];
  for (let index = 0; index < copies; index++) {
    const old = await split(name, null, 'series', `${name} S1EP${index + 1}`), seasonId = id(), episodeId = id();
    ids.push(old.titleId);
    await db.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,1)', [seasonId, old.titleId]);
    await db.run('INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES(?,?,?,1,?,?)', [episodeId, old.titleId, seasonId, index + 1, `Episode ${index + 1}`]);
    await db.run('UPDATE sources SET episode_id=? WHERE id=?', [episodeId, old.sourceId]);
  }
  return ids;
}

describe('explicit episode title parsing', () => {
  it('reads explicit numbered provider season and episode labels', () => {
    expect(parseEpisodeTitle('Lud, zbunjen, normalan (2020) : Season # 1 : Episode # 2')).toMatchObject({ title: 'Lud, zbunjen, normalan (2020)', season: 1, episode: 2 });
    expect(parseEpisodeTitle('A Show S01 The Pilot')).toBeNull();
  });
  it('groups EP/Episode variants before or after the same numbered show title', () => {
    const result = parseM3U(playlist(['S1 EP1 The 100 (2014) [EN]', '[DE] Season 1 Ep. 1 - The 100 (2014)', 'The 100 (2014) - S01 EP02 - Earth Skills', 'The 100 (2014) Season1 Episode3']));
    expect(result.errors).toEqual([]);
    expect(result.entries.map(entry => [entry.title, entry.year, entry.season, entry.episode])).toEqual([['The 100', 2014, 1, 1], ['The 100', 2014, 1, 1], ['The 100', 2014, 1, 2], ['The 100', 2014, 1, 3]]);
    expect(result.entries.map(entry => entry.language)).toEqual(['en', 'de', null, null]);
    expect(result.entries[2].episodeName).toBe('Earth Skills');
  });
  it('removes repeated show names around a season badge only when identities agree', () => {
    const result = parseM3U(playlist(['نفس (2025) S01 نفس (2025) - S01E01', 'نفس (2025) S02 نفس (2025) - S02EP02']));
    expect(result.entries.map(entry => [entry.title, entry.year, entry.season])).toEqual([['نفس', 2025, 1], ['نفس', 2025, 2]]);
    expect(cleanSeriesTitle('Show (2020) S01 Show (2025)')).toBe('Show (2020) S01 Show (2025)');
    expect(cleanSeriesTitle('Show S01 A Different Show')).toBe('Show S01 A Different Show');
  });
  it('keeps legitimate digits and declines missing show names or conflicting coordinates', () => {
    expect(parseEpisodeTitle('S1EP1')).toBeNull();
    expect(parseEpisodeTitle('S1EP1 Episode 1')).toBeNull();
    expect(parseEpisodeTitle('Show S1EP1 S2EP2')).toBeNull();
    expect(parseEpisodeTitle('24 S01EP01')).toMatchObject({ title: '24', season: 1, episode: 1 });
    expect(parseM3U(playlist(['Blade Runner 2049', 'Class of 1984', '9-1-1 S01EP02'])).entries.map(entry => entry.title)).toEqual(['Blade Runner 2049', 'Class of 1984', '9-1-1']);
  });
});

describe('saved episode series repair', () => {
  it('joins existing season containers even when original source labels lack episode coordinates', async () => {
    const first = await split('مدرسة النخبة S01 مدرسة النخبة', null, 'series', 'مدرسة النخبة S01');
    const second = await split('مدرسة النخبة [S02]', null, 'series', 'مدرسة النخبة S02');
    const protectedTitle = await split('Protected Show S01', null, 'series', 'Protected Show');
    const episodeIds: string[] = [];
    for (const [old, season] of [[first, 1], [second, 2], [protectedTitle, 1]] as const) {
      const seasonId = id(), episodeId = id(); episodeIds.push(episodeId);
      await db.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,?)', [seasonId, old.titleId, season]);
      await db.run('INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES(?,?,?,?,?,?)', [episodeId, old.titleId, seasonId, season, 1, 'A real episode name']);
      await db.run('UPDATE sources SET episode_id=? WHERE id=?', [episodeId, old.sourceId]);
    }
    await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,1)', [protectedTitle.titleId]);
    const sourcesBefore = await db.all('SELECT id,url_hash,health,playback_blocked FROM sources ORDER BY id');
    const report = await repairSeriesCatalog(db);
    expect(report).toMatchObject({ renamed: 2, seriesRepaired: 2, episodesCreated: 0, merged: 1 });
    const canonical = await resolveTitleId(db, first.titleId);
    expect(await resolveTitleId(db, second.titleId)).toBe(canonical);
    expect(await db.get('SELECT name FROM titles WHERE id=?', [canonical])).toEqual({ name: 'مدرسة النخبة' });
    expect((await db.all('SELECT id FROM episodes ORDER BY id')).map(row => row.id)).toEqual(episodeIds.sort());
    expect(await db.all('SELECT id,url_hash,health,playback_blocked FROM sources ORDER BY id')).toEqual(sourcesBefore);
    expect(await db.get('SELECT name FROM titles WHERE id=?', [protectedTitle.titleId])).toEqual({ name: 'Protected Show S01' });
  });

  it('does not use season-container cleanup to override conflicting source coordinates', async () => {
    const old = await split('Uncertain Show S01', null, 'series', 'Uncertain Show S01E02');
    const seasonId = id(), episodeId = id();
    await db.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,1)', [seasonId, old.titleId]);
    await db.run('INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES(?,?,?,1,1,?)', [episodeId, old.titleId, seasonId, 'Existing chapter']);
    await db.run('UPDATE sources SET episode_id=? WHERE id=?', [episodeId, old.sourceId]);
    expect(await repairSeriesCatalog(db)).toMatchObject({ renamed: 0, seriesRepaired: 0, merged: 0, uncertainGroups: 1 });
    expect(await db.get('SELECT name FROM titles WHERE id=?', [old.titleId])).toEqual({ name: 'Uncertain Show S01' });
  });

  it('consolidates old movie-like episode cards and keeps languages, progress, lists, health and redirects', async () => {
    const first = await split('[EN] S1 EP1 Example Show (2020)'), alternate = await split('[DE] S1 EP1 Example Show (2020)'), second = await split('Example Show (2020) S1 EP2 - The Return');
    await db.run('UPDATE titles SET synopsis=?,poster=?,director=? WHERE id=?', ['Existing description', '/images/existing.jpg', 'Director Example', first.titleId]);
    await db.run("UPDATE sources SET playback_blocked=1,playback_blocked_at=99,health='unavailable',error='Decoder failed' WHERE id=?", [alternate.sourceId]);
    const before = await db.all('SELECT id,url_hash,url_encrypted,name,health,error,playback_blocked,playback_blocked_at FROM sources ORDER BY id');
    const userId = id(); await db.run('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,1)', [userId, 'episode-fixture@example.test', 'Fixture', 'unused']);
    for (const old of [first, alternate, second]) await db.run('INSERT INTO watchlist(user_id,title_id,created_at) VALUES(?,?,1)', [userId, old.titleId]);
    await db.run('INSERT INTO favorites(user_id,title_id,created_at) VALUES(?,?,1)', [userId, second.titleId]);
    await db.run('INSERT INTO playback_progress(user_id,title_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [userId, first.titleId, first.titleId, 45, 300, 10]);
    await db.run('INSERT INTO playback_progress(user_id,title_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [userId, alternate.titleId, alternate.titleId, 65, 300, 20]);
    await db.run('INSERT INTO playback_progress(user_id,title_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [userId, second.titleId, second.titleId, 80, 300, 30]);
    await db.run('INSERT INTO watch_history(id,user_id,title_id,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [id(), userId, second.titleId, 80, 300, 30]);
    const report = await repairSeriesCatalog(db);
    expect(report).toMatchObject({ renamed: 3, reclassified: 3, seriesRepaired: 3, episodesCreated: 3, merged: 2, uncertainGroups: 0 });
    const canonical = await resolveTitleId(db, first.titleId);
    expect(await resolveTitleId(db, alternate.titleId)).toBe(canonical); expect(await resolveTitleId(db, second.titleId)).toBe(canonical);
    expect(await db.get('SELECT name,type,year,synopsis,poster,director FROM titles WHERE id=?', [canonical])).toEqual({ name: 'Example Show', type: 'series', year: 2020, synopsis: 'Existing description', poster: '/images/existing.jpg', director: 'Director Example' });
    const episodes = await db.all('SELECT id,season,number FROM episodes WHERE title_id=? ORDER BY number', [canonical]);
    expect(episodes.map(episode => [episode.season, episode.number])).toEqual([[1, 1], [1, 2]]);
    expect(await resolveEpisodeId(db, alternate.titleId)).toBe(episodes[0].id); expect(await resolveEpisodeId(db, second.titleId)).toBe(episodes[1].id);
    expect(await db.all('SELECT episode_id,position FROM playback_progress WHERE user_id=? ORDER BY position', [userId])).toEqual([{ episode_id: episodes[0].id, position: 65 }, { episode_id: episodes[1].id, position: 80 }]);
    expect(await db.get('SELECT title_id,episode_id,position FROM watch_history WHERE user_id=?', [userId])).toEqual({ title_id: canonical, episode_id: episodes[1].id, position: 80 });
    for (const table of ['watchlist', 'favorites']) expect(await db.all(`SELECT title_id FROM ${table} WHERE user_id=?`, [userId])).toEqual([{ title_id: canonical }]);
    expect(await db.all('SELECT id,url_hash,url_encrypted,name,health,error,playback_blocked,playback_blocked_at FROM sources ORDER BY id')).toEqual(before);
    expect((await db.all('SELECT language FROM sources WHERE id IN (?,?) ORDER BY language', [first.sourceId, alternate.sourceId])).map(row => row.language)).toEqual(['de', 'en']);
    expect(await repairSeriesCatalog(db)).toMatchObject({ renamed: 0, reclassified: 0, seriesRepaired: 0, episodesCreated: 0, merged: 0 });
  });

  it('uses encrypted saved snapshots when original labels are absent, without needing provider URLs', async () => {
    const first = await split('S1 EP1 Offline Show', null, 'movie', null), second = await split('S1 EP2 Offline Show', null, 'movie', null), playlistId = id();
    await db.run('INSERT INTO playlists(id,name,url_encrypted,created_at) VALUES(?,?,?,1)', [playlistId, 'Unavailable provider', encrypt('https://deleted-provider.example.test/playlist')]);
    const content = `#EXTM3U\n#EXTINF:-1 audio-language="en",S1 EP1 Offline Show\n${first.url}\n#EXTINF:-1 audio-language="de",S1 EP2 Offline Show\n${second.url}`;
    await db.run('INSERT INTO playlist_versions(id,playlist_id,content_encrypted,content_hash,report,created_at) VALUES(?,?,?,?,?,1)', [id(), playlistId, encrypt(content), 'fixture', '{}']);
    await db.run('UPDATE sources SET playlist_id=?', [playlistId]);
    expect(await repairSeriesCatalog(db)).toMatchObject({ reclassified: 2, episodesCreated: 2, merged: 1 });
    expect((await db.all('SELECT language,original_name FROM sources ORDER BY language')).map(row => [row.language, row.original_name])).toEqual([['de', 'S1 EP2 Offline Show'], ['en', 'S1 EP1 Offline Show']]);
  });

  it('cleans repeated season show names and joins seasons while preserving existing episode IDs', async () => {
    const first = await split('شجون و الاطفال S01 شجون و الاطفال', null, 'series', 'شجون و الاطفال S01 شجون و الاطفال - S01E03');
    const second = await split('شجون و الاطفال S02 شجون و الاطفال', null, 'series', 'شجون و الاطفال S02 شجون و الاطفال - S02E12');
    const ids: string[] = [];
    for (const [old, season, number] of [[first, 1, 3], [second, 2, 12]] as const) {
      const seasonId = id(), episodeId = id(); ids.push(episodeId);
      await db.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,?)', [seasonId, old.titleId, season]);
      await db.run('INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES(?,?,?,?,?,?)', [episodeId, old.titleId, seasonId, season, number, 'Existing narrative name']);
      await db.run('UPDATE sources SET episode_id=? WHERE id=?', [episodeId, old.sourceId]);
    }
    expect(await repairSeriesCatalog(db)).toMatchObject({ renamed: 2, episodesCreated: 0, merged: 1 });
    expect((await db.all('SELECT name FROM titles')).map(row => row.name)).toEqual(['شجون و الاطفال']);
    expect(new Set((await db.all('SELECT id FROM episodes')).map(row => row.id))).toEqual(new Set(ids));
    expect((await db.all('SELECT name FROM episodes')).every(row => row.name === 'Existing narrative name')).toBe(true);
  });

  it('preserves remakes, locked edits, English metadata names and missing show identities', async () => {
    const original = await split('S1 EP1 Remade Show (1990)'), remake = await split('S1 EP2 Remade Show (2020)'), unknown = await split('S1 EP3 Remade Show');
    const locked = await split('S1 EP1 Protected Show'); await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,1)', [locked.titleId]);
    const english = await split('Verified English Show', 2020, 'series', 'S1 EP1 Localized Provider Name (2020)');
    await db.run('INSERT INTO metadata_identifiers(id,title_id,provider,external_id) VALUES(?,?,?,?)', [id(), english.titleId, 'tmdb-series', '123']);
    const noName = await split('S1 EP1', null, 'series');
    expect(await repairSeriesCatalog(db)).toMatchObject({ merged: 0 });
    expect(await resolveTitleId(db, original.titleId)).not.toBe(await resolveTitleId(db, remake.titleId));
    expect(await resolveTitleId(db, unknown.titleId)).toBe(unknown.titleId);
    for (const [old, expected] of [[locked, 'S1 EP1 Protected Show'], [english, 'Verified English Show'], [noName, 'S1 EP1']] as const) expect((await db.get('SELECT name FROM titles WHERE id=?', [old.titleId]))?.name).toBe(expected);
    expect((await db.get("SELECT COUNT(*) AS n FROM review_queue WHERE status='pending'"))?.n).toBeGreaterThan(0);
  });

  it('previews all series changes with rollback', async () => {
    await split('S1 EP1 Preview Show'); await split('S1 EP2 Preview Show');
    const before = await db.all('SELECT * FROM titles ORDER BY id'), sources = await db.all('SELECT * FROM sources ORDER BY id');
    expect(await previewSeriesRepair(db)).toMatchObject({ seriesRepaired: 2, merged: 1 });
    expect(await db.all('SELECT * FROM titles ORDER BY id')).toEqual(before); expect(await db.all('SELECT * FROM sources ORDER BY id')).toEqual(sources);
    for (const table of ['episodes', 'seasons', 'title_redirects', 'episode_redirects']) expect((await db.get(`SELECT COUNT(*) AS n FROM ${table}`))?.n).toBe(0);
  });

  it('keeps PostgreSQL prefilter quantifiers separate from parameter placeholders', async () => {
    let selects = 0;
    const guarded: DB = { ...db, dialect: 'postgres', all: async (sql, values = []) => { selects++; expect(sql.match(/\?/g)?.length || 0).toBe(values.length); return []; } };
    expect(await repairImportedSeries(guarded)).toMatchObject({ seriesRepaired: 0 });
    expect(selects).toBe(3);
  });

  it('reads candidate sources in batches of at most 200 title IDs', async () => {
    for (let index = 0; index < 201; index++) await split(`S1 EP1 Fixture Show ${index}`);
    const batches: number[] = [];
    const guarded: DB = { ...db, all: async (sql, values = []) => { if (sql.includes('WHERE removed=0 AND title_id IN')) batches.push(values.length); return db.all(sql, values); } };
    expect(await repairImportedSeries(guarded)).toMatchObject({ seriesRepaired: 201, episodesCreated: 201 });
    expect(batches.sort((a, b) => a - b)).toEqual([1, 200]);
  });

  it('rechecks source identity before changing a title inspected outside its transaction', async () => {
    const old = await split('S1 EP1 Race Show');
    const guarded: DB = { ...db, transaction: async fn => { await db.run('UPDATE sources SET url_hash=? WHERE id=?', [hash('https://fixture.example.test/new.mp4'), old.sourceId]); return db.transaction(fn); } };
    expect(await repairImportedSeries(guarded)).toMatchObject({ seriesRepaired: 0, renamed: 0, episodesCreated: 0 });
    expect((await db.get('SELECT name FROM titles WHERE id=?', [old.titleId]))?.name).toBe('S1 EP1 Race Show');
  });

  it('bounds independent PostgreSQL repairs and drains transactions before the next phase', async () => {
    for (let index = 0; index < 13; index++) await split(`S1 EP1 Parallel Show ${index}`);
    let active = 0, peak = 0, completed = 0;
    const prefilter = (sql: string) => sql.replace(/COALESCE\((?:t\.name|s\.original_name),''\) ~\* '[^']+'/g, '1=1');
    const scoped = (tx: DB): DB => ({ ...tx, dialect: 'postgres', all: (sql, values) => tx.all(prefilter(sql).replace(/ FOR UPDATE$/g, ''), values), get: (sql, values) => tx.get(sql.replace(/ FOR UPDATE$/g, ''), values) });
    const parallel: DB = { ...scoped(db), transaction: async fn => {
      active++; peak = Math.max(peak, active);
      try { await new Promise<void>(resolve => setImmediate(resolve)); return await db.transaction(tx => fn(scoped(tx))); }
      finally { active--; completed++; }
    } };
    const progress = () => { expect(active).toBe(0); };
    expect(await repairImportedSeries(parallel, undefined, progress, { concurrency: 6 })).toMatchObject({ seriesRepaired: 13, episodesCreated: 13 });
    expect(peak).toBe(6); expect(completed).toBe(13); expect(active).toBe(0);
    expect((await db.get('SELECT COUNT(*) AS n FROM episodes'))?.n).toBe(13);
  });

  it('stops scheduling on a transaction failure and awaits every in-flight repair', async () => {
    for (let index = 0; index < 9; index++) await split(`S1 EP1 Failed Pool Show ${index}`);
    const expected = new Error('Independent connection failed'); let started = 0, active = 0, settled = 0;
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const prefilter = (sql: string) => sql.replace(/COALESCE\((?:t\.name|s\.original_name),''\) ~\* '[^']+'/g, '1=1');
    const scoped = (tx: DB): DB => ({ ...tx, dialect: 'postgres', all: (sql, values) => tx.all(prefilter(sql).replace(/ FOR UPDATE$/g, ''), values), get: (sql, values) => tx.get(sql.replace(/ FOR UPDATE$/g, ''), values) });
    const parallel: DB = { ...scoped(db), transaction: async fn => {
      const ordinal = started++; active++; if (started === 3) release();
      try {
        await barrier;
        if (ordinal === 1) throw expected;
        await new Promise<void>(resolve => setImmediate(resolve));
        return await db.transaction(tx => fn(scoped(tx)));
      } finally { active--; settled++; }
    } };
    await expect(repairImportedSeries(parallel, undefined, undefined, { concurrency: 3 })).rejects.toBe(expected);
    expect(started).toBe(3); expect(settled).toBe(3); expect(active).toBe(0);
    expect((await db.get('SELECT COUNT(*) AS n FROM episodes'))?.n).toBe(2);
  });

  it('keeps SQLite sequential even when parallel repair is requested', async () => {
    for (let index = 0; index < 4; index++) await split(`S1 EP1 Serial Show ${index}`);
    let active = 0, peak = 0;
    const sequential: DB = { ...db, transaction: async fn => {
      active++; peak = Math.max(peak, active);
      try { return await db.transaction(fn); } finally { active--; }
    } };
    expect(await repairImportedSeries(sequential, undefined, undefined, { concurrency: 6 })).toMatchObject({ seriesRepaired: 4 });
    expect(peak).toBe(1);
  });

  it('merges disjoint show families concurrently while keeping each family sequential', async () => {
    const familyById = new Map<string, string>();
    for (let index = 0; index < 7; index++) for (const titleId of await structuredFamily(`Concurrent Merge Show ${index}`, 3)) familyById.set(titleId, String(index));
    const realMerge = management.mergeTitles, active = new Set<string>(); let peak = 0, calls = 0;
    vi.spyOn(management, 'mergeTitles').mockImplementation(async (_pool, from, to, options) => {
      const family = familyById.get(from)!;
      expect(familyById.get(to)).toBe(family); expect(active.has(family)).toBe(false);
      active.add(family); peak = Math.max(peak, active.size); calls++;
      try { await new Promise<void>(resolve => setImmediate(resolve)); await realMerge(db, from, to, options); }
      finally { active.delete(family); }
    });
    expect(await repairSeriesCatalog(postgresFixtureReads(), () => { expect(active.size).toBe(0); }, { concurrency: 6 })).toMatchObject({ renamed: 0, seriesRepaired: 0, merged: 14 });
    expect(peak).toBe(6); expect(calls).toBe(14); expect(active.size).toBe(0);
    expect((await db.get('SELECT COUNT(*) AS n FROM titles'))?.n).toBe(7);
    expect((await db.get('SELECT COUNT(*) AS n FROM sources'))?.n).toBe(21);
  });

  it('stops assigning families and drains active merges before reporting a failure', async () => {
    for (let index = 0; index < 9; index++) await structuredFamily(`Failed Merge Show ${index}`, 3);
    const realMerge = management.mergeTitles, expected = new Error('Merge connection failed'); let started = 0, active = 0, settled = 0;
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(management, 'mergeTitles').mockImplementation(async (_pool, from, to, options) => {
      const ordinal = started++; active++; if (started === 3) release();
      try {
        await barrier;
        if (ordinal === 1) throw expected;
        await new Promise<void>(resolve => setImmediate(resolve));
        await realMerge(db, from, to, options);
      } finally { active--; settled++; }
    });
    await expect(repairSeriesCatalog(postgresFixtureReads(), undefined, { concurrency: 3 })).rejects.toBe(expected);
    expect(started).toBe(3); expect(settled).toBe(3); expect(active).toBe(0);
    expect((await db.get('SELECT COUNT(*) AS n FROM titles'))?.n).toBe(25);
  });

  it('retries rolled-back PostgreSQL deadlocks at most three total merge attempts', async () => {
    await structuredFamily('Retry Merge Show', 2);
    const realMerge = management.mergeTitles; let attempts = 0;
    vi.spyOn(management, 'mergeTitles').mockImplementation(async (_pool, from, to, options) => {
      if (++attempts < 3) throw Object.assign(new Error('Fixture deadlock'), { code: '40P01' });
      await realMerge(db, from, to, options);
    });
    expect(await repairSeriesCatalog(postgresFixtureReads(), undefined, { concurrency: 6 })).toMatchObject({ merged: 1 });
    expect(attempts).toBe(3);
    expect((await db.get('SELECT COUNT(*) AS n FROM sources'))?.n).toBe(2);
  });

  it('does not loop indefinitely on a persistent merge deadlock', async () => {
    await structuredFamily('Persistent Merge Show', 2);
    const expected = Object.assign(new Error('Fixture persistent deadlock'), { code: '40P01' });
    const merge = vi.spyOn(management, 'mergeTitles').mockRejectedValue(expected);
    await expect(repairSeriesCatalog(postgresFixtureReads(), undefined, { concurrency: 6 })).rejects.toBe(expected);
    expect(merge).toHaveBeenCalledTimes(3);
    expect((await db.get('SELECT COUNT(*) AS n FROM titles'))?.n).toBe(2);
  });
});
