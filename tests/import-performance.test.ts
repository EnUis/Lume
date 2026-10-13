import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB, type Row } from '../lib/server/db';
import { ImportIdentityIndex, createTitle, synchronizePlaylist } from '../lib/server/pipeline';
import { parseM3U, M3U_IMPORT_VERSION } from '../lib/server/m3u';
import { encrypt, hash, id } from '../lib/server/security';
import { leaseJob } from '../lib/server/jobs';
import { importPlaybackBlocks, lockImportUrls } from '../lib/server/import-batches';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
const section = (name: string, path: string, attributes = '') => `#EXTINF:-1 ${attributes},${name}\nhttps://provider.example/${path}\n`;
async function playlist(content: string) {
  const playlistId = id();
  await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,?)', [playlistId, 'Large import fixture', encrypt(content), Date.now()]);
  return playlistId;
}
async function setContent(playlistId: string, content: string) { await db.run('UPDATE playlists SET content_encrypted=? WHERE id=?', [encrypt(content), playlistId]); }
async function oldSnapshot(playlistId: string, content: string) {
  await db.run('INSERT INTO playlist_versions(id,playlist_id,content_encrypted,content_hash,report,created_at) VALUES(?,?,?,?,?,?)', [id(), playlistId, encrypt(content), hash(content), '{}', Date.now()]);
}
async function oldSource(playlistId: string, name: string, path: string, locked = false) {
  const titleId = await createTitle(db, { name, published: false }); const sourceId = id();
  await db.run('INSERT INTO sources(id,title_id,playlist_id,entry_key,name,url_encrypted,url_hash,health,last_success,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [sourceId, titleId, playlistId, `old:${sourceId}`, 'Provider', encrypt(`https://provider.example/${path}`), hash(`https://provider.example/${path}`), 'healthy', Date.now(), Date.now()]);
  await db.run('INSERT INTO review_queue(id,source_id,title_id,reason,created_at) VALUES(?,?,?,?,?)', [id(), sourceId, titleId, 'Content classification requires administrator review', Date.now()]);
  if (locked) await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,?)', [titleId, Date.now()]);
  return { titleId, sourceId };
}

describe('provider classification from display names and strong path hints', () => {
  it('classifies multilingual groups and extracts actual spaced/separated episode names', () => {
    const content = '#EXTM3U\n' + section('(TR) Film adı', 'movie/account/credential/100.mp4', 'group-title="SİNEMA"') + section('(TR) Almila Ada ile Bale Fitness S1 E2', 'series/account/credential/200.mp4') + section('A Show S02-E03 — Arrival', 'series/account/credential/201.mp4') + section('Canal', 'live/account/credential/300.m3u8') + section('1917', 'movie/account/credential/400.mp4');
    const result = parseM3U(content); expect(result.errors).toEqual([]);
    expect(result.entries[0]).toMatchObject({ type: 'movie', year: null, ambiguous: false });
    expect(result.entries[1]).toMatchObject({ title: 'Almila Ada ile Bale Fitness', name: '(TR) Almila Ada ile Bale Fitness S1 E2', language: 'tr', type: 'series', season: 1, episode: 2, ambiguous: false });
    expect(result.entries[2]).toMatchObject({ title: 'A Show', season: 2, episode: 3, episodeName: '— Arrival' });
    expect(result.entries[3]).toMatchObject({ type: 'live', ambiguous: false });
    expect(result.entries[4]).toMatchObject({ title: '1917', year: null });
  });
  it('honors explicit content type and never guesses episodes from attributes or URL digits', () => {
    const result = parseM3U('#EXTM3U\n' + section('A Film S1 E1', 'series/account/secret/100.mp4', 'type="movie"') + section('Canal', 'movie/account/secret/101.mp4', 'content-type="live"') + section('Unmarked show', 'series/account/secret/S01E04.mp4', 'tvg-id="S01E04"') + section('(TR) Artık Ben Bir Vampirim S1 E11080', 'series/account/secret/104.mp4'));
    expect(result.entries[0]).toMatchObject({ title: 'A Film S1 E1', type: 'movie', season: null, episode: null });
    expect(result.entries[1].type).toBe('live');
    for (const entry of result.entries.slice(2)) expect(entry).toMatchObject({ type: 'series', season: null, episode: null, ambiguous: true });
  });
});

describe('bounded identity work', () => {
  it('does no fuzzy work for 12,000 missing-year identities and caps saturated known-year windows', () => {
    const rows = Array.from({ length: 12000 }, (_, n) => ({ id: `row-${n}`, name: `abc ${String(n).padStart(5, '0')}`, normalized: `abc ${String(n).padStart(5, '0')}`, type: 'movie', year: null, published: 1 }));
    const index = new ImportIdentityIndex(rows);
    const base = parseM3U('#EXTM3U\n' + section('Missing year', 'movie/a.mp4')).entries[0];
    let unexpectedMatches = 0;
    for (let n = 0; n < 12000; n++) if (index.possible({ ...base, normalized: `abc missing ${n}` })) unexpectedMatches++;
    expect(unexpectedMatches).toBe(0);
    expect(index.comparisons).toBe(0);
    for (const row of rows) index.add({ ...row, id: `known-${row.id}`, year: 2020 });
    const candidate = index.possible({ ...base, normalized: 'abc zzzzz', year: 2020 });
    expect(candidate).toBeDefined(); expect(index.comparisons).toBeLessThanOrEqual(128);
    expect(index.strong({ ...base, type: 'series', year: null, season: null, episode: null })).toBeUndefined();
  });
});

describe('durable batched imports', () => {
  it('batches source and job writes and skips catalog work for unchanged snapshots', async () => {
    const count = 1000, batchSize = 100;
    const content = '#EXTM3U\n' + Array.from({ length: count }, (_, n) => section(`Unique fixture ${n}`, `movie/${n}.mp4`)).join('');
    const playlistId = await playlist(content), queries: string[] = [];
    const trace = (delegate: DB): DB => ({ ...delegate,
      all: async <T extends Row>(sql: string, values: unknown[] = []) => { queries.push(sql); return delegate.all<T>(sql, values); },
      get: async <T extends Row>(sql: string, values: unknown[] = []) => { queries.push(sql); return delegate.get<T>(sql, values); },
      run: async (sql, values) => { queries.push(sql); return delegate.run(sql, values); },
      transaction: fn => delegate.transaction(tx => fn(trace(tx))),
    });
    const traced = trace(db);
    expect(await synchronizePlaylist(traced, playlistId, undefined, undefined, { batchSize })).toMatchObject({ added: count, batches: 10 });
    expect(queries.filter(sql => sql.startsWith('INSERT INTO sources('))).toHaveLength(10);
    expect(queries.filter(sql => sql.startsWith('INSERT INTO jobs('))).toHaveLength(10);
    expect(queries.filter(sql => sql.startsWith('WITH requested(url_hash)'))).toHaveLength(10);
    expect(queries.length).toBeLessThan(1100);
    expect((await db.get("SELECT COUNT(*) n FROM jobs WHERE type='health'"))?.n).toBe(count);
    expect((await db.get("SELECT COUNT(*) n FROM sources WHERE health='unknown' AND last_checked IS NULL AND playback_blocked=0"))?.n).toBe(count);
    queries.length = 0;
    expect(await synchronizePlaylist(traced, playlistId)).toMatchObject({ unchanged: count, contentChanged: false, batches: 0 });
    expect(queries).toHaveLength(4);
    expect(queries.some(sql => /FROM (sources|titles)|INSERT INTO/.test(sql))).toBe(false);
  }, 20000);

  it('acquires PostgreSQL URL locks in one ordered query using the playback-report lock keys', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const postgres = { ...db, dialect: 'postgres' as const, run: async (sql: string, values?: unknown[]) => { calls.push({ sql, values }); } };
    const a = '0000000180000002' + '0'.repeat(48), b = 'ffffffff00000003' + '0'.repeat(48);
    await lockImportUrls(postgres, [b, a, b]);
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([1, -2147483646, -1, 3]);
    expect(calls[0].sql).toContain('ORDER BY position OFFSET 0');
    await lockImportUrls(postgres, []); expect(calls).toHaveLength(1);
  });

  it('loads only the latest blocked reference per URL through the index in a single batch', async () => {
    const playlistId = await playlist('#EXTM3U\n' + section('Shared film', 'movie/shared.mp4'));
    await synchronizePlaylist(db, playlistId);
    const source = (await db.get('SELECT id,title_id,url_hash,url_encrypted FROM sources LIMIT 1'))!;
    await db.run("UPDATE sources SET playback_blocked=1,playback_blocked_at=20,error='Latest browser failure',failures=4 WHERE id=?", [source.id]);
    await db.run("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000) INSERT INTO sources(id,title_id,entry_key,name,url_encrypted,url_hash,playback_blocked,playback_blocked_at,error,created_at) SELECT 'copy-'||n,?,'copy-'||n,'Other reference',?,?,1,10,'Older failure',0 FROM seq", [source.title_id, source.url_encrypted, source.url_hash]);
    const calls: Array<{ sql: string; values: unknown[]; rows: number }> = [];
    const traced: DB = { ...db, all: async <T extends Row>(sql: string, values: unknown[] = []) => { const rows = await db.all<T>(sql, values); calls.push({ sql, values, rows: rows.length }); return rows; } };
    const blocks = await importPlaybackBlocks(traced, [source.url_hash, source.url_hash, hash('another URL')]);
    expect(calls).toHaveLength(1); expect(calls[0].rows).toBe(1);
    expect(blocks.get(source.url_hash)).toMatchObject({ playback_blocked_at: 20, error: 'Latest browser failure', failures: 4 });
    const plan = (await db.all('EXPLAIN QUERY PLAN ' + calls[0].sql, calls[0].values)).map(row => row.detail).join(' ');
    expect(plan).toContain('sources_url_playback_reference'); expect(plan).not.toMatch(/SCAN candidate|TEMP B-TREE/i);
  });

  it('uses bounded encrypted configuration fingerprints for large uploaded content across batches, cache hits and failures', async () => {
    const content = '#EXTM3U\n#' + 'padding'.repeat(300000) + '\n' + Array.from({ length: 4 }, (_, n) => section(`Bounded Film ${n}`, `movie/${n}.mp4`)).join('');
    const playlistId = await playlist(content); let initialReads = 0;
    const guards: { sql: string; values: unknown[]; returned: unknown[] }[] = [];
    const trace = (delegate: DB): DB => ({
      ...delegate,
      get: async <T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T | undefined> => {
        if (sql.startsWith('SELECT * FROM playlists WHERE id=')) initialReads++;
        const result = await delegate.get<T>(sql, values);
        if (sql.includes('OCTET_LENGTH(content_encrypted)')) guards.push({ sql, values, returned: Object.values(result || {}) });
        return result;
      },
      transaction: fn => delegate.transaction(tx => fn(trace(tx))),
    });
    const traced = trace(db);
    expect(await synchronizePlaylist(traced, playlistId, undefined, undefined, { batchSize: 1 })).toMatchObject({ added: 4, batches: 4 });
    expect(await synchronizePlaylist(traced, playlistId)).toMatchObject({ unchanged: 4, contentChanged: false });
    await setContent(playlistId, '<html>' + 'padding'.repeat(300000) + '</html>');
    await expect(synchronizePlaylist(traced, playlistId)).rejects.toThrow('Playlist must begin');
    expect(initialReads).toBe(3); expect(guards.length).toBeGreaterThanOrEqual(10);
    for (const guard of guards) {
      expect(guard.sql).toContain('SUBSTR(content_encrypted,1,64)');
      expect(guard.values.filter(value => typeof value === 'string').every(value => value.length <= 300)).toBe(true);
      expect(guard.returned.filter(value => typeof value === 'string').every(value => value.length <= 64)).toBe(true);
    }
    expect(guards.some(guard => guard.sql.includes("health='unavailable'"))).toBe(true);
  });

  it('releases database work and timers between commits while importing thousands of sources', async () => {
    const count = 2000; const content = '#EXTM3U\n' + Array.from({ length: count }, (_, n) => section(`Film ${n}`, `movie/account/key/${n}.mp4`)).join('');
    const playlistId = await playlist(content); let timerFired = false; let inspected = 0;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const result = await synchronizePlaylist(db, playlistId, undefined, undefined, { batchSize: 75, onBatch: async progress => {
      inspected++;
      expect((await db.get('SELECT COUNT(*) AS n FROM sources WHERE playlist_id=?', [playlistId]))?.n).toBe(progress.processed);
      if (progress.batches === 1) {
        const job = await leaseJob(db, 'health-consumer', ['health']); expect(job?.type).toBe('health');
        expect((await db.get('SELECT COUNT(*) AS n FROM playlist_versions WHERE playlist_id=?', [playlistId]))?.n).toBe(0);
      }
    } }); clearTimeout(timer);
    expect(timerFired).toBe(true); expect(inspected).toBe(Math.ceil(count / 75));
    expect(result).toMatchObject({ added: count, processed: count, batches: inspected, identityComparisons: 0, importVersion: M3U_IMPORT_VERSION });
    expect((await db.get('SELECT COUNT(*) AS n FROM titles WHERE published=1'))?.n).toBe(count);
    expect((await db.get('SELECT COUNT(*) AS n FROM sources WHERE health=\'unknown\''))?.n).toBe(count);
  }, 20000);

  it('preserves the last snapshot and removals on interruption and retries without duplicate sources or jobs', async () => {
    const initial = '#EXTM3U\n' + section('Old Film (2020)', 'movie/old.mp4'); const playlistId = await playlist(initial); await synchronizePlaylist(db, playlistId);
    const old = (await db.get('SELECT id FROM sources WHERE playlist_id=?', [playlistId]))!;
    const next = '#EXTM3U\n' + Array.from({ length: 7 }, (_, n) => section(`New Film ${n}`, `movie/new${n}.mp4`)).join(''); await setContent(playlistId, next);
    await expect(synchronizePlaylist(db, playlistId, undefined, undefined, { batchSize: 2, onBatch: () => { throw new Error('Simulated worker interruption'); } })).rejects.toThrow('Simulated worker interruption');
    expect((await db.get('SELECT removed FROM sources WHERE id=?', [old.id]))?.removed).toBe(0);
    expect((await db.get('SELECT COUNT(*) AS n FROM playlist_versions WHERE playlist_id=?', [playlistId]))?.n).toBe(1);
    const committed = await db.all('SELECT id,entry_key FROM sources WHERE playlist_id=? AND id<>?', [playlistId, old.id]); expect(committed).toHaveLength(2);
    const result = await synchronizePlaylist(db, playlistId, undefined, undefined, { batchSize: 2 }); expect(result).toMatchObject({ added: 5, unchanged: 2, removed: 1 });
    for (const row of committed) expect((await db.get('SELECT id FROM sources WHERE playlist_id=? AND entry_key=?', [playlistId, row.entry_key]))?.id).toBe(row.id);
    expect((await db.get('SELECT COUNT(*) AS n FROM sources WHERE playlist_id=?', [playlistId]))?.n).toBe(8);
    expect((await db.get('SELECT COUNT(*) AS n FROM jobs'))?.n).toBe(8);
    expect((await db.get('SELECT COUNT(*) AS n FROM playlist_versions WHERE playlist_id=?', [playlistId]))?.n).toBe(2);
  });

  it('validates the entire response before writing and suppresses removals for a partially malformed playlist', async () => {
    const playlistId = await playlist('#EXTM3U\n' + section('Existing Film (2020)', 'movie/existing.mp4')); await synchronizePlaylist(db, playlistId);
    await setContent(playlistId, '<html>Expired subscription</html>');
    await expect(synchronizePlaylist(db, playlistId)).rejects.toThrow('Playlist must begin');
    expect((await db.get('SELECT COUNT(*) AS n FROM sources'))?.n).toBe(1);
    await setContent(playlistId, '#EXTM3U\n' + section('New Film (2021)', 'movie/new.mp4') + '#EXTINF:-1,Broken\ninvalid-stream');
    expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ added: 1, removed: 0, removalsSuppressed: true });
    expect((await db.get('SELECT COUNT(*) AS n FROM sources WHERE removed=0'))?.n).toBe(2);
  });

  it('reconciles partial batches when the provider reverts to the previous completed snapshot', async () => {
    const initial = '#EXTM3U\n' + section('Original Film (2020)', 'movie/original.mp4'); const playlistId = await playlist(initial); await synchronizePlaylist(db, playlistId);
    await setContent(playlistId, initial + section('Temporary addition (2021)', 'movie/temporary.mp4'));
    await expect(synchronizePlaylist(db, playlistId, undefined, undefined, { batchSize: 2, onBatch: () => { throw new Error('Interrupted before snapshot activation'); } })).rejects.toThrow('Interrupted');
    expect((await db.get('SELECT COUNT(*) AS n FROM sources WHERE removed=0'))?.n).toBe(2);
    await setContent(playlistId, initial);
    expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ contentChanged: true, unchanged: 1, removed: 1 });
    expect((await db.get('SELECT COUNT(*) AS n FROM sources WHERE removed=0'))?.n).toBe(1);
  });
});

describe('old-parser repair and manual preservation', () => {
  it('reprocesses matching snapshot bytes and preserves source ID, title ID, measured health and saved progress', async () => {
    const content = '#EXTM3U\n' + section('A Show S1-E1', 'series/account/key/1.mp4'); const playlistId = await playlist(content); const old = await oldSource(playlistId, 'A Show S1-E1', 'series/account/key/1.mp4'); await oldSnapshot(playlistId, content);
    const userId = id(); await db.run('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)', [userId, 'viewer@example.test', 'Viewer', 'not-used', Date.now()]);
    await db.run('INSERT INTO playback_progress(user_id,title_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [userId, old.titleId, old.titleId, 123, 600, Date.now()]);
    await db.run('INSERT INTO watch_history(id,user_id,title_id,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [id(), userId, old.titleId, 123, 600, Date.now()]);
    await db.run('INSERT INTO watchlist(user_id,title_id,created_at) VALUES(?,?,?)', [userId, old.titleId, Date.now()]);
    const result = await synchronizePlaylist(db, playlistId); expect(result).toMatchObject({ added: 0, repaired: 1, contentChanged: true });
    const source = (await db.get('SELECT * FROM sources WHERE id=?', [old.sourceId]))!;
    expect(source).toMatchObject({ id: old.sourceId, title_id: old.titleId, health: 'healthy', removed: 0 }); expect(source.episode_id).toBeTruthy();
    expect(await db.get('SELECT type,name,published FROM titles WHERE id=?', [old.titleId])).toMatchObject({ type: 'series', name: 'A Show', published: 1 });
    expect(await db.get('SELECT title_id,episode_id,item_key,position FROM playback_progress WHERE user_id=?', [userId])).toMatchObject({ title_id: old.titleId, episode_id: source.episode_id, item_key: source.episode_id, position: 123 });
    expect((await db.get('SELECT episode_id FROM watch_history WHERE user_id=?', [userId]))?.episode_id).toBe(source.episode_id);
    expect((await db.get('SELECT title_id FROM watchlist WHERE user_id=?', [userId]))?.title_id).toBe(old.titleId);
    expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ contentChanged: false, unchanged: 1 });
  });

  it('publishes only machine classification reviews and preserves administrator-hidden titles and metadata', async () => {
    const content = '#EXTM3U\n' + section('Unlocked', 'movie/a.mp4') + section('Locked', 'movie/b.mp4'); const playlistId = await playlist(content);
    const unlocked = await oldSource(playlistId, 'Unlocked', 'movie/a.mp4'); const locked = await oldSource(playlistId, 'Locked', 'movie/b.mp4', true); await oldSnapshot(playlistId, content);
    await db.run('UPDATE titles SET synopsis=?,poster=? WHERE id=?', ['Administrator description', '/images/custom.webp', locked.titleId]);
    expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ repaired: 1, added: 0 });
    expect((await db.get('SELECT published FROM titles WHERE id=?', [unlocked.titleId]))?.published).toBe(1);
    expect(await db.get('SELECT published,synopsis,poster FROM titles WHERE id=?', [locked.titleId])).toMatchObject({ published: 0, synopsis: 'Administrator description', poster: '/images/custom.webp' });
    expect((await db.get('SELECT COUNT(*) AS n FROM sources'))?.n).toBe(2);
  });
});
