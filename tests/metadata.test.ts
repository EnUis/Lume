import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { createTitle } from '../lib/server/pipeline';
import { enrichTitleMetadata, scheduleMetadataEnrichment } from '../lib/server/metadata';
import { chooseMetadataCandidate, englishDisplayTitle, explicitAdultMetadata, metadataImage, metadataText, titleSearchLanguage, type MetadataConfiguration, type MetadataIdentity } from '../lib/server/metadata-providers';
import { metadataClient, MetadataDeferred } from '../lib/server/metadata-client';
import { encrypt, hash, id } from '../lib/server/security';
import type { SafeFetcher } from '../lib/server/outbound';

let db: DB;
const config: MetadataConfiguration = { enabled: true, language: 'en' };
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
const response = (url: string, value: unknown, status = 200, headers: Record<string, string> = {}) => ({ url, status, headers, body: Buffer.from(JSON.stringify(value)), truncated: false });
const show = (year = 2002, name = 'Spooks', number = 1) => ({ id: number, name, premiered: `${year}-05-13`, summary: '<p>British intelligence officers protect the country &amp; confront difficult choices.</p>', genres: ['Drama', 'Thriller'], image: { original: 'https://static.tvmaze.com/uploads/images/original_untouched/1/1.jpg' }, externals: { imdb: 'tt0160904' } });
function harness(fetcher: SafeFetcher, configuration = config) {
  let time = Date.now();
  return { fetcher, configuration, now: () => time, sleep: async (ms: number) => { time += ms; } };
}
async function source(titleId: string, healthy = false, original = 'Original title') {
  await db.run('INSERT INTO sources(id,title_id,entry_key,name,original_name,url_encrypted,url_hash,format,health,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [id(), titleId, id(), 'Provider', original, encrypt('https://media.example/sample.mp4'), hash('https://media.example/sample.mp4'), 'mp4', healthy ? 'healthy' : 'unknown', Date.now()]);
}
function movieFetcher(searched: string[], options: { wrongType?: boolean; wrongYear?: boolean } = {}): SafeFetcher {
  return async url => {
    const parsed = new URL(url); const action = parsed.searchParams.get('action'); const props = parsed.searchParams.get('prop');
    if (parsed.hostname === 'www.wikidata.org' && action === 'wbsearchentities') { searched.push(parsed.searchParams.get('search')!); return response(url, { search: [{ id: 'Q200' }] }); }
    if (parsed.hostname === 'www.wikidata.org' && action === 'wbgetentities') {
      if (parsed.searchParams.get('ids') !== 'Q200') return response(url, { entities: { Q5: { claims: {} } } });
      const claim = (value: unknown) => [{ mainsnak: { datavalue: { value } } }];
      return response(url, { entities: { Q200: { id: 'Q200', labels: { en: { value: 'District 9' } }, aliases: { de: [{ value: 'District 9' }] }, descriptions: { en: { value: '2009 science fiction film' } }, claims: { P31: claim({ id: options.wrongType ? 'Q5' : 'Q11424' }), P577: claim({ time: `+${options.wrongYear ? 2010 : 2009}-08-13T00:00:00Z` }) }, sitelinks: { enwiki: { title: 'District 9' } } } } });
    }
    if (props === 'extracts|pageimages|pageprops') return response(url, { query: { pages: [{ title: 'District 9', pageprops: { wikibase_item: 'Q200' }, extract: 'District 9 is a 2009 science fiction film about refugees from another planet.', pageimage: 'District 9 poster.jpg', thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/en/thumb/1/12/District9.jpg/600px-District9.jpg' } }] } });
    if (props === 'imageinfo') return response(url, { query: { pages: [{ imageinfo: [{ mime: 'image/jpeg', descriptionurl: 'https://en.wikipedia.org/wiki/File:District_9_poster.jpg', extmetadata: { LicenseShortName: { value: 'Fair use' }, Artist: { value: 'Film distributor' } } }] }] } });
    throw new Error('Unexpected metadata fixture request');
  };
}

describe('conservative metadata identities and public providers', () => {
  it('accepts explicit English release labels without inventing translations of other scripts', () => {
    expect(englishDisplayTitle('  Amélie  ')).toBe('Amélie'); expect(englishDisplayTitle('2012')).toBe('2012');
    expect(englishDisplayTitle('المقاطعة 9')).toBe(''); expect(englishDisplayTitle('<b>A Movie</b>')).toBe('');
    expect(titleSearchLanguage('المقاطعة 9')).toBe('ar'); expect(titleSearchLanguage('Дюна')).toBe('ru');
  });

  it('requires an exact normalized name and matching known year, rejecting unknown-year remakes and fuzzy names', () => {
    const identity: MetadataIdentity = { name: 'The Signal', type: 'movie', year: 2014, aliases: [], identifiers: {} };
    const rows = [{ id: 1, names: ['The Signal'], year: 2007 }, { id: 2, names: ['The Signal'], year: 2014 }, { id: 3, names: ['The Signals'], year: 2014 }];
    expect(chooseMetadataCandidate(identity, rows)?.id).toBe(2); expect(chooseMetadataCandidate({ ...identity, year: null }, rows)).toBeNull();
    expect(chooseMetadataCandidate(identity, [{ id: 3, names: ['The Signals'], year: 2014 }])).toBeNull();
    expect(chooseMetadataCandidate(identity, [{ id: 1, names: ['The Signal'], year: null }])).toBeNull();
    expect(chooseMetadataCandidate({ ...identity, name: 'Amélie' }, [{ id: 4, names: ['Amelie'], year: 2014 }])?.id).toBe(4);
  });

  it('fills real series metadata with attribution while preserving existing description and manual genre values', async () => {
    const titleId = await createTitle(db, { name: 'Spooks', type: 'series', year: 2002 });
    const attribution = 'Manual artwork license; TVmaze · https://www.tvmaze.com/shows/1 · CC BY-SA';
    await db.run('UPDATE titles SET synopsis=?,genres=?,attribution=? WHERE id=?', ['Existing description', '["Manual genre"]', attribution, titleId]);
    const options = harness(async url => response(url, [{ show: show() }]));
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ matched: true, provider: 'tvmaze' });
    const title = (await db.get('SELECT name,year,poster,synopsis,genres,attribution FROM titles WHERE id=?', [titleId]))!;
    expect(title).toMatchObject({ name: 'Spooks', year: 2002, synopsis: 'Existing description', genres: '["Manual genre"]' });
    expect(title.poster).toContain('static.tvmaze.com'); expect(title.attribution).toContain('https://www.tvmaze.com/shows/1');
    expect(title.attribution).toBe(attribution);
    expect((await db.get('SELECT provider,external_id FROM metadata_identifiers WHERE title_id=?', [titleId]))).toMatchObject({ provider: 'tvmaze', external_id: '1' });
  });

  it('matches film type/year and a linked article identity, sends only the cleaned title and saves sourced lead artwork', async () => {
    const titleId = await createTitle(db, { name: 'District 9 (2009) | 🌟 FREE IPTV WORLD 🌟', type: 'movie' }); const searches: string[] = [];
    expect(await enrichTitleMetadata(db, titleId, harness(movieFetcher(searches)))).toMatchObject({ matched: true, provider: 'wikidata' });
    expect(searches).toEqual(['District 9']); const title = (await db.get('SELECT name,poster,synopsis,attribution FROM titles WHERE id=?', [titleId]))!;
    expect(title.name).toBe('District 9'); expect(title.poster).toContain('upload.wikimedia.org');
    expect((await db.all('SELECT name FROM title_aliases WHERE title_id=?', [titleId])).map(row => row.name)).toContain('District 9 (2009) | 🌟 FREE IPTV WORLD 🌟');
    expect(title.synopsis).toContain('2009 science fiction film'); expect(title.attribution).toContain('https://en.wikipedia.org/wiki/District_9'); expect(title.attribution).toContain('Fair use');
  });

  it('leaves film fields empty when a same-name candidate has the wrong year or is a person', async () => {
    for (const kind of ['wrongType', 'wrongYear'] as const) {
      const titleId = await createTitle(db, { name: 'District 9', type: 'movie', year: 2009 });
      const result = await enrichTitleMetadata(db, titleId, harness(movieFetcher([], { [kind]: true }), { ...config, language: kind === 'wrongType' ? 'en' : 'de' }));
      expect(result).toMatchObject({ matched: false }); expect(await db.get('SELECT poster,synopsis FROM titles WHERE id=?', [titleId])).toMatchObject({ poster: '', synopsis: '' });
    }
  });

  it('never sends explicitly tagged adult entries for public searches, while retaining ordinary title words', async () => {
    for (const title of ['[XXX] Explicit title', '(Adult) Explicit title', 'PORN | Explicit title']) expect(explicitAdultMetadata(title)).toBe(true);
    for (const title of ['Adult Life Skills', 'xXx', 'Sex Education']) expect(explicitAdultMetadata(title)).toBe(false);
    const titleId = await createTitle(db, { name: 'Sanitized provider title', year: 2020 }); await source(titleId, false, '[XXX] Sanitized provider title');
    let calls = 0; const result = await enrichTitleMetadata(db, titleId, harness(async url => { calls++; return response(url, {}); }));
    expect(result).toMatchObject({ skipped: true }); expect(calls).toBe(0);
  });

  it('rejects private/credential artwork and strips HTML with a 140-word description limit', () => {
    for (const url of ['http://static.tvmaze.com/image.jpg', 'https://user:secret@static.tvmaze.com/image.jpg', 'https://127.0.0.1/image.jpg', 'https://localhost/image.jpg', 'https://other.example/image.jpg']) expect(metadataImage(url, ['static.tvmaze.com'])).toBe('');
    expect(metadataImage('https://static.tvmaze.com/image.jpg', ['static.tvmaze.com'])).toBe('https://static.tvmaze.com/image.jpg');
    const description = metadataText('<script>leak()</script><p>' + 'word '.repeat(200) + '</p>'); expect(description).not.toContain('leak'); expect(description.split(' ')).toHaveLength(140);
  });
});

describe('English display identities and missing banners', () => {
  it('uses a confirmed English Wikidata label for a Latin-script foreign-language series instead of assuming TVmaze translated it', async () => {
    const titleId = await createTitle(db, { name: 'Der Pass', type: 'series', year: 2019 }); await source(titleId);
    const fetcher: SafeFetcher = async url => {
      const parsed = new URL(url);
      if (parsed.hostname === 'api.tvmaze.com') return response(url, url.endsWith('/images') ? [] : [{ show: { ...show(2019, 'Der Pass'), language: 'German' } }]);
      if (parsed.searchParams.get('list') === 'search') { expect(parsed.searchParams.get('srsearch')).toBe('haswbstatement:"P345=tt0160904"'); return response(url, { query: { search: [{ title: 'Q600' }] } }); }
      return response(url, { entities: { Q600: { id: 'Q600', labels: { en: { value: 'Pagan Peak' }, de: { value: 'Der Pass' } }, claims: { P345: [{ mainsnak: { datavalue: { value: 'tt0160904' } } }], P31: [{ mainsnak: { datavalue: { value: { id: 'Q5398426' } } } }], P580: [{ mainsnak: { datavalue: { value: { time: '+2019-01-25T00:00:00Z' } } } }] } } } });
    };
    expect(await enrichTitleMetadata(db, titleId, harness(fetcher))).toMatchObject({ matched: true, provider: 'wikidata' });
    expect((await db.get('SELECT name FROM titles WHERE id=?', [titleId]))?.name).toBe('Pagan Peak');
    expect((await db.all('SELECT name FROM title_aliases WHERE title_id=?', [titleId])).map(row => row.name)).toContain('Der Pass');
  });

  it('renames a fully illustrated Arabic title only from the matched English label and preserves its original searchable name', async () => {
    const original = 'المقاطعة 9'; const titleId = await createTitle(db, { name: original, year: 2009 }); await source(titleId, true);
    await db.run('UPDATE titles SET poster=?,backdrop=?,synopsis=? WHERE id=?', ['/images/provider-poster.jpg', '/images/provider-banner.jpg', 'Existing description', titleId]);
    const priorSource = await db.get('SELECT id,title_id FROM sources WHERE title_id=?', [titleId]);
    const base = movieFetcher([]); const languages: string[] = [];
    const fetcher: SafeFetcher = async (url, options) => {
      const parsed = new URL(url);
      if (parsed.searchParams.get('action') === 'wbsearchentities') languages.push(parsed.searchParams.get('language')!);
      const result = await base(url, options);
      if (parsed.searchParams.get('action') === 'wbgetentities' && parsed.searchParams.get('ids') === 'Q200') {
        const data = JSON.parse(result.body.toString()); data.entities.Q200.labels.ar = { language: 'ar', value: original }; return response(url, data);
      }
      return result;
    };
    const options = harness(fetcher);
    expect(await scheduleMetadataEnrichment(db, { titleIds: [titleId], limit: 1, backgroundLimit: 0 })).toMatchObject({ queued: 1 });
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ matched: true, fields: ['name', 'normalized'] });
    expect(languages).toEqual(['ar']); expect(await db.get('SELECT name,normalized,poster,backdrop,synopsis FROM titles WHERE id=?', [titleId])).toMatchObject({ name: 'District 9', normalized: 'district 9', poster: '/images/provider-poster.jpg', backdrop: '/images/provider-banner.jpg', synopsis: 'Existing description' });
    expect((await db.all('SELECT name FROM title_aliases WHERE title_id=?', [titleId])).map(row => row.name)).toContain(original);
    expect(await db.get('SELECT id,title_id FROM sources WHERE title_id=?', [titleId])).toEqual(priorSource);
    expect(await scheduleMetadataEnrichment(db, { titleIds: [titleId], limit: 1, backgroundLimit: 0, force: true })).toMatchObject({ queued: 0 });
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ skipped: true });
  });

  it('rechecks a bound provider identity with a localized saved name while retaining type/year protections', async () => {
    const titleId = await createTitle(db, { name: 'المقاطعة 9', year: 2009 });
    await db.run('INSERT INTO metadata_identifiers(id,title_id,provider,external_id) VALUES(?,?,?,?)', [id(), titleId, 'wikidata', 'Q200']);
    const searches: string[] = []; expect(await enrichTitleMetadata(db, titleId, harness(movieFetcher(searches)))).toMatchObject({ matched: true });
    expect(searches).toEqual([]); expect((await db.get('SELECT name FROM titles WHERE id=?', [titleId]))?.name).toBe('District 9');
    const wrong = await createTitle(db, { name: 'Foreign title', year: 2010 });
    await db.run('DELETE FROM metadata_identifiers WHERE title_id=?', [titleId]); await db.run('INSERT INTO metadata_identifiers(id,title_id,provider,external_id) VALUES(?,?,?,?)', [id(), wrong, 'wikidata', 'Q200']);
    expect(await enrichTitleMetadata(db, wrong, harness(movieFetcher([])))).toMatchObject({ matched: false });
    expect((await db.get('SELECT name FROM titles WHERE id=?', [wrong]))?.name).toBe('Foreign title');
  });

  it('finds and fills an official series background when poster and description are already complete', async () => {
    const titleId = await createTitle(db, { name: 'Spooks', type: 'series', year: 2002 });
    await db.run('UPDATE titles SET poster=?,synopsis=? WHERE id=?', ['/images/manual-poster.jpg', 'Existing description', titleId]);
    const fetcher: SafeFetcher = async url => response(url, url.endsWith('/images') ? [{ type: 'background', main: true, resolutions: { original: { url: 'https://static.tvmaze.com/uploads/images/original_untouched/2/backdrop.jpg' } } }, { type: 'poster', main: true, resolutions: { original: { url: 'https://static.tvmaze.com/portrait.jpg' } } }] : [{ show: show() }]);
    expect(await enrichTitleMetadata(db, titleId, harness(fetcher))).toMatchObject({ matched: true, fields: ['backdrop', 'genres'] });
    expect(await db.get('SELECT poster,backdrop,synopsis FROM titles WHERE id=?', [titleId])).toMatchObject({ poster: '/images/manual-poster.jpg', backdrop: 'https://static.tvmaze.com/uploads/images/original_untouched/2/backdrop.jpg', synopsis: 'Existing description' });
  });

  it('schedules a new banner gap after a prior display-title check without rechecking a complete English title', async () => {
    const titleId = await createTitle(db, { name: 'District 9', year: 2009 });
    await db.run('UPDATE titles SET poster=?,backdrop=?,synopsis=? WHERE id=?', ['/images/poster.jpg', '/images/banner.jpg', 'Description', titleId]);
    const options = harness(movieFetcher([])); await enrichTitleMetadata(db, titleId, options);
    expect(await scheduleMetadataEnrichment(db, { titleIds: [titleId], limit: 1, backgroundLimit: 1, force: true })).toMatchObject({ queued: 0 });
    await db.run("UPDATE titles SET backdrop='',updated_at=? WHERE id=?", [options.now() + 1000, titleId]);
    expect(await scheduleMetadataEnrichment(db, { titleIds: [titleId], limit: 1, backgroundLimit: 1, now: options.now() })).toMatchObject({ queued: 1 });
  });

  it('requires an explicitly English licensed label and preserves a non-English title otherwise', async () => {
    const titleId = await createTitle(db, { name: 'فيلم', year: 2020 });
    const configuration = { ...config, licensedUrl: 'https://metadata.example/lookup', licensedKey: 'fixture-key' };
    const options = harness(async url => response(url, { id: 'fixture-2020', name: 'فيلم', type: 'movie', year: 2020, englishTitle: 'The Verified Film', synopsis: 'Verified description' }), configuration);
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ matched: true });
    expect((await db.get('SELECT name FROM titles WHERE id=?', [titleId]))?.name).toBe('The Verified Film');
    const without = await createTitle(db, { name: 'فيلم آخر', year: 2021 });
    await enrichTitleMetadata(db, without, harness(async url => response(url, { id: 'fixture-2021', name: 'فيلم آخر', type: 'movie', year: 2021, synopsis: 'Verified description' }), configuration));
    expect((await db.get('SELECT name FROM titles WHERE id=?', [without]))?.name).toBe('فيلم آخر');
  });

  it('does not turn a Commons portrait or unknown-rights image into a banner', async () => {
    const base = movieFetcher([]);
    for (const [width, height, license] of [[600, 900, 'CC BY-SA 4.0'], [1600, 900, 'See image rights'], [1600, 900, 'CC BY-SA 4.0']] as const) {
      const titleId = await createTitle(db, { name: 'District 9', year: 2009 });
      const configuration = { ...config, language: width === 600 ? 'en' : license.startsWith('See') ? 'de' : 'fr' };
      const fetcher: SafeFetcher = async (url, options) => {
        const parsed = new URL(url); const result = await base(url, options);
        if (parsed.searchParams.get('action') === 'wbgetentities' && parsed.searchParams.get('ids') === 'Q200') { const data = JSON.parse(result.body.toString()); data.entities.Q200.claims.P18 = [{ mainsnak: { datavalue: { value: 'District still.jpg' } } }]; return response(url, data); }
        if (parsed.hostname === 'commons.wikimedia.org') return response(url, { query: { pages: [{ imageinfo: [{ width, height, mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/still.jpg', extmetadata: { LicenseShortName: { value: license } } }] }] } });
        return result;
      };
      // Each iteration gets a separate cache key for the verified entity fixture.
      await db.run('DELETE FROM metadata_http_cache'); await db.run('DELETE FROM metadata_identifiers');
      await enrichTitleMetadata(db, titleId, harness(fetcher, configuration));
      expect((await db.get('SELECT backdrop FROM titles WHERE id=?', [titleId]))?.backdrop).toBe(width > height && license.startsWith('CC BY') ? 'https://upload.wikimedia.org/still.jpg' : '');
    }
  });
});

describe('metadata persistence, races and bounded requests', () => {
  it('protects a manual lock committed during lookup and does not overwrite fields', async () => {
    const titleId = await createTitle(db, { name: 'Spooks', type: 'series', year: 2002 });
    const fetcher: SafeFetcher = async url => { if (url.endsWith('/images')) return response(url, []); await db.run('UPDATE titles SET poster=?,synopsis=? WHERE id=?', ['/images/manual.jpg', 'Manual edit', titleId]); await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,?)', [titleId, Date.now()]); return response(url, [{ show: show() }]); };
    expect(await enrichTitleMetadata(db, titleId, harness(fetcher))).toMatchObject({ skipped: true });
    expect(await db.get('SELECT poster,synopsis FROM titles WHERE id=?', [titleId])).toMatchObject({ poster: '/images/manual.jpg', synopsis: 'Manual edit' });
  });

  it('rejects a saved identity changed during lookup and does not cache a stale negative result', async () => {
    const titleId = await createTitle(db, { name: 'Spooks', type: 'series', year: 2002 });
    const fetcher: SafeFetcher = async url => { await db.run('UPDATE titles SET name=?,year=?,updated_at=? WHERE id=?', ['Another Show', 2020, Date.now() + 10, titleId]); return response(url, [{ show: show() }]); };
    expect(await enrichTitleMetadata(db, titleId, harness(fetcher))).toMatchObject({ skipped: true });
    expect(await db.get('SELECT poster,synopsis FROM titles WHERE id=?', [titleId])).toMatchObject({ poster: '', synopsis: '' });
    expect(await db.get('SELECT title_id FROM metadata_lookups WHERE title_id=?', [titleId])).toBeUndefined();
  });

  it('caches no-match outcomes and HTTP responses across title jobs without choosing a remake', async () => {
    const titleId = await createTitle(db, { name: 'Spooks', type: 'series' }); let calls = 0;
    const options = harness(async url => { calls++; if (new URL(url).hostname === 'api.tvmaze.com') return response(url, [{ show: show(2002) }, { show: show(2010, 'Spooks', 2) }]); return response(url, { search: [] }); });
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ matched: false }); const first = calls;
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ skipped: true }); expect(calls).toBe(first);
    expect((await db.get('SELECT status FROM metadata_lookups WHERE title_id=?', [titleId]))?.status).toBe('no-match');
    const secondId = await createTitle(db, { name: 'Spooks', type: 'series' }); await enrichTitleMetadata(db, secondId, options); expect(calls).toBe(first);
  });

  it('defers HTTP rate limits with a durable provider cooldown instead of repeatedly calling the provider', async () => {
    let calls = 0; const options = harness(async url => { calls++; return response(url, { error: 'Rate limited' }, 429, { 'retry-after': '120' }); });
    const request = metadataClient(db, options);
    await expect(request('tvmaze', 'https://api.tvmaze.com/search/shows?q=Spooks')).rejects.toBeInstanceOf(MetadataDeferred);
    await expect(request('tvmaze', 'https://api.tvmaze.com/search/shows?q=Different')).rejects.toBeInstanceOf(MetadataDeferred);
    expect(calls).toBe(1); expect(Number((await db.get('SELECT next_request_at FROM metadata_provider_state WHERE provider=?', ['tvmaze']))?.next_request_at)).toBeGreaterThan(options.now() + 60000);
  });

  it('automatically requeues a deferred lookup after cooldown and successfully resumes provider requests', async () => {
    const titleId = await createTitle(db, { name: 'Spooks', type: 'series', year: 2002 }); let calls = 0;
    const options = harness(async url => { if (url.endsWith('/images')) return response(url, []); calls++; return calls === 1 ? response(url, { error: 'Rate limited' }, 429, { 'retry-after': '120' }) : response(url, [{ show: show() }]); });
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ deferred: true });
    expect((await db.get('SELECT status FROM metadata_lookups WHERE title_id=?', [titleId]))?.status).toBe('cooldown');
    expect(await scheduleMetadataEnrichment(db, { limit: 1, backgroundLimit: 1, now: options.now(), titleIds: [titleId] })).toMatchObject({ queued: 0 });
    await options.sleep(121000);
    expect(await scheduleMetadataEnrichment(db, { limit: 1, backgroundLimit: 1, now: options.now(), titleIds: [titleId] })).toMatchObject({ queued: 1 });
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ matched: true, provider: 'tvmaze' });
    expect(calls).toBe(2); expect((await db.get('SELECT status FROM metadata_lookups WHERE title_id=?', [titleId]))?.status).toBe('matched');
    expect((await db.get('SELECT poster FROM titles WHERE id=?', [titleId]))?.poster).toContain('static.tvmaze.com');
  });

  it('uses missing-only licensed results with identity proof and keeps credentials in headers', async () => {
    const titleId = await createTitle(db, { name: 'A Movie', year: 2020 }); let authorization = ''; let query = '';
    const options = harness(async (url, request) => { authorization = request?.headers?.Authorization || ''; query = url; return response(url, { id: '123', name: 'A Movie', type: 'movie', year: 2020, synopsis: 'Sourced description', poster: 'https://art.example/poster.jpg' }); }, { ...config, licensedUrl: 'https://metadata.example/lookup', licensedKey: 'private-test-token' });
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ matched: true, provider: 'licensed' });
    expect(authorization).toBe('Bearer private-test-token'); expect(query).not.toContain('private-test-token');
    expect(JSON.stringify(await db.all('SELECT * FROM metadata_http_cache'))).not.toContain('private-test-token');
  });

  it('uses optional TMDB bearer authentication, filters adult results and validates poster paths', async () => {
    const titleId = await createTitle(db, { name: 'District 9', year: 2009 }); const requests: string[] = []; let authorization = '';
    const options = harness(async (url, request) => {
      requests.push(url); authorization = request?.headers?.Authorization || '';
      return response(url, { total_pages: 1, results: [{ id: 17654, title: 'District 9', original_title: 'District 9', release_date: '2009-08-14', adult: false, overview: 'Sourced film description.', poster_path: '/poster.jpg', backdrop_path: '/backdrop.jpg' }, { id: 77, title: 'District 9', release_date: '2009-08-14', adult: true, poster_path: '/adult.jpg' }] });
    }, { ...config, tmdbToken: 'private-read-token' });
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ matched: true, provider: 'tmdb-movie' });
    expect(authorization).toBe('Bearer private-read-token'); expect(requests[0]).toContain('include_adult=false'); expect(requests[0]).not.toContain('private-read-token');
    expect(await db.get('SELECT poster,backdrop FROM titles WHERE id=?', [titleId])).toMatchObject({ poster: 'https://image.tmdb.org/t/p/w500/poster.jpg', backdrop: 'https://image.tmdb.org/t/p/w1280/backdrop.jpg' });
  });

  it('does not fill another catalog title when the same provider identity is already claimed', async () => {
    const first = await createTitle(db, { name: 'Spooks', type: 'series', year: 2002 }); const second = await createTitle(db, { name: 'Spooks', type: 'series', year: 2002 });
    const options = harness(async url => response(url, [{ show: show() }])); await enrichTitleMetadata(db, first, options);
    expect(await enrichTitleMetadata(db, second, options)).toMatchObject({ matched: false });
    expect(await db.get('SELECT poster,synopsis FROM titles WHERE id=?', [second])).toMatchObject({ poster: '', synopsis: '' });
  });

  it('ignores text and artwork from an article whose Wikidata identity differs from the confirmed film', async () => {
    const titleId = await createTitle(db, { name: 'District 9', year: 2009 }); const original = movieFetcher([]);
    const fetcher: SafeFetcher = async (url, options) => new URL(url).searchParams.get('prop') === 'extracts|pageimages|pageprops' ? response(url, { query: { pages: [{ title: 'Unrelated article', pageprops: { wikibase_item: 'Q999' }, extract: 'Wrong description', pageimage: 'Wrong poster.jpg', thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/en/wrong.jpg' } }] } }) : original(url, options);
    await enrichTitleMetadata(db, titleId, harness(fetcher));
    const title = (await db.get('SELECT poster,synopsis,attribution FROM titles WHERE id=?', [titleId]))!;
    expect(title.poster).toBe(''); expect(title.synopsis).toBe('2009 science fiction film'); expect(title.attribution).not.toContain('Unrelated');
  });

  it('redacts credentials from durable lookup failures and thrown worker errors', async () => {
    const titleId = await createTitle(db, { name: 'Spooks', type: 'series', year: 2002 });
    const options = harness(async () => { throw new Error('Connection refused Authorization: Bearer private-secret https://private.example/url'); });
    await expect(enrichTitleMetadata(db, titleId, options)).rejects.not.toThrow('private-secret');
    const state = (await db.get('SELECT status,error FROM metadata_lookups WHERE title_id=?', [titleId]))!;
    expect(state.status).toBe('failed'); expect(state.error).toContain('Connection refused'); expect(state.error).not.toContain('private-secret'); expect(state.error).not.toContain('private.example');
  });

  it('bounds backfill, prioritizes verified titles ahead of earlier metadata jobs, and respects locks/cooldowns', async () => {
    const now = Date.now(); const verified = await createTitle(db, { name: 'Verified Film', year: 2020 }); await source(verified, true);
    // Reproduce a revision committed after the scheduler captured its timestamp.
    await db.run('UPDATE titles SET updated_at=? WHERE id=?', [now + 1000, verified]);
    const locked = await createTitle(db, { name: 'Locked Film', year: 2020 }); await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,?)', [locked, now]);
    for (let index = 0; index < 10; index++) await createTitle(db, { name: `Background Film ${index}`, year: 2020 });
    await db.run("INSERT INTO jobs(id,type,payload,status,run_after,created_at,dedupe_key) VALUES(?,'metadata',?,'queued',?,?,?)", ['older-job', '{}', now - 1000, now - 1000, 'metadata:older']);
    expect(await scheduleMetadataEnrichment(db, { limit: 4, backgroundLimit: 2, now })).toMatchObject({ queued: 3 });
    const first = (await db.get("SELECT payload FROM jobs WHERE type='metadata' AND status='queued' ORDER BY run_after,created_at LIMIT 1"))!;
    expect(JSON.parse(first.payload).titleId).toBe(verified);
    expect(await db.get('SELECT title_id FROM metadata_lookups WHERE title_id=?', [locked])).toBeUndefined();
    const again = await scheduleMetadataEnrichment(db, { limit: 4, backgroundLimit: 2, now }); expect(again.queued).toBe(2);
    expect((await db.get("SELECT COUNT(*) AS n FROM jobs WHERE dedupe_key=? AND status IN ('queued','running')", [`metadata:${verified}`]))?.n).toBe(1);
  });
});


describe('clean lookup names and English channel identities', () => {
  it('searches the single series name instead of duplicate season text', async () => {
    const titleId = await createTitle(db, { name: 'مدرسة النخبة S01 مدرسة النخبة', type: 'series' });
    const configuration = { ...config, licensedUrl: 'https://metadata.example/lookup', licensedKey: 'fixture-key' };
    const options = harness(async url => {
      expect(new URL(url).searchParams.get('title')).toBe('مدرسة النخبة');
      return response(url, { id: 'fixture-school', name: 'مدرسة النخبة', type: 'series', englishTitle: 'Verified School Title' });
    }, configuration);
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ matched: true });
    expect((await db.get('SELECT name FROM titles WHERE id=?', [titleId]))?.name).toBe('Verified School Title');
    expect((await db.all('SELECT name FROM title_aliases WHERE title_id=?', [titleId])).map(row => row.name)).toContain('مدرسة النخبة');
  });

  it('queues and resolves a live channel from an exact Arabic label and verified channel type', async () => {
    const titleId = await createTitle(db, { name: 'الجزيرة HD', type: 'live' }); await source(titleId, true);
    expect(await scheduleMetadataEnrichment(db, { titleIds: [titleId], limit: 1, backgroundLimit: 0 })).toMatchObject({ queued: 1 });
    const fetcher: SafeFetcher = async url => {
      const parsed = new URL(url); expect(parsed.hostname).toBe('www.wikidata.org');
      if (parsed.searchParams.get('action') === 'wbsearchentities') { expect(parsed.searchParams.get('search')).toBe('الجزيرة'); return response(url, { search: [{ id: 'Q13477' }] }); }
      return response(url, { entities: { Q13477: { id: 'Q13477', labels: { ar: { value: 'الجزيرة' }, en: { value: 'Al Jazeera' } }, claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q1616075' } } } }] } } } });
    };
    // Configured TMDB must not route a live channel through movie/series lookup.
    expect(await enrichTitleMetadata(db, titleId, harness(fetcher, { ...config, tmdbKey: 'fixture-key' }))).toMatchObject({ matched: true, provider: 'wikidata' });
    expect((await db.get('SELECT name FROM titles WHERE id=?', [titleId]))?.name).toBe('Al Jazeera');
  });

  it('verifies a localized TMDB search result before fetching its English name', async () => {
    const titleId = await createTitle(db, { name: 'اسم مترجم', type: 'series', year: 2020 }); const languages: string[] = [];
    const options = harness(async url => {
      const parsed = new URL(url); const language = parsed.searchParams.get('language'); languages.push(language || '');
      const data = { id: 99, name: language === 'ar' ? 'اسم مترجم' : 'English Release Name', original_name: 'Nombre original', first_air_date: '2020-01-01', overview: 'Description' };
      return response(url, parsed.pathname.includes('/search/') ? { results: [data], total_pages: 1 } : data);
    }, { ...config, tmdbToken: 'fixture-key' });
    expect(await enrichTitleMetadata(db, titleId, options)).toMatchObject({ matched: true });
    expect(languages).toEqual(['en-US', 'ar', 'en-US']);
    expect((await db.get('SELECT name FROM titles WHERE id=?', [titleId]))?.name).toBe('English Release Name');
  });

  it('does not give a channel the English name of a same-named film', async () => {
    const titleId = await createTitle(db, { name: 'قناة', type: 'live' });
    const fetcher: SafeFetcher = async url => {
      const parsed = new URL(url);
      if (parsed.searchParams.get('action') === 'wbsearchentities') return response(url, { search: [{ id: 'Q700' }] });
      if (parsed.searchParams.get('ids') !== 'Q700') return response(url, { entities: { Q11424: { claims: {} } } });
      return response(url, { entities: { Q700: { id: 'Q700', labels: { ar: { value: 'قناة' }, en: { value: 'A Film' } }, claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q11424' } } } }] } } } });
    };
    expect(await enrichTitleMetadata(db, titleId, harness(fetcher))).toMatchObject({ matched: false });
    expect((await db.get('SELECT name FROM titles WHERE id=?', [titleId]))?.name).toBe('قناة');
  });

  it('uses a verified saved IMDb identity when localized aliases are missing, rechecking the actual claim', async () => {
    const claim = (value: unknown) => [{ mainsnak: { datavalue: { value } } }];
    for (const matches of [true, false]) {
      const titleId = await createTitle(db, { name: 'اسم محلي', year: 2009 });
      await db.run('INSERT INTO metadata_identifiers(id,title_id,provider,external_id) VALUES(?,?,?,?)', [id(), titleId, 'imdb', matches ? 'tt001' : 'tt002']);
      const fetcher: SafeFetcher = async url => {
        const parsed = new URL(url);
        if (parsed.searchParams.get('list') === 'search') return response(url, { query: { search: [{ title: matches ? 'Q801' : 'Q802' }] } });
        const entityId = matches ? 'Q801' : 'Q802';
        return response(url, { entities: { [entityId]: { id: entityId, labels: { en: { value: 'Verified English Name' } }, claims: { P31: claim({ id: 'Q11424' }), P345: claim(matches ? 'tt001' : 'ttWrong'), P577: claim({ time: '+2009-01-01T00:00:00Z' }) } } } });
      };
      expect(await enrichTitleMetadata(db, titleId, harness(fetcher))).toMatchObject({ matched: matches });
      expect((await db.get('SELECT name FROM titles WHERE id=?', [titleId]))?.name).toBe(matches ? 'Verified English Name' : 'اسم محلي');
    }
  });

  it('rechecks an older English-title policy, prioritizes visible foreign labels, and preserves a current no-match cooldown', async () => {
    const now = Date.now();
    const foreign = await createTitle(db, { name: 'عنوان', type: 'live' }); await source(foreign, true);
    const english = await createTitle(db, { name: 'New Channel', type: 'live' }); await source(english, true);
    await db.run('UPDATE titles SET poster=?,backdrop=?,synopsis=?,created_at=? WHERE id=?', ['poster', 'banner', 'description', now - 10000, foreign]);
    await db.run('INSERT INTO metadata_lookups(title_id,identity_hash,status,checked_at,retry_after,result) VALUES(?,?,?,?,?,?)', [foreign, 'old-fingerprint', 'matched', now, now + 86400000, JSON.stringify({ enrichmentVersion: 2, displayTitleChecked: true })]);
    expect(await scheduleMetadataEnrichment(db, { limit: 1, backgroundLimit: 0, now })).toMatchObject({ queued: 1 });
    expect(JSON.parse((await db.get("SELECT payload FROM jobs WHERE type='metadata'"))!.payload).titleId).toBe(foreign);
    await db.run('DELETE FROM jobs');
    const options = harness(async url => response(url, { search: [] }));
    expect(await enrichTitleMetadata(db, foreign, options)).toMatchObject({ matched: false });
    expect(await scheduleMetadataEnrichment(db, { titleIds: [foreign], limit: 1, backgroundLimit: 0, now: options.now() })).toMatchObject({ queued: 0 });
  });
});
