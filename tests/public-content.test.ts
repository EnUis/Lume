import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { catalog, playbackSources, titleDetails } from '../lib/server/catalog';
import { publicCollection } from '../lib/server/collection';
import { discovery } from '../lib/server/discovery';
import { handleApi } from '../lib/server/api';
import { encrypt, hash, session } from '../lib/server/security';

let db: DB;
const now = 1_800_000_000_000;

beforeEach(async () => {
  vi.stubEnv('SOURCE_ENCRYPTION_KEY', Buffer.alloc(32, 4).toString('base64'));
  vi.stubEnv('PLAYBACK_SIGNER_URL', ''); vi.stubEnv('PLAYBACK_SIGNER_API_KEY', ''); vi.stubEnv('REQUIRE_PLAYBACK_SIGNER', 'false');
  db = await openDatabase(':memory:');
  for (const [id, type, genres, createdAt] of [
    ['movie', 'movie', ['Drama'], now - 3000],
    ['series', 'series', ['Mystery'], now - 2000],
    ['channel', 'live', ['Channels only'], now],
  ] as const) {
    await db.run('INSERT INTO titles(id,name,normalized,type,published,featured,genres,created_at,updated_at) VALUES(?,?,?,?,1,1,?,?,?)', [id, id === 'channel' ? 'Breaking News Channel' : `A ${id}`, id === 'channel' ? 'breaking news channel' : `a ${id}`, type, JSON.stringify(genres), createdAt, now]);
  }
  await db.run("INSERT INTO seasons(id,title_id,number) VALUES('season','series',1)");
  await db.run("INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES('episode','series','season',1,1,'Pilot')");
  for (const titleId of ['movie', 'series', 'channel']) {
    const url = `https://example.invalid/${titleId}.mp4`;
    await db.run("INSERT INTO sources(id,title_id,episode_id,entry_key,name,url_encrypted,url_hash,format,health,last_success,created_at) VALUES(?,?,?,?,?,?,?,'mp4','healthy',?,?)", [`${titleId}-source`, titleId, titleId === 'series' ? 'episode' : null, titleId, 'Verified fixture', encrypt(url), hash(url), now, now]);
  }
  await db.run("INSERT INTO title_redirects(alias_id,title_id,created_at) VALUES('old-channel','channel',?)", [now]);
  await db.run("INSERT INTO users(id,email,name,password_hash,created_at) VALUES('viewer','viewer@test.invalid','Fixture viewer','unused',?)", [now]);
  for (const titleId of ['movie', 'series', 'channel']) {
    await db.run('INSERT INTO watch_history(id,user_id,title_id,episode_id,position,duration,updated_at) VALUES(?,?,?,?,60,1000,?)', [`${titleId}-view`, 'viewer', titleId, titleId === 'series' ? 'episode' : null, now - 100]);
  }
});
afterEach(async () => { await db.close(); vi.unstubAllEnvs(); });

function apiRequest(path: string, method = 'GET', body?: unknown, cookie?: string) {
  const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
  return new Request(`${origin}/api/${path}`, { method, headers: { ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

describe('separate live TV access and movie/series discovery', () => {
  it('cleans imported display labels consistently without losing season and episode information', async () => {
    const original = 'مدرسة النخبة S01 مدرسة النخبة';
    await db.run('UPDATE titles SET name=? WHERE id=?', [original, 'series']);
    await db.run('UPDATE titles SET name=? WHERE id=?', ['FOX Sports 2 | MX ❆', 'channel']);
    const expected = 'مدرسة النخبة';
    expect((await catalog(db, new URLSearchParams({ type: 'series' }))).titles[0]?.name).toBe(expected);
    expect((await discovery(db)).featured.find(title => title.id === 'series')?.name).toBe(expected);
    expect((await publicCollection(db, ['series']))[0]?.name).toBe(expected);
    const detail = await titleDetails(db, 'series');
    expect(detail?.name).toBe(expected);
    expect(detail?.episodes?.[0]).toMatchObject({ season: 1, number: 1, name: 'Pilot' });
    expect((await titleDetails(db, 'channel'))?.name).toBe('FOX Sports 2');
    expect((await db.get('SELECT name FROM titles WHERE id=?', ['series']))?.name).toBe(original);
  });

  it('filters channels before counting and paginating browse/search, including their genres', async () => {
    const first = await catalog(db, new URLSearchParams({ limit: '1' }));
    expect(first.total).toBe(2);
    expect(first.titles.map(title => title!.id)).toEqual(['series']);
    expect(first.genres).toEqual(['Drama', 'Mystery']);
    expect((await catalog(db, new URLSearchParams({ page: '2', limit: '1' }))).titles.map(title => title!.id)).toEqual(['movie']);
    for (const params of [{ q: 'Breaking News' }, { genre: 'Channels only' }] as Record<string, string>[]) {
      const result = await catalog(db, new URLSearchParams(params));
      expect(result.total).toBe(0); expect(result.titles).toEqual([]);
    }
    const live = await catalog(db, new URLSearchParams({ type: 'live', q: 'Breaking News', genre: 'Channels only' }));
    expect(live.total).toBe(1); expect(live.titles.map(title => title!.id)).toEqual(['channel']);
    expect(live.genres).toEqual(['Channels only']);
    expect((await catalog(db, new URLSearchParams({ type: 'movie' }))).genres).toEqual(['Drama']);
  });

  it('excludes featured and previously watched channels from every discovery feed', async () => {
    const feeds = await discovery(db, now);
    for (const feed of [feeds.featured, feeds.trending, feeds.recent, feeds.popularMovies, feeds.popularSeries]) expect(feed.every(title => title.type === 'movie' || title.type === 'series')).toBe(true);
    expect(feeds.featured.map(title => title.id)).toEqual(['series', 'movie']);
    expect(feeds.trending.map(title => title.id).sort()).toEqual(['movie', 'series']);
    expect(feeds.popularMovies.map(title => title.id)).toEqual(['movie']);
    expect(feeds.popularSeries.map(title => title.id)).toEqual(['series']);
  });

  it('loads explicitly saved live IDs and redirects without duplicating channels', async () => {
    const titles = await publicCollection(db, ['channel', 'movie', 'old-channel', 'series']);
    expect(titles.map(title => title.id)).toEqual(['channel', 'movie', 'series']);
  });

  it('allows verified live details and old channel links without exposing private source URLs', async () => {
    expect(await titleDetails(db, 'channel')).toMatchObject({ id: 'channel', type: 'live', sources: [{ id: 'channel-source' }] });
    expect(await titleDetails(db, 'old-channel')).toMatchObject({ id: 'channel', type: 'live' });
    expect((await titleDetails(db, 'channel'))!.sources![0].url).toBeUndefined();
    expect(await titleDetails(db, 'channel', true)).toMatchObject({ id: 'channel', type: 'live', sources: [{ id: 'channel-source' }] });
    const admin = await catalog(db, new URLSearchParams({ type: 'live', availability: 'available' }), true);
    expect(admin.total).toBe(1); expect(admin.titles[0]?.id).toBe('channel');
    expect((await db.get("SELECT COUNT(*) AS count FROM sources WHERE title_id='channel'"))?.count).toBe(1);
  });

  it('provides verified live playback while rejecting episode IDs on continuous channels', async () => {
    expect(await playbackSources(db, 'channel')).toMatchObject([{ id: 'channel-source', url: 'https://example.invalid/channel.mp4' }]);
    expect(await playbackSources(db, 'old-channel')).toMatchObject([{ id: 'channel-source' }]);
    expect(await playbackSources(db, 'channel', 'episode')).toEqual([]);
    expect(await playbackSources(db, 'movie')).toMatchObject([{ id: 'movie-source', url: 'https://example.invalid/movie.mp4' }]);
    expect(await playbackSources(db, 'series', 'episode')).toMatchObject([{ id: 'series-source', episodeId: 'episode' }]);
  });

  it('retains saved/favorite channels but excludes live timestamps from history and resume', async () => {
    const cookie = (await session(db, 'viewer')).split(';')[0];
    for (const titleId of ['movie', 'series', 'channel']) {
      for (const table of ['watchlist', 'favorites']) await db.run(`INSERT INTO ${table}(user_id,title_id,created_at) VALUES('viewer',?,?)`, [titleId, now]);
      await db.run("INSERT INTO playback_progress(user_id,title_id,episode_id,item_key,position,duration,updated_at) VALUES('viewer',?,?,?,60,1000,?)", [titleId, titleId === 'series' ? 'episode' : null, titleId === 'series' ? 'episode' : titleId, now]);
    }
    // Personal metadata retains unavailable saved movies and live bookmarks.
    await db.run("UPDATE titles SET published=0 WHERE id='movie'");
    const library = await (await handleApi(apiRequest('library', 'GET', undefined, cookie), db)).json();
    expect(library.titles.map((title: { id: string }) => title.id)).toEqual(['movie', 'series', 'channel']);
    expect(library.titles[0].available).toBe(false);
    for (const path of ['list', 'favorites']) {
      const data = await (await handleApi(apiRequest(path, 'GET', undefined, cookie), db)).json();
      expect(data.ids.sort()).toEqual(['channel', 'movie', 'series']);
      expect((await handleApi(apiRequest(path, 'POST', { titleId: 'old-channel' }, cookie), db)).status).toBe(200);
    }
    for (const path of ['history', 'progress']) {
      const data = await (await handleApi(apiRequest(path, 'GET', undefined, cookie), db)).json();
      expect(data[path].map((item: { titleId: string }) => item.titleId).sort()).toEqual(['movie', 'series']);
    }
    expect((await handleApi(apiRequest('progress', 'POST', { titleId: 'channel', position: 70, duration: 1000 }, cookie), db)).status).toBe(404);
    for (const table of ['watchlist', 'favorites', 'playback_progress', 'watch_history']) expect((await db.get(`SELECT COUNT(*) AS count FROM ${table} WHERE title_id='channel'`))?.count).toBe(1);
    await db.run("DELETE FROM watchlist WHERE title_id='channel'"); await db.run("DELETE FROM favorites WHERE title_id='channel'");
    const afterRemovingBookmarks = await (await handleApi(apiRequest('library', 'GET', undefined, cookie), db)).json();
    expect(afterRemovingBookmarks.titles.map((title: { id: string }) => title.id)).toEqual(['movie', 'series']);
  });

  it('migrates an old split-title timestamp through its original episode alias', async () => {
    await db.run("INSERT INTO title_redirects(alias_id,title_id,created_at) VALUES('old-pilot','series',?)", [now]);
    await db.run("INSERT INTO episode_redirects(alias_id,episode_id,created_at) VALUES('old-pilot','episode',?)", [now]);
    const cookie = (await session(db, 'viewer')).split(';')[0];
    const result = await handleApi(apiRequest('progress/migrate', 'POST', { progress: [{ titleId: 'old-pilot', episodeId: null, position: 42, duration: 1000, updatedAt: Date.now() - 1000 }] }, cookie), db);
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ migrated: 1 });
    expect(await db.get("SELECT title_id,episode_id,item_key,position FROM playback_progress WHERE user_id='viewer'")).toMatchObject({ title_id: 'series', episode_id: 'episode', item_key: 'episode', position: 42 });
    // The episode alias is never accepted for an unrelated title.
    expect((await handleApi(apiRequest('progress', 'POST', { titleId: 'movie', episodeId: 'old-pilot', position: 42, duration: 1000 }, cookie), db)).status).toBe(400);
  });

  it('authorizes live attempts with viewer/URL binding and keeps browser failure blocks sticky', async () => {
    const cookie = (await session(db, 'viewer')).split(';')[0];
    const granted = await (await handleApi(apiRequest('playback/old-channel', 'GET', undefined, cookie), db)).json();
    const playbackAttemptToken = granted.sources[0].playbackAttemptToken;
    expect(typeof playbackAttemptToken).toBe('string');
    const report = { sourceId: 'channel-source', playbackAttemptToken };
    expect((await handleApi(apiRequest('playback/failure', 'POST', report), db)).status).toBe(403);
    expect((await handleApi(apiRequest('playback/failure', 'POST', report, cookie), db)).status).toBe(200);
    expect((await catalog(db, new URLSearchParams({ type: 'live' }))).total).toBe(0);
    expect(await titleDetails(db, 'channel')).toBeNull(); expect(await publicCollection(db, ['old-channel'])).toEqual([]);
    expect((await (await handleApi(apiRequest('playback/channel', 'GET', undefined, cookie), db)).json()).sources).toEqual([]);
    expect((await handleApi(apiRequest('playback/success', 'POST', report, cookie), db)).status).toBe(409);
    const retry = await handleApi(apiRequest('playback/attempt', 'POST', report, cookie), db);
    expect(retry.status).toBe(200); const fresh = (await retry.json()).source;
    expect(fresh).toMatchObject({ id: 'channel-source', playbackRetry: true, playbackBlocked: true, health: 'unavailable' });
    expect((await handleApi(apiRequest('playback/success', 'POST', { sourceId: fresh.id, playbackAttemptToken: fresh.playbackAttemptToken }, cookie), db)).status).toBe(200);
    expect((await catalog(db, new URLSearchParams({ type: 'live' }))).total).toBe(1);
    await db.run("UPDATE sources SET url_hash='changed-live-url' WHERE id='channel-source'");
    expect((await handleApi(apiRequest('playback/attempt', 'POST', report, cookie), db)).status).toBe(409);
    await db.run("UPDATE titles SET published=0 WHERE id='channel'");
    expect((await handleApi(apiRequest('playback/attempt', 'POST', { sourceId: 'channel-source' }, cookie), db)).status).toBe(404);
  });

  it.each([
    ["UPDATE sources SET health='unknown' WHERE id='channel-source'"],
    ["UPDATE sources SET health='degraded' WHERE id='channel-source'"],
    ["UPDATE sources SET health='unavailable' WHERE id='channel-source'"],
    ["UPDATE sources SET playback_blocked=1 WHERE id='channel-source'"],
    ["UPDATE sources SET enabled=0 WHERE id='channel-source'"],
    ["UPDATE sources SET removed=1 WHERE id='channel-source'"],
    ["UPDATE sources SET episode_id='episode' WHERE id='channel-source'"],
    ["UPDATE titles SET published=0 WHERE id='channel'"],
  ])('applies the same strict live visibility gate after %s', async sql => {
    await db.run(sql);
    expect((await catalog(db, new URLSearchParams({ type: 'live' }))).total).toBe(0);
    expect(await titleDetails(db, 'channel')).toBeNull();
    expect(await publicCollection(db, ['channel'])).toEqual([]);
    expect(await playbackSources(db, 'channel')).toEqual([]);
  });

  it('keeps an alternate channel source visible and hides disabled playlists', async () => {
    await db.run("INSERT INTO playlists(id,name,enabled,created_at) VALUES('channels','Channels',1,?)", [now]);
    await db.run("UPDATE sources SET playlist_id='channels',playback_blocked=1 WHERE id='channel-source'");
    const url = 'https://example.invalid/alternate.m3u8';
    await db.run("INSERT INTO sources(id,title_id,playlist_id,entry_key,name,url_encrypted,url_hash,format,health,created_at) VALUES('alternate','channel','channels','alternate','Alternate',?,?,'hls','healthy',?)", [encrypt(url), hash(url), now]);
    expect((await catalog(db, new URLSearchParams({ type: 'live' }))).total).toBe(1);
    expect((await playbackSources(db, 'channel')).map(source => source.id)).toEqual(['alternate']);
    await db.run("UPDATE playlists SET enabled=0 WHERE id='channels'");
    expect((await catalog(db, new URLSearchParams({ type: 'live' }))).total).toBe(0);
    expect(await titleDetails(db, 'channel')).toBeNull(); expect(await playbackSources(db, 'channel')).toEqual([]);
  });
});
