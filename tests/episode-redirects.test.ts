import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { createTitle } from '../lib/server/pipeline';
import { mergeTitles } from '../lib/server/management';
import { playbackSources, resolveEpisodeId, titleDetails } from '../lib/server/catalog';
import { encrypt, id, session } from '../lib/server/security';
import { handleApi } from '../lib/server/api';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
async function series(language: string) {
  const titleId = await createTitle(db, { name: `(${language.toUpperCase()}) A Shared Story`, type: 'series', year: 2021 });
  const seasonId = id(), episodes: string[] = [];
  await db.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,1)', [seasonId, titleId]);
  for (const number of [1, 2]) {
    const episodeId = id(), sourceId = id(); episodes.push(episodeId);
    await db.run('INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES(?,?,?,1,?,?)', [episodeId, titleId, seasonId, number, `Episode ${number}`]);
    await db.run("INSERT INTO sources(id,title_id,episode_id,entry_key,name,url_encrypted,url_hash,language,health,created_at) VALUES(?,?,?,?,?,?,?,?,'healthy',?)", [sourceId, titleId, episodeId, sourceId, language, encrypt(`https://media.example.test/${sourceId}.mp4`), sourceId, language, Date.now()]);
  }
  return { titleId, episodes };
}

it('preserves an older episode URL and its language sources through successive series merges', async () => {
  const first = await series('de'), second = await series('en'), third = await series('fr');
  await mergeTitles(db, first.titleId, second.titleId);
  await mergeTitles(db, second.titleId, third.titleId);
  expect(await resolveEpisodeId(db, first.episodes[1])).toBe(third.episodes[1]);
  const details = await titleDetails(db, first.titleId);
  expect(details?.alternateIds).toEqual(expect.arrayContaining([first.titleId, second.titleId]));
  expect(details?.episodes?.[1].alternateIds).toEqual(expect.arrayContaining([first.episodes[1], second.episodes[1]]));
  const sources = await playbackSources(db, first.titleId, first.episodes[1]);
  expect(sources).toHaveLength(3);
  expect(new Set(sources.map(source => source.episodeId))).toEqual(new Set([third.episodes[1]]));
  expect(new Set(sources.map(source => source.language))).toEqual(new Set(['de', 'en', 'fr']));
});

it('migrates guest progress from old series and episode IDs without accepting another title’s episode', async () => {
  const first = await series('de'), second = await series('en'), unrelated = await series('fr');
  await mergeTitles(db, first.titleId, second.titleId);
  const userId = id();
  await db.run("INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'unused',?)", [userId, 'episode-test@example.invalid', 'Episode test', Date.now()]);
  const cookie = (await session(db, userId)).split(';')[0];
  const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
  const save = (episodeId: string) => handleApi(new Request(`${origin}/api/progress`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ titleId: first.titleId, episodeId, position: 125, duration: 1800 }) }), db);
  const result = await save(first.episodes[1]);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ progress: { titleId: second.titleId, episodeId: second.episodes[1], position: 125 } });
  expect((await save(unrelated.episodes[1])).status).toBe(400);
  expect((await db.get('SELECT COUNT(*) AS count FROM playback_progress'))?.count).toBe(1);
});
