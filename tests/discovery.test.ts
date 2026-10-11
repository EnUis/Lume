import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { discovery } from '../lib/server/discovery';
import { createTitle } from '../lib/server/pipeline';
import { id } from '../lib/server/security';

const now = 1_800_000_000_000;
let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });

async function title(name: string, options: { type?: 'movie' | 'series'; published?: boolean; featured?: boolean; createdAt?: number } = {}) {
  const titleId = await createTitle(db, { name, type: options.type, year: 2026, published: options.published });
  await db.run('UPDATE titles SET featured=?,created_at=? WHERE id=?', [options.featured ? 1 : 0, options.createdAt ?? now, titleId]);
  return titleId;
}
async function source(titleId: string, options: { health?: string; lastSuccess?: number | null; enabled?: boolean; removed?: boolean; playlistId?: string; episodeId?: string } = {}) {
  await db.run('INSERT INTO sources(id,title_id,episode_id,playlist_id,entry_key,name,url_encrypted,url_hash,format,health,last_success,enabled,removed,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id(), titleId, options.episodeId ?? null, options.playlistId ?? null, id(), 'Test source', 'fixture', 'fixture-hash', 'mp4', options.health ?? 'healthy', options.lastSuccess === undefined ? now - 1000 : options.lastSuccess, options.enabled === false ? 0 : 1, options.removed ? 1 : 0, now]);
}
async function user() {
  const userId = id();
  await db.run('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)', [userId, `${userId}@example.test`, 'Test viewer', 'fixture', now]);
  return userId;
}
async function watched(titleId: string, userId: string, updatedAt = now - 1000, position = 60, episodeId?: string) {
  await db.run('INSERT INTO watch_history(id,user_id,title_id,episode_id,position,duration,updated_at) VALUES(?,?,?,?,?,?,?)', [id(), userId, titleId, episodeId ?? null, position, 1000, updatedAt]);
}
async function episode(titleId: string, number: number) {
  let season = await db.get('SELECT id FROM seasons WHERE title_id=? AND number=1', [titleId]);
  if (!season) { const seasonId = id(); await db.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,1)', [seasonId, titleId]); season = { id: seasonId }; }
  const episodeId = id();
  await db.run('INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES(?,?,?,1,?,?)', [episodeId, titleId, season.id, number, `Episode ${number}`]);
  return episodeId;
}

describe('database-backed public discovery feeds', () => {
  it('uses editorial flags and creation time without fabricating trending or popularity', async () => {
    const old = await title('Featured older movie', { featured: true, createdAt: now - 5000 });
    const recent = await title('Newer movie', { createdAt: now - 1000 });
    await source(old); await source(recent);
    const feeds = await discovery(db, now);
    expect(feeds.featured.map(entry => entry.id)).toEqual([old]);
    expect(feeds.recent.map(entry => entry.id)).toEqual([recent, old]);
    expect(feeds.trending).toEqual([]);
    expect(feeds.popularMovies).toEqual([]);
    expect(feeds.popularSeries).toEqual([]);
  });

  it('excludes unverified, broken, disabled, removed, unpublished, and disabled-playlist titles', async () => {
    const healthy = await title('Healthy'); await source(healthy);
    const degraded = await title('Previously verified degraded'); await source(degraded, { health: 'degraded' });
    for (const [name, settings] of [
      ['Unknown', { health: 'unknown' }], ['Unavailable', { health: 'unavailable' }],
      ['Unverified degraded', { health: 'degraded', lastSuccess: null }], ['Disabled', { enabled: false }], ['Removed', { removed: true }],
    ] as const) { const entry = await title(name, { featured: true }); await source(entry, settings); }
    const unpublished = await title('Unpublished', { published: false, featured: true }); await source(unpublished);
    const playlistId = id();
    await db.run('INSERT INTO playlists(id,name,enabled,created_at) VALUES(?,?,0,?)', [playlistId, 'Disabled playlist', now]);
    const disabledPlaylist = await title('From disabled playlist', { featured: true }); await source(disabledPlaylist, { playlistId });
    const viewer = await user();
    for (const row of await db.all('SELECT id FROM titles')) await watched(row.id, viewer);
    const feeds = await discovery(db, now);
    for (const feed of [feeds.recent, feeds.trending, feeds.popularMovies]) expect(new Set(feed.map(entry => entry.id))).toEqual(new Set([healthy]));
    expect(feeds.featured).toEqual([]);
  });

  it('ranks distinct registered viewers rather than repeated viewing records', async () => {
    const repeated = await title('Repeated by one viewer'); const broader = await title('Watched by two viewers');
    await source(repeated); await source(broader);
    const first = await user(); const second = await user();
    for (let index = 0; index < 6; index++) await watched(repeated, first, now - index - 1);
    await watched(broader, first, now - 20); await watched(broader, second, now - 30);
    const feeds = await discovery(db, now);
    expect(feeds.trending.map(entry => entry.id)).toEqual([broader, repeated]);
    expect(feeds.popularMovies.map(entry => entry.id)).toEqual([broader, repeated]);
    expect(feeds.popularMovies[0]).not.toHaveProperty('viewer_count');
    expect(feeds.popularMovies[0]).not.toHaveProperty('user_id');
  });

  it('keeps all-history popularity while excluding old and zero-position activity from trending', async () => {
    const old = await title('Older viewing'); const current = await title('This week'); const untouched = await title('Opened only');
    await source(old); await source(current); await source(untouched);
    const viewer = await user();
    await watched(old, viewer, now - 8 * 86_400_000);
    await watched(current, viewer, now - 2 * 86_400_000);
    await watched(untouched, viewer, now - 1000, 0);
    const feeds = await discovery(db, now);
    expect(feeds.trending.map(entry => entry.id)).toEqual([current]);
    expect(new Set(feeds.popularMovies.map(entry => entry.id))).toEqual(new Set([old, current]));
  });

  it('retains a series with one playable episode and counts viewers across episodes once', async () => {
    const firstSeries = await title('One working episode', { type: 'series' });
    const unavailable = await episode(firstSeries, 4); const available = await episode(firstSeries, 5);
    await source(firstSeries, { episodeId: unavailable, health: 'unavailable' }); await source(firstSeries, { episodeId: available });
    const hiddenSeries = await title('Every episode broken', { type: 'series' }); const broken = await episode(hiddenSeries, 1); await source(hiddenSeries, { episodeId: broken, health: 'unavailable' });
    const popularSeries = await title('Two viewers', { type: 'series' }); const popularEpisode = await episode(popularSeries, 1); await source(popularSeries, { episodeId: popularEpisode });
    const first = await user(); const second = await user();
    await watched(firstSeries, first, now - 1, 60, unavailable); await watched(firstSeries, first, now - 2, 60, available);
    await watched(popularSeries, first, now - 3, 60, popularEpisode); await watched(popularSeries, second, now - 4, 60, popularEpisode);
    await watched(hiddenSeries, first, now - 5, 60, broken);
    const feeds = await discovery(db, now);
    expect(feeds.popularSeries.map(entry => entry.id)).toEqual([popularSeries, firstSeries]);
    expect(feeds.recent.map(entry => entry.id)).not.toContain(hiddenSeries);
    expect(feeds.popularMovies).toEqual([]);
  });

  it('bounds every feed at twelve real titles', async () => {
    const viewer = await user();
    for (let index = 0; index < 15; index++) { const entry = await title(`Film ${index}`, { featured: true, createdAt: now - index }); await source(entry); await watched(entry, viewer); }
    const feeds = await discovery(db, now);
    expect(feeds.featured).toHaveLength(12); expect(feeds.recent).toHaveLength(12);
    expect(feeds.trending).toHaveLength(12); expect(feeds.popularMovies).toHaveLength(12);
    expect(feeds.popularSeries).toHaveLength(0);
  });
});
