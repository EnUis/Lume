import { normalizeTitle } from './m3u';
import { validateBrowserSafeUrl } from './outbound';
import { normalizeLanguage } from '../languages';

export interface MetadataIdentity { name: string; type: 'movie' | 'series' | 'live'; year: number | null; aliases: string[]; identifiers: Record<string, string>; languages?: string[]; needs?: { poster: boolean; backdrop: boolean; synopsis: boolean } }
export interface MetadataMatch { provider: string; providerId: string; englishTitle?: string; aliases?: string[]; lookupLanguage?: string; lookupImdb?: string; synopsis?: string; poster?: string; backdrop?: string; genres?: string[]; cast?: string[]; director?: string; attribution: string }
export interface MetadataConfiguration { enabled: boolean; licensedUrl?: string; licensedKey?: string; tmdbToken?: string; tmdbKey?: string; language: string; userAgent?: string }
type RequestMetadata = (provider: string, url: string, headers?: Record<string, string>, ttlMs?: number) => Promise<any>;
export function metadataConfiguration(): MetadataConfiguration {
  return { enabled: process.env.METADATA_AUTO_ENRICH !== 'false', licensedUrl: process.env.METADATA_PROVIDER_URL || undefined, licensedKey: process.env.METADATA_API_KEY || undefined, tmdbToken: process.env.TMDB_READ_ACCESS_TOKEN || undefined, tmdbKey: process.env.TMDB_API_KEY || undefined, language: /^[a-z]{2}(?:-[A-Z]{2})?$/.test(process.env.METADATA_LANGUAGE || '') ? process.env.METADATA_LANGUAGE! : 'en', userAgent: process.env.METADATA_USER_AGENT };
}
export function metadataText(value: unknown, maxWords = 140) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|quot|apos|lt|gt);/g, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }[entity] || '')).replace(/&#(x[\da-f]+|\d+);/gi, (_, raw: string) => { const number = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw); return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : ''; }).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text.split(' '); return words.length > maxWords ? words.slice(0, maxWords).join(' ') + '…' : text;
}
export function metadataImage(value: unknown, hosts?: string[]) {
  if (typeof value !== 'string' || value.length > 2000) return '';
  try { const url = validateBrowserSafeUrl(value); if (url.protocol !== 'https:' || hosts && !hosts.includes(url.hostname.toLowerCase())) return ''; return url.toString(); } catch { return ''; }
}
export function explicitAdultMetadata(value: string) {
  return /(?:^|[\[({|:])\s*(?:adult|xxx|porn|18\+)\s*(?:[\])}|:]|[|:.-])|\b(?:pornographic|pornhub|brazzers|onlyfans|xvideos)\b/i.test(value) || /^(?:adult|xxx|porn)\s*[|:.-]/i.test(value);
}
/** A provider must explicitly identify the label as English; this only validates its shape. */
export function englishDisplayTitle(value: unknown) {
  if (typeof value !== 'string' || value.length > 200 || /[<>\u0000-\u001f\u007f]/.test(value)) return '';
  const title = value.trim().replace(/\s+/g, ' ');
  // English release names can retain accents, punctuation and numeric titles.
  return title && !(title.match(/\p{Letter}/gu) || []).some(letter => !/\p{Script=Latin}/u.test(letter)) ? title : '';
}
export function titleSearchLanguage(value: string, fallback = 'en') {
  for (const [script, code] of [['Arabic', 'ar'], ['Hebrew', 'he'], ['Devanagari', 'hi'], ['Cyrillic', 'ru'], ['Hangul', 'ko'], ['Hiragana', 'ja'], ['Katakana', 'ja'], ['Han', 'zh'], ['Greek', 'el']] as const) if (new RegExp(`\\p{Script=${script}}`, 'u').test(value)) return code;
  return fallback;
}
function metadataNames(identity: MetadataIdentity) { return [...new Set([identity.name, ...identity.aliases].filter(Boolean))].slice(0, 3); }
function boundCandidate<T extends { id: string | number; year: number | null }>(identity: MetadataIdentity, known: string | undefined, candidates: T[]) {
  if (!known) return null;
  const matches = candidates.filter(candidate => String(candidate.id) === known && (identity.year === null || candidate.year === identity.year));
  return matches.length === 1 ? matches[0] : null;
}
function exactName(identity: MetadataIdentity, names: unknown[]) {
  const expected = new Set([identity.name, ...identity.aliases].map(normalizeTitle).filter(Boolean));
  return names.some(name => typeof name === 'string' && expected.has(normalizeTitle(name)));
}
function yearOf(value: unknown) { const match = typeof value === 'string' && value.match(/^(\d{4})-/); return match ? Number(match[1]) : null; }
export function chooseMetadataCandidate<T extends { id: string | number; names: unknown[]; year: number | null }>(identity: MetadataIdentity, candidates: T[]): T | null {
  const exact = candidates.filter(candidate => exactName(identity, candidate.names) && (identity.year === null || candidate.year === identity.year));
  const unique = [...new Map(exact.map(candidate => [String(candidate.id), candidate])).values()]; return unique.length === 1 ? unique[0] : null;
}
const wikiUrl = (host: string, params: Record<string, string>) => { const url = new URL(`https://${host}/w/api.php`); url.search = new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params }).toString(); return url.toString(); };
const claims = (entity: any, property: string): any[] => (entity?.claims?.[property] || []).filter((claim: any) => claim.rank !== 'deprecated').map((claim: any) => claim.mainsnak?.datavalue?.value).filter((value: any) => value !== undefined);

async function tvmaze(identity: MetadataIdentity, request: RequestMetadata): Promise<MetadataMatch | null> {
  const known = identity.identifiers.tvmaze;
  const shows: any[] = [];
  for (const name of known ? [identity.name] : metadataNames(identity)) {
    const data = await request('tvmaze', known && /^\d+$/.test(known) ? `https://api.tvmaze.com/shows/${known}` : `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(name)}`);
    shows.push(...(known ? [data] : Array.isArray(data) ? data.map(row => row.show) : []));
  }
  const rows = [...new Map(shows.filter(show => show && Number.isInteger(show.id)).map(show => [show.id, show])).values()].map(show => ({ id: show.id, names: [show.name], year: yearOf(show.premiered), show }));
  const candidate = boundCandidate(identity, known, rows) || (!known ? chooseMetadataCandidate(identity, rows) : null);
  if (!candidate) return null;
  const show = candidate.show;
  if (identity.identifiers.imdb && show.externals?.imdb !== identity.identifiers.imdb) return null;
  let poster = metadataImage(show.image?.original || show.image?.medium, ['static.tvmaze.com']), backdrop = '';
  if (identity.needs?.backdrop || identity.needs?.poster && !poster) {
    const images = await request('tvmaze', `https://api.tvmaze.com/shows/${show.id}/images`);
    const artwork = Array.isArray(images) ? images : [];
    const selectImage = (type: string) => artwork.filter(image => image?.type === type).sort((a, b) => Number(!!b.main) - Number(!!a.main)).map(image => metadataImage(image.resolutions?.original?.url || image.resolutions?.medium?.url, ['static.tvmaze.com'])).find(Boolean) || '';
    poster ||= selectImage('poster'); backdrop = selectImage('background') || selectImage('banner');
  }
  // TVmaze show.name does not promise an English translation for foreign shows.
  return { provider: 'tvmaze', providerId: String(show.id), aliases: [show.name], lookupLanguage: normalizeLanguage(show.language) || undefined, lookupImdb: /^tt\d+$/.test(show.externals?.imdb || '') ? show.externals.imdb : undefined, synopsis: metadataText(show.summary), poster, backdrop, genres: Array.isArray(show.genres) ? show.genres.filter((genre: unknown) => typeof genre === 'string').slice(0, 20) : [], attribution: `TVmaze · https://www.tvmaze.com/shows/${show.id} · CC BY-SA` };
}

async function tmdb(identity: MetadataIdentity, request: RequestMetadata, config: MetadataConfiguration): Promise<MetadataMatch | null> {
  const kind = identity.type === 'movie' ? 'movie' : 'tv'; const known = identity.identifiers[`tmdb-${identity.type}`];
  const url = new URL(`https://api.themoviedb.org/3/${known && /^\d+$/.test(known) ? `${kind}/${known}` : `search/${kind}`}`);
  url.searchParams.set('language', config.language === 'en' ? 'en-US' : config.language); url.searchParams.set('include_adult', 'false');
  if (!known) { url.searchParams.set('query', identity.name); if (identity.year) url.searchParams.set(kind === 'movie' ? 'year' : 'first_air_date_year', String(identity.year)); }
  if (!config.tmdbToken && config.tmdbKey) url.searchParams.set('api_key', config.tmdbKey);
  const headers: Record<string, string> = config.tmdbToken ? { Authorization: `Bearer ${config.tmdbToken}` } : {};
  let lookupLanguage = url.searchParams.get('language') || 'en-US';
  const select = (data: any) => {
    const rows: any[] = known ? [data] : Array.isArray(data.results) ? data.results : [];
    // A truncated search page cannot prove that an unknown-year identity is unique.
    if (!known && identity.year === null && Number(data.total_pages) > 1) return null;
    const candidates = rows.filter(row => row && !row.adult && Number.isInteger(row.id)).map(row => ({ id: row.id, names: [row.title, row.original_title, row.name, row.original_name], year: yearOf(kind === 'movie' ? row.release_date : row.first_air_date), row }));
    return boundCandidate(identity, known, candidates) || (!known ? chooseMetadataCandidate(identity, candidates) : null);
  };
  let match = select(await request('tmdb', url.toString(), headers));
  const searchLanguage = titleSearchLanguage(identity.name, identity.languages?.[0] || 'en');
  if (!match && !known && searchLanguage !== lookupLanguage.slice(0, 2)) {
    // Arabic/localized distributor titles may exist only in that locale, while
    // en-US search returns English/original-language names. Verify locally first.
    url.searchParams.set('language', searchLanguage); lookupLanguage = searchLanguage;
    match = select(await request('tmdb', url.toString(), headers));
  }
  if (!match) return null;
  if (identity.identifiers.imdb) {
    const detail = new URL(`https://api.themoviedb.org/3/${kind}/${match.id}`); detail.searchParams.set('append_to_response', 'external_ids');
    if (!config.tmdbToken && config.tmdbKey) detail.searchParams.set('api_key', config.tmdbKey);
    const verified = await request('tmdb', detail.toString(), config.tmdbToken ? { Authorization: `Bearer ${config.tmdbToken}` } : {});
    if ((verified.imdb_id || verified.external_ids?.imdb_id) !== identity.identifiers.imdb) return null;
  }
  let englishRow = lookupLanguage.slice(0, 2) === 'en' ? match.row : null;
  if (!englishRow) {
    const englishUrl = new URL(`https://api.themoviedb.org/3/${kind}/${match.id}`); englishUrl.searchParams.set('language', 'en-US');
    if (!config.tmdbToken && config.tmdbKey) englishUrl.searchParams.set('api_key', config.tmdbKey);
    const detail = await request('tmdb', englishUrl.toString(), config.tmdbToken ? { Authorization: `Bearer ${config.tmdbToken}` } : {});
    if (detail.id === match.id && !detail.adult && (identity.year === null || yearOf(kind === 'movie' ? detail.release_date : detail.first_air_date) === identity.year)) englishRow = detail;
  }
  const image = (path: unknown, size: string) => typeof path === 'string' && /^\/[a-z\d._-]+\.(?:jpe?g|png|webp)$/i.test(path) ? `https://image.tmdb.org/t/p/${size}${path}` : '';
  return { provider: `tmdb-${identity.type}`, providerId: String(match.id), englishTitle: englishDisplayTitle(englishRow?.[kind === 'movie' ? 'title' : 'name']), aliases: [match.row.title, match.row.original_title, match.row.name, match.row.original_name].filter((name: unknown): name is string => typeof name === 'string'), synopsis: metadataText(match.row.overview), poster: image(match.row.poster_path, 'w500') || image(englishRow?.poster_path, 'w500'), backdrop: image(match.row.backdrop_path, 'w1280') || image(englishRow?.backdrop_path, 'w1280'), attribution: `TMDB · https://www.themoviedb.org/${kind}/${match.id} · This product uses the TMDB API but is not endorsed or certified by TMDB.` };
}

async function wikimedia(identity: MetadataIdentity, request: RequestMetadata, config: MetadataConfiguration): Promise<MetadataMatch | null> {
  let ids: string[]; const known = identity.identifiers.wikidata;
  const imdb = /^tt\d+$/.test(identity.identifiers.imdb || '') ? identity.identifiers.imdb : undefined;
  if (known && /^Q\d+$/.test(known)) ids = [known];
  else if (imdb) {
    // Resolve a saved/confirmed IMDb identity even when a distributor's local
    // spelling is absent from Wikidata's labels. The claim is checked again below.
    const search = await request('wikimedia', wikiUrl('www.wikidata.org', { action: 'query', list: 'search', srnamespace: '0', srsearch: `haswbstatement:"P345=${imdb}"`, srlimit: '10', srprop: '' }));
    if (search.continue) return null;
    ids = [...new Set<string>((search.query?.search || []).map((row: any) => row.title).filter((value: unknown) => typeof value === 'string' && /^Q\d+$/.test(value)))];
  } else {
    ids = [];
    for (const name of metadataNames(identity)) {
      const search = await request('wikimedia', wikiUrl('www.wikidata.org', { action: 'wbsearchentities', search: name, language: titleSearchLanguage(name, identity.languages?.[0] || config.language.slice(0, 2)), type: 'item', limit: '10' }));
      // Search pagination means another exact-name remake might be outside this page.
      if (identity.year === null && search['search-continue']) return null;
      ids.push(...(Array.isArray(search.search) ? search.search : []).map((row: any) => row.id).filter((value: unknown) => typeof value === 'string' && /^Q\d+$/.test(value)).slice(0, 10));
    }
    ids = [...new Set(ids)];
  }
  if (!ids.length) return null;
  const language = config.language.slice(0, 2); const languages = [...new Set([language, ...(identity.languages || []), titleSearchLanguage(identity.name), ...identity.aliases.map(name => titleSearchLanguage(name)), 'en', 'ar', 'fa', 'he', 'hi', 'uk', 'el', 'de', 'hu', 'fr', 'es', 'it', 'tr', 'pl', 'pt', 'ru', 'nl', 'ja', 'ko', 'zh'])].join('|');
  const response = await request('wikimedia', wikiUrl('www.wikidata.org', { action: 'wbgetentities', ids: ids.join('|'), props: 'labels|aliases|descriptions|claims|sitelinks', languages }));
  const entities: any[] = Object.values(response.entities || {});
  const baseTypes = new Set(identity.type === 'movie' ? ['Q11424'] : identity.type === 'live' ? ['Q2001305', 'Q1616075', 'Q1254874'] : ['Q5398426']); const parents = new Map<string, string[]>();
  let frontier: string[] = [...new Set<string>(entities.flatMap(entity => claims(entity, 'P31').map(value => value.id)).filter(Boolean))];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const candidates = frontier.filter(value => !baseTypes.has(value) && !parents.has(value)).slice(0, 30); if (!candidates.length) break;
    const types = await request('wikimedia', wikiUrl('www.wikidata.org', { action: 'wbgetentities', ids: candidates.join('|'), props: 'claims' }));
    frontier = [];
    for (const [key, entity] of Object.entries<any>(types.entities || {})) { const values = claims(entity, 'P279').map(value => value.id).filter(Boolean); parents.set(key, values); frontier.push(...values); }
  }
  const isType = (value: string, seen = new Set<string>()): boolean => { if (baseTypes.has(value)) return true; if (seen.has(value)) return false; seen.add(value); return (parents.get(value) || []).some(parent => isType(parent, seen)); };
  const candidates = entities.filter(entity => claims(entity, 'P31').some(value => isType(value.id))).map(entity => {
    const names = [...Object.values<any>(entity.labels || {}).map(label => label.value), ...Object.values<any[]>(entity.aliases || {}).flat().map(alias => alias.value)];
    const years = [...new Set<number>([...claims(entity, 'P577'), ...(identity.type !== 'movie' ? [...claims(entity, 'P580'), ...claims(entity, 'P571')] : [])].map(value => Number(value.time?.match(/^\+(\d{4})-/)?.[1])).filter(year => Number.isInteger(year) && year > 1800 && year < 2200))];
    return { id: entity.id, names, year: identity.year !== null && years.includes(identity.year) ? identity.year : years.length ? Math.min(...years) : null, entity };
  });
  const boundImdb = imdb ? candidates.filter(candidate => claims(candidate.entity, 'P345').includes(imdb) && (identity.year === null || candidate.year === identity.year)) : [];
  const selected = known ? boundCandidate(identity, known, candidates) : imdb ? boundImdb.length === 1 ? boundImdb[0] : null : chooseMetadataCandidate(identity, candidates);
  if (!selected) return null; const entity = selected.entity;
  if (identity.identifiers.imdb && !claims(entity, 'P345').includes(identity.identifiers.imdb)) return null;
  const credits = [`Wikidata · https://www.wikidata.org/wiki/${entity.id} · CC0`];
  let synopsis = metadataText(entity.descriptions?.[language]?.value || entity.descriptions?.en?.value); let poster = '', backdrop = '';
  const article = entity.sitelinks?.[`${language}wiki`]?.title || entity.sitelinks?.enwiki?.title;
  const articleLanguage = entity.sitelinks?.[`${language}wiki`]?.title ? language : 'en';
  if (article) {
    const pageData = await request('wikimedia', wikiUrl(`${articleLanguage}.wikipedia.org`, { action: 'query', titles: article, prop: 'extracts|pageimages|pageprops', exintro: '1', explaintext: '1', exsentences: '5', piprop: 'thumbnail|name', pithumbsize: '600', pilicense: 'any', redirects: '1' }));
    const page = (pageData.query?.pages || []).find((value: any) => value.pageprops?.wikibase_item === entity.id && !Object.prototype.hasOwnProperty.call(value.pageprops, 'disambiguation'));
    if (page) {
      const extracted = metadataText(page.extract); if (extracted) { synopsis = extracted; credits.push(`Wikipedia · https://${articleLanguage}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))} · CC BY-SA 4.0`); }
      const artwork = metadataImage(page.thumbnail?.source, ['upload.wikimedia.org']);
      // Pageimages is bound to this confirmed article, rather than image-search guesses.
      if (identity.needs?.poster !== false && artwork && page.pageimage) {
        const info = await request('wikimedia', wikiUrl(`${articleLanguage}.wikipedia.org`, { action: 'query', titles: `File:${page.pageimage}`, prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiextmetadatalanguage: 'en' }));
        const image = (info.query?.pages || []).flatMap((value: any) => value.imageinfo || [])[0];
        if (image && /^image\/(?:jpeg|png|webp|gif)$/.test(image.mime || '')) {
          poster = artwork; const license = metadataText(image.extmetadata?.LicenseShortName?.value || 'See source image rights', 12); const artist = metadataText(image.extmetadata?.Artist?.value, 24);
          const source = metadataImage(image.descriptionurl) || `https://${articleLanguage}.wikipedia.org/wiki/File:${encodeURIComponent(page.pageimage)}`;
          credits.push(`Artwork · ${source} · ${license}${artist ? ` · ${artist}` : ''}`);
        }
      }
    }
  }
  if (!poster && identity.needs?.poster !== false) {
    // Channel logos use P154; film posters use P3383 rather than generic stills.
    const filename = claims(entity, identity.type === 'live' ? 'P154' : 'P3383').find(value => typeof value === 'string');
    if (filename) {
      const info = await request('wikimedia', wikiUrl('commons.wikimedia.org', { action: 'query', titles: `File:${filename}`, prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: '600', iiextmetadatalanguage: 'en' }));
      const image = (info.query?.pages || []).flatMap((value: any) => value.imageinfo || [])[0];
      if (image && /^image\/(?:jpeg|png|webp|gif)$/.test(image.mime || '')) {
        const license = metadataText(image.extmetadata?.LicenseShortName?.value, 12);
        if (/^(?:CC0|CC BY(?:-SA)?(?: [\d.]+)?|Public domain|PD)/i.test(license)) {
          poster = metadataImage(image.thumburl || image.url, ['upload.wikimedia.org']);
          if (poster) credits.push(`Artwork · https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename.replace(/ /g, '_'))} · ${license} · ${metadataText(image.extmetadata?.Artist?.value, 24)}`);
        }
      }
    }
  }
  if (identity.needs?.backdrop) {
    // A work's structured P18 image may be a landscape still; dimensions and
    // explicit reusable rights prevent treating a portrait/unknown photo as a banner.
    const filename = claims(entity, 'P18').find(value => typeof value === 'string');
    if (filename) {
      const info = await request('wikimedia', wikiUrl('commons.wikimedia.org', { action: 'query', titles: `File:${filename}`, prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: '1280', iiextmetadatalanguage: 'en' }));
      const image = (info.query?.pages || []).flatMap((value: any) => value.imageinfo || [])[0];
      const license = metadataText(image?.extmetadata?.LicenseShortName?.value, 12);
      if (image && /^image\/(?:jpeg|png|webp)$/.test(image.mime || '') && Number(image.width) > 0 && Number(image.height) > 0 && Number(image.width) / Number(image.height) >= 1.3 && /^(?:CC0|CC BY(?:-SA)?(?: [\d.]+)?|Public domain|PD)/i.test(license)) {
        backdrop = metadataImage(image.thumburl || image.url, ['upload.wikimedia.org']);
        if (backdrop) credits.push(`Artwork · https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename.replace(/ /g, '_'))} · ${license} · ${metadataText(image.extmetadata?.Artist?.value, 24)}`);
      }
    }
  }
  return { provider: 'wikidata', providerId: entity.id, englishTitle: englishDisplayTitle(entity.labels?.en?.value), aliases: [...new Set<string>([...Object.values<any>(entity.labels || {}).map(label => label.value), ...Object.values<any[]>(entity.aliases || {}).flat().map(alias => alias.value)].filter((name): name is string => typeof name === 'string'))].slice(0, 30), synopsis, poster, backdrop, attribution: credits.join('; ') };
}

export async function findMetadata(identity: MetadataIdentity, request: RequestMetadata, config: MetadataConfiguration): Promise<MetadataMatch | null> {
  if (config.licensedUrl && config.licensedKey) {
    const url = new URL(config.licensedUrl); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Licensed metadata provider requires an HTTPS URL without credentials');
    url.searchParams.set('title', identity.name); url.searchParams.set('type', identity.type); if (identity.year) url.searchParams.set('year', String(identity.year));
    const data = await request('licensed', url.toString(), { Authorization: `Bearer ${config.licensedKey}` });
    if (data.type !== identity.type || !chooseMetadataCandidate(identity, [{ id: data.id || 'result', names: [data.name, data.title], year: Number.isInteger(data.year) ? data.year : null }])) return null;
    return { provider: 'licensed', providerId: String(data.id || `${identity.type}:${normalizeTitle(identity.name)}:${identity.year || ''}`), englishTitle: englishDisplayTitle(data.englishTitle), aliases: [data.name, data.title, ...(Array.isArray(data.aliases) ? data.aliases : [])].filter((name): name is string => typeof name === 'string').slice(0, 30), synopsis: metadataText(data.synopsis), poster: metadataImage(data.poster), backdrop: metadataImage(data.backdrop), genres: Array.isArray(data.genres) ? data.genres.filter((value: unknown) => typeof value === 'string').slice(0, 20) : [], cast: Array.isArray(data.cast) ? data.cast.filter((value: unknown) => typeof value === 'string').slice(0, 50) : [], director: metadataText(data.director, 12), attribution: metadataText(data.attribution || 'Configured licensed metadata provider', 80) };
  }
  // Movie/series APIs have no television-channel identity model.
  if (identity.type === 'live') return wikimedia(identity, request, config);
  if (config.tmdbToken || config.tmdbKey) return tmdb(identity, request, config);
  if (identity.type === 'series') {
    const show = await tvmaze(identity, request);
    if (show) {
      if (!englishDisplayTitle(identity.name) || show.lookupLanguage && show.lookupLanguage !== 'en' || identity.languages?.some(language => language !== 'en')) {
        const localized = await wikimedia({ ...identity, identifiers: { ...identity.identifiers, ...(show.lookupImdb ? { imdb: show.lookupImdb } : {}) }, languages: [...new Set([...(identity.languages || []), ...(show.lookupLanguage ? [show.lookupLanguage] : [])])] }, request, config);
        if (localized?.englishTitle) return { ...localized, synopsis: localized.synopsis || show.synopsis, poster: localized.poster || show.poster, backdrop: localized.backdrop || show.backdrop, genres: show.genres, aliases: [...new Set([...(localized.aliases || []), ...(show.aliases || [])])], attribution: `${localized.attribution}; ${show.attribution}` };
      }
      return show;
    }
  }
  return wikimedia(identity, request, config);
}
