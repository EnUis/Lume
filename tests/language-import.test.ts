import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractLanguageTags, languageLabel, normalizeLanguage } from '../lib/languages';
import { openDatabase, type DB } from '../lib/server/db';
import { parseM3U, M3U_IMPORT_VERSION } from '../lib/server/m3u';
import { checkSource, synchronizePlaylist } from '../lib/server/pipeline';
import { encrypt, hash, id } from '../lib/server/security';
import type { SafeFetcher } from '../lib/server/outbound';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
const stream = (name: string, number: number, type = 'movie', attrs = '') => `#EXTINF:-1 ${attrs},${name}\nhttps://provider.example/${type}/account/key/${number}.mp4\n`;
async function importContent(content: string) { const playlistId = id(); await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,?)', [playlistId, 'Provider label', encrypt(content), Date.now()]); await synchronizePlaylist(db, playlistId); return playlistId; }
async function replace(playlistId: string, content: string) { await db.run('UPDATE playlists SET content_encrypted=? WHERE id=?', [encrypt(content), playlistId]); }
const media: SafeFetcher = async url => ({ status: 206, headers: {}, body: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]), truncated: false, url });

describe('explicit language labels', () => {
  it('normalizes ISO aliases, localized names, locales and country tags without changing ordinary title words', () => {
    for (const value of ['DE', 'GER', 'deu', 'German', 'Deutsch', 'de-DE']) expect(normalizeLanguage(value)).toBe('de');
    for (const value of [undefined, null, 'unknown', 'CA', 'BE', 'CH']) expect(normalizeLanguage(value)).toBeNull();
    expect(languageLabel('GER')).toBe('German'); expect(languageLabel('mul')).toBe('Multilingual');
    for (const name of ['It', 'German Lessons', 'The English Patient', '1917', '(IT)', '[CA] Film']) expect(extractLanguageTags(name)).toMatchObject({ title: name, language: null, explicit: false });
    expect(extractLanguageTags('(DE) A Film [German]')).toEqual({ title: 'A Film', language: 'de', explicit: true });
    expect(extractLanguageTags('🇫🇷 A Film')).toMatchObject({ title: 'A Film', language: 'fr' });
    expect(extractLanguageTags('Film - Español')).toMatchObject({ title: 'Film', language: 'es' });
    for (const tag of ['US', 'GB', 'UK']) expect(extractLanguageTags(`(${tag}) Film`).language).toBe('en');
    expect(extractLanguageTags('(BR) Film').language).toBe('pt');
    expect(extractLanguageTags('(UK) Film', { lang: 'uk' })).toMatchObject({ title: 'Film', language: 'uk' });
    expect(extractLanguageTags('[DUAL] Film')).toMatchObject({ title: 'Film', language: 'mul' });
  });

  it('preserves the raw EXTINF name and numeric movie title while honoring explicit audio attributes', () => {
    const result = parseM3U('#EXTM3U\n' + stream('(DE) 1917 1080p', 1) + stream('A Film (2020) [GER]', 2) + stream('(DE) A Film (2020)', 3, 'movie', 'audio-language="French" tvg-language="GER"') + stream('A Show (2020) [GER] S1 E2', 4, 'series'));
    expect(M3U_IMPORT_VERSION).toBe(8);
    expect(result.entries[0]).toMatchObject({ name: '(DE) 1917 1080p', title: '1917', year: null, language: 'de', languageExplicit: true });
    expect(result.entries[1]).toMatchObject({ title: 'A Film', year: 2020, language: 'de' });
    expect(result.entries[2]).toMatchObject({ title: 'A Film', language: 'fr' });
    expect(result.entries[3]).toMatchObject({ title: 'A Show', year: 2020, language: 'de', season: 1, episode: 2 });
    expect(result.errors).toEqual([]);
  });
});

describe('canonical language variant identities', () => {
  it('groups same-year movies and stores languages without replacing provider labels', async () => {
    await importContent('#EXTM3U\n' + stream('(DE) A Film (2020)', 1) + stream('[EN] A Film (2020)', 2) + stream('A Film (2020) | FR', 3));
    const titles = await db.all('SELECT id,name,year FROM titles'); expect(titles).toHaveLength(1); expect(titles[0]).toMatchObject({ name: 'A Film', year: 2020 });
    const sources = await db.all('SELECT title_id,name,language,original_name FROM sources ORDER BY original_name');
    expect(new Set(sources.map(row => row.title_id)).size).toBe(1); expect(new Set(sources.map(row => row.language))).toEqual(new Set(['de', 'en', 'fr']));
    expect(sources.every(row => row.name === 'Provider label')).toBe(true); expect(sources.some(row => row.original_name === '(DE) A Film (2020)')).toBe(true);
  });

  it('groups compatible dated and undated explicit language versions in either import order', async () => {
    await importContent('#EXTM3U\n' + stream('[EN] First Film', 1) + stream('[DE] First Film (2020)', 2));
    await importContent('#EXTM3U\n' + stream('[EN] Second Film (2021)', 3) + stream('[DE] Second Film', 4));
    const titles = await db.all('SELECT name,year FROM titles ORDER BY name');
    expect(titles).toEqual([{ name: 'First Film', year: 2020 }, { name: 'Second Film', year: 2021 }]);
    expect((await db.get('SELECT COUNT(*) AS n FROM sources'))?.n).toBe(4);
    expect((await db.get('SELECT COUNT(*) AS n FROM review_queue'))?.n).toBe(0);
  });

  it('retains a cleaned live name across refreshes without a decoration-only identity review', async () => {
    const content = '#EXTM3U\n#EXTINF:-1 group-title="FILMSKI / MOVIE",CINESTAR 1 (HD)\nhttp://media.example.test:8080/142.ts';
    const playlistId = await importContent(content);
    const original = (await db.get('SELECT id FROM titles'))!;
    await db.run("UPDATE titles SET name='CINESTAR 1',normalized='cinestar 1' WHERE id=?", [original.id]);
    await synchronizePlaylist(db, playlistId, undefined, content);
    expect(await db.get('SELECT name,type FROM titles WHERE id=?', [original.id])).toEqual({ name: 'CINESTAR 1', type: 'live' });
    expect((await db.get('SELECT COUNT(*) AS n FROM review_queue'))?.n).toBe(0);
  });

  it('groups uniquely identified cross-language unknown-year films but reviews a repeated same-language identity', async () => {
    const original = '#EXTM3U\n' + stream('(DE) Unknown Film', 1) + stream('(EN) Unknown Film', 2) + stream('(FR) Unknown Film', 3); const playlistId = await importContent(original);
    expect((await db.get('SELECT COUNT(*) AS n FROM titles'))?.n).toBe(1);
    await replace(playlistId, original + stream('(DE) Unknown Film', 4)); await synchronizePlaylist(db, playlistId);
    expect((await db.get('SELECT COUNT(*) AS n FROM titles'))?.n).toBe(2);
    expect((await db.get("SELECT COUNT(*) AS n FROM review_queue WHERE status='pending'"))?.n).toBe(1);
    expect((await db.get('SELECT COUNT(*) AS n FROM titles WHERE published=1'))?.n).toBe(1);
  });

  it('does not guess among remakes, known-year conflicts, multilingual labels or fuzzy movie names', async () => {
    await importContent('#EXTM3U\n' + stream('(DE) Remake', 1) + stream('(DE) Remake', 2) + stream('(EN) Remake', 3) + stream('(DE) Dated Film (1990)', 4) + stream('(EN) Dated Film (2020)', 5) + stream('(FR) Dated Film', 6) + stream('(DE) The Signal (2014)', 7) + stream('(EN) The Signals (2014)', 8) + stream('(MULTI) Mixed Film', 9) + stream('(DE) Mixed Film', 10));
    expect((await db.get('SELECT COUNT(*) AS n FROM titles'))?.n).toBe(10);
    expect((await db.get("SELECT COUNT(*) AS n FROM titles WHERE normalized='remake'"))?.n).toBe(3);
    expect((await db.get("SELECT COUNT(*) AS n FROM titles WHERE normalized='dated film'"))?.n).toBe(3);
    expect((await db.get("SELECT COUNT(*) AS n FROM titles WHERE normalized='mixed film'"))?.n).toBe(2);
  });

  it('groups language sources by canonical series and episode coordinates while reviewing conflicting known years', async () => {
    await importContent('#EXTM3U\n' + stream('(DE) A Show S1 E1', 1, 'series') + stream('(EN) A Show S1 E1', 2, 'series') + stream('(FR) A Show S1 E2', 3, 'series') + stream('(DE) Another Show (2020) S1 E1', 4, 'series') + stream('(EN) Another Show (2021) S1 E1', 5, 'series') + stream('(FR) Another Show S1 E1', 6, 'series') + stream('(IT) Another Show S1 E2', 7, 'series'));
    const show = (await db.get("SELECT id FROM titles WHERE normalized='a show'"))!;
    expect((await db.get('SELECT COUNT(*) AS n FROM episodes WHERE title_id=?', [show.id]))?.n).toBe(2);
    expect((await db.get('SELECT COUNT(*) AS n FROM sources WHERE title_id=?', [show.id]))?.n).toBe(3);
    expect((await db.get("SELECT COUNT(*) AS n FROM titles WHERE normalized='another show'"))?.n).toBe(3);
    expect((await db.get("SELECT published FROM titles WHERE normalized='another show' AND year IS NULL"))?.published).toBe(0);
    expect((await db.get("SELECT COUNT(*) AS n FROM review_queue WHERE reason LIKE '%conflicting release years%'"))?.n).toBe(2);
  });
});

describe('parser upgrades and browser playback blocks', () => {
  it('preserves each language source ID and its browser failure when duplicate URLs receive new parser keys', async () => {
    const content = '#EXTM3U\n' + stream('(DE) Shared Film (2020)', 1) + stream('(EN) Shared Film (2020)', 1); const playlistId = await importContent(content);
    const sources = await db.all('SELECT id,language FROM sources WHERE playlist_id=?', [playlistId]); const german = sources.find(source => source.language === 'de')!;
    for (const source of sources) await db.run('UPDATE sources SET entry_key=?,name=? WHERE id=?', [`legacy-${source.language}`, `Manual ${source.language}`, source.id]);
    await db.run("UPDATE sources SET playback_blocked=1,playback_blocked_at=20,health='unavailable',error='Browser decoder failed' WHERE id=?", [german.id]);
    await db.run('UPDATE playlist_versions SET report=? WHERE playlist_id=?', [JSON.stringify({ importVersion: 2 }), playlistId]);
    await replace(playlistId, '#EXTM3U\n' + stream('(EN) Shared Film (2020)', 1) + stream('(DE) Shared Film (2020)', 1));
    expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ added: 0, removed: 0 });
    for (const source of sources) expect(await db.get('SELECT id,name,removed FROM sources WHERE playlist_id=? AND language=?', [playlistId, source.language])).toMatchObject({ id: source.id, name: `Manual ${source.language}`, removed: 0 });
    expect(await db.get('SELECT playback_blocked,playback_blocked_at,error FROM sources WHERE id=?', [german.id])).toMatchObject({ playback_blocked: 1, playback_blocked_at: 20, error: 'Browser decoder failed' });
    // Either backfilled descriptor can be sufficient, without assuming URL uniqueness.
    for (const source of sources) await db.run('UPDATE sources SET entry_key=?,language=?,original_name=? WHERE id=?', [`older-${source.language}`, source.language === 'de' ? null : source.language, source.language === 'de' ? '(DE) Shared Film (2020)' : null, source.id]);
    await db.run('UPDATE playlist_versions SET report=? WHERE playlist_id=?', [JSON.stringify({ importVersion: 2 }), playlistId]);
    expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ added: 0, removed: 0 });
    expect((await db.get('SELECT COUNT(*) AS n FROM sources WHERE playlist_id=?', [playlistId]))?.n).toBe(2);
    expect(await db.get('SELECT playback_blocked,error FROM sources WHERE id=?', [german.id])).toMatchObject({ playback_blocked: 1, error: 'Browser decoder failed' });
  });

  it('inherits a URL browser block when duplicated legacy rows cannot be matched safely', async () => {
    const content = '#EXTM3U\n' + stream('(DE) Shared Film (2020)', 1) + stream('(EN) Shared Film (2020)', 1); const playlistId = await importContent(content);
    const sources = await db.all('SELECT id FROM sources WHERE playlist_id=?', [playlistId]);
    for (let index = 0; index < sources.length; index++) await db.run('UPDATE sources SET entry_key=?,language=NULL,original_name=NULL WHERE id=?', [`ambiguous-${index}`, sources[index].id]);
    await db.run("UPDATE sources SET playback_blocked=1,playback_blocked_at=30,last_failure=30,failures=2,health='unavailable',error='Browser container unsupported' WHERE id=?", [sources[0].id]);
    await db.run('UPDATE playlist_versions SET report=? WHERE playlist_id=?', [JSON.stringify({ importVersion: 2 }), playlistId]);
    expect(await synchronizePlaylist(db, playlistId)).toMatchObject({ added: 2, removed: 2, starterChecks: 0 });
    const active = await db.all('SELECT id,language,playback_blocked,playback_blocked_at,health,error FROM sources WHERE playlist_id=? AND removed=0', [playlistId]);
    expect(active).toHaveLength(2); expect(new Set(active.map(source => source.language))).toEqual(new Set(['de', 'en']));
    for (const source of active) {
      expect(source).toMatchObject({ playback_blocked: 1, playback_blocked_at: 30, health: 'unavailable', error: 'Browser container unsupported' });
      expect(await checkSource(db, source.id, media)).toMatchObject({ ok: true, health: 'unavailable', error: 'Browser container unsupported' });
    }
    expect((await db.get('SELECT COUNT(*) AS n FROM sources WHERE playlist_id=? AND removed=0 AND playback_blocked=0', [playlistId]))?.n).toBe(0);
  });

  it('inherits failures recorded between batches and uses the URL index without a catalog scan', async () => {
    const content = '#EXTM3U\n' + stream('(DE) Shared Film (2020)', 1) + stream('(EN) Shared Film (2020)', 1); const playlistId = id();
    await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,?)', [playlistId, 'Provider label', encrypt(content), Date.now()]);
    await synchronizePlaylist(db, playlistId, undefined, undefined, { batchSize: 1, onBatch: async progress => {
      if (progress.processed === 1) await db.run("UPDATE sources SET playback_blocked=1,playback_blocked_at=40,last_failure=40,health='unavailable',error='Browser failed during import' WHERE playlist_id=? AND language='de'", [playlistId]);
    } });
    expect(await db.get("SELECT playback_blocked,playback_blocked_at,error,health FROM sources WHERE playlist_id=? AND language='en'", [playlistId])).toMatchObject({ playback_blocked: 1, playback_blocked_at: 40, error: 'Browser failed during import', health: 'unavailable' });
    const title = (await db.get('SELECT id FROM titles LIMIT 1'))!;
    await db.run("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<2000) INSERT INTO sources(id,title_id,entry_key,name,url_encrypted,url_hash,format,created_at) SELECT 'unrelated-'||n,?,'unrelated-key-'||n,'Other reference',?,'other-url','mp4',0 FROM seq", [title.id, encrypt('https://provider.example/movie/account/key/other.mp4')]);
    const plan = await db.all('EXPLAIN QUERY PLAN SELECT error,playback_blocked_at,last_failure,failures FROM sources WHERE url_hash=? AND playback_blocked=1 ORDER BY playback_blocked_at DESC NULLS LAST LIMIT 1', [hash('https://provider.example/movie/account/key/1.mp4')]);
    expect(plan.map(row => row.detail).join(' ')).toContain('sources_url_playback_reference');
    expect(plan.map(row => row.detail).join(' ')).not.toMatch(/SCAN sources|TEMP B-TREE/i);
    const secondPlaylist = await importContent('#EXTM3U\n' + stream('(FR) Shared Film (2020)', 1));
    expect(await db.get('SELECT playback_blocked,error,health FROM sources WHERE playlist_id=?', [secondPlaylist])).toMatchObject({ playback_blocked: 1, error: 'Browser failed during import', health: 'unavailable' });
  });

  it('retains source IDs, manual labels and account progress after version upgrade and language-order changes', async () => {
    const content = '#EXTM3U\n' + stream('(DE) A Film (2020)', 1) + stream('(EN) A Film (2020)', 2); const playlistId = await importContent(content);
    const sources = await db.all('SELECT id,title_id,url_hash FROM sources'); const userId = id();
    await db.run('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)', [userId, 'language-viewer@example.test', 'Viewer', 'unused', Date.now()]);
    await db.run('INSERT INTO playback_progress(user_id,title_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?)', [userId, sources[0].title_id, sources[0].title_id, 123, 600, Date.now()]);
    await db.run('UPDATE sources SET entry_key=?,name=? WHERE id=?', ['old-parser-key', 'Administrator server label', sources[0].id]);
    await db.run('UPDATE playlist_versions SET report=? WHERE playlist_id=?', [JSON.stringify({ importVersion: 2 }), playlistId]);
    await synchronizePlaylist(db, playlistId);
    await replace(playlistId, '#EXTM3U\n' + stream('(EN) A Film (2020)', 2) + stream('(DE) A Film (2020)', 1)); await synchronizePlaylist(db, playlistId);
    for (const source of sources) expect((await db.get('SELECT id FROM sources WHERE url_hash=? AND playlist_id=?', [source.url_hash, playlistId]))?.id).toBe(source.id);
    expect((await db.get('SELECT name FROM sources WHERE id=?', [sources[0].id]))?.name).toBe('Administrator server label');
    expect((await db.get('SELECT position,title_id FROM playback_progress WHERE user_id=?', [userId]))).toMatchObject({ position: 123, title_id: sources[0].title_id });
  });

  it('keeps browser blocks and their reasons during reimports, removal restoration and successful header probes', async () => {
    const content = '#EXTM3U\n' + stream('(DE) A Film (2020)', 1); const playlistId = await importContent(content); const source = (await db.get('SELECT id FROM sources'))!;
    await db.run("UPDATE sources SET playback_blocked=1,playback_blocked_at=10,health='unavailable',error='Browser media error' WHERE id=?", [source.id]);
    await db.run('UPDATE playlist_versions SET report=? WHERE playlist_id=?', [JSON.stringify({ importVersion: 2 }), playlistId]); await synchronizePlaylist(db, playlistId);
    expect(await checkSource(db, source.id, media)).toMatchObject({ ok: true, health: 'unavailable', error: 'Browser media error' });
    expect(await db.get('SELECT playback_blocked,playback_blocked_at,error FROM sources WHERE id=?', [source.id])).toMatchObject({ playback_blocked: 1, playback_blocked_at: 10, error: 'Browser media error' });
    await db.run('UPDATE sources SET removed=1 WHERE id=?', [source.id]); await synchronizePlaylist(db, playlistId, undefined, content);
    expect(await db.get('SELECT playback_blocked,error,health FROM sources WHERE id=?', [source.id])).toMatchObject({ playback_blocked: 1, error: 'Browser media error', health: 'unavailable' });
    const changed = '#EXTM3U\n' + stream('(DE) A Film (2020)', 2); await replace(playlistId, changed); await synchronizePlaylist(db, playlistId);
    expect(await db.get('SELECT playback_blocked,playback_blocked_at,url_hash FROM sources WHERE id=?', [source.id])).toMatchObject({ playback_blocked: 0, playback_blocked_at: null, url_hash: hash('https://provider.example/movie/account/key/2.mp4') });
  });

  it('honors a browser failure committed while a verification request is still pending', async () => {
    await importContent('#EXTM3U\n' + stream('A Film (2020)', 1)); const source = (await db.get('SELECT id FROM sources'))!;
    const race: SafeFetcher = async url => { await db.run("UPDATE sources SET playback_blocked=1,health='unavailable',error='Browser decoder failed' WHERE id=?", [source.id]); return media(url); };
    expect(await checkSource(db, source.id, race)).toMatchObject({ ok: true, health: 'unavailable', error: 'Browser decoder failed' });
    expect(await db.get('SELECT playback_blocked,health,error FROM sources WHERE id=?', [source.id])).toMatchObject({ playback_blocked: 1, health: 'unavailable', error: 'Browser decoder failed' });
  });
});
