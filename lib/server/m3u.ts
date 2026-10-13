import type { ContentType, Source } from '../types';
import { hash } from './security';
import { validateSourceUrl } from './outbound';
import { extractLanguageTags, normalizeLanguage } from '../languages';

// Persisted in snapshot reports: identical bytes must be reprocessed after parser changes.
export const M3U_IMPORT_VERSION = 10;

export interface PlaylistEntry {
  name: string; title: string; normalized: string; year: number | null; type: ContentType;
  season: number | null; episode: number | null; episodeName: string; url: string;
  attributes: Record<string, string>; poster: string; group: string; format: Source['format'];
  key: string; ambiguous: boolean; language: string | null; languageExplicit: boolean; decorated?: boolean; externalId?: { provider: string; id: string };
}
export interface CleanMediaTitle { title: string; year: number | null; language: string | null; languageExplicit: boolean; decorated: boolean }
const qualityTag = /^(?:2160p?|1080[pi]?|720p?|576p?|480p?|360p?|4k|8k|uhd|fhd|shd|hd|sd|hdr10?\+?|dolby[ ._-]?vision|dv|hevc|h[ ._-]?26[45]|x26[45]|av1|web[ ._-]?dl|web[ ._-]?rip|blu[ ._-]?ray|b[dr]rip|dvdrip|remux|aac(?:[ ._-]?[257]\.1)?|ac3|eac3|ddp?(?:[ ._-]?[257]\.1)?|dts(?:[ ._-]?hd)?|atmos|hls|dash|mp4|mkv|avi)$/i;
const subtitleTag = /^(?:(?:multi|dual)[ ._-]?sub(?:s|titles)?|sub(?:s|bed|titles)?|vost(?:fr)?|closed[ ._-]?captions|cc)$/i;
const providerTag = /^(?:netflix|amazon(?:[ ._-]?prime)?|prime[ ._-]?video|disney\+?|disney[ ._-]?plus|apple[ ._-]?tv\+?|hbo(?:[ ._-]?max)?|paramount\+?|paramount[ ._-]?plus|hulu|peacock|sky|now[ ._-]?tv|vod|movies?|films?|series|tv[ ._-]?series|vip|premium|provider|iptv|x|fibra[ ._-]?top)$/i;
function languageTag(value: string) { return ({ US: 'en', GB: 'en', UK: 'en', BR: 'pt' } as Record<string, string>)[value.trim()] || normalizeLanguage(value); }
/** Remove explicit edge metadata, never arbitrary brackets or ordinary title words. */
export function cleanMediaTitle(name: string, attributes: Record<string, string> = {}, extractYear = true): CleanMediaTitle {
  let title = name.trim().replace(/\s+/g, ' '); let year: number | null = null, decorated = false;
  const found = new Set<string>(); let languageExplicit = false;
  const attributeLanguage = ['audio-language', 'tvg-language', 'lang', 'language'].map(key => normalizeLanguage(attributes[key])).find(Boolean) || null;
  const providers = new Set(['provider', 'provider-name', 'tvg-provider', 'service-name'].map(key => attributes[key]?.trim().toLowerCase()).filter(Boolean));
  const classify = (tag: string): { languages: string[]; decorated: boolean } | null => {
    tag = tag.trim().replace(/^[\s\p{S}\p{P}]+|[\s\p{S}\p{P}]+$/gu, ''); if (subtitleTag.test(tag)) return { languages: [], decorated: true };
    const language = languageTag(tag); if (language) return { languages: [language], decorated: false };
    if (qualityTag.test(tag) || providerTag.test(tag) || /^(?:free\s+)?iptv\s+world$/i.test(tag) || providers.has(tag.toLowerCase()) || /^(?:provider|source|server|platform)\s*[:=]\s*\S.+$/i.test(tag) || /^[a-z\d.-]+\.(?:com|net|org|tv|io|me|eu|vip)$/i.test(tag)) return { languages: [], decorated: true };
    const parts = tag.split(/[|┃│¦｜║,;/+_-]|\s+/).filter(Boolean);
    if (parts.length < 2) return null;
    const result = { languages: [] as string[], decorated: false };
    for (const part of parts) { const code = languageTag(part); if (code) result.languages.push(code); else if (qualityTag.test(part) || subtitleTag.test(part) || providerTag.test(part) || /^(?:web|dl|rip|dub|dubbed|audio)$/i.test(part)) result.decorated = true; else return null; }
    // A subtitle label describes captions, not the audio track.
    if (/(?:^|[\s|┃│¦｜║,;/+_-])sub(?:s|titles)?(?:$|[\s|┃│¦｜║,;/+_-])/i.test(tag) && !/(?:^|[\s|┃│¦｜║,;/+_-])(?:audio|dub|dubbed)(?:$|[\s|┃│¦｜║,;/+_-])/i.test(tag)) result.languages = [];
    return result;
  };
  const meaningful = (value: string) => !!value.replace(/[\[(](?:19|20)\d{2}[\])]/g, '').replace(/^[\s|┃│¦｜║:.-]+|[\s|┃│¦｜║:.-]+$/g, '').trim();
  for (let pass = 0; pass < 24; pass++) {
    let changed = false;
    const withoutEmpty = title.replace(/^(?:(?:\(\s*\)|\[\s*\]|\{\s*\})\s*)+|(?:\s*(?:\(\s*\)|\[\s*\]|\{\s*\}))+$/gu, '').trim();
    if (withoutEmpty !== title && meaningful(withoutEmpty)) { title = withoutEmpty; decorated = true; continue; }
    const wrappers = [title.match(/^(?:\[([^\[\]]+)\]|\(([^()]+)\)|\{([^{}]+)\}|[|┃│¦｜║]([^|┃│¦｜║]+)[|┃│¦｜║])\s*/u), title.match(/\s*(?:\[([^\[\]]+)\]|\(([^()]+)\)|\{([^{}]+)\}|[|┃│¦｜║]([^|┃│¦｜║]+)[|┃│¦｜║])$/u)];
    const separated = [title.match(/^(.{1,100}?)(?:\s*[|┃│¦｜║:]\s*|\s+-\s+)/u), title.match(/(?:\s*[|┃│¦｜║:]\s*|\s+-\s+)(.{1,100}?)$/u)];
    for (const [matches, wrapped] of [[wrappers, true], [separated, false]] as const) {
      for (let side = 0; side < 2; side++) {
        const match = matches[side]; if (!match) continue;
        const tag = match.slice(1).find(Boolean)!; const metadata = classify(tag); if (!metadata) continue;
        // Single-letter distribution badges are removed only inside explicit wrappers.
        if (!wrapped && /^x$/i.test(tag)) continue;
        const remaining = (side === 0 ? title.slice(match[0].length) : title.slice(0, match.index)).replace(/^[\s|┃│¦｜║:.-]+|[\s|┃│¦｜║:.-]+$/g, '').trim();
        if (!meaningful(remaining)) continue;
        for (const code of metadata.languages) found.add(code); languageExplicit ||= metadata.languages.length > 0; decorated ||= metadata.decorated;
        title = remaining; changed = true; break;
      }
      if (changed) break;
    }
    if (changed) continue;
    const language = extractLanguageTags(title, attributes);
    if (language.title !== title) { title = language.title; if (language.language) found.add(language.language); languageExplicit ||= language.explicit; continue; }
    const edgeQuality = title.match(/^(\S+)\s+/u) || null; const endQuality = title.match(/\s+(\S+)$/u);
    for (const [match, prefix] of [[edgeQuality, true], [endQuality, false]] as const) if (match && qualityTag.test(match[1]) && !/^\d+$/.test(match[1])) {
      const remaining = (prefix ? title.slice(match[0].length) : title.slice(0, match.index)).trim(); if (!meaningful(remaining)) continue;
      title = remaining; decorated = true; changed = true; break;
    }
    if (changed) continue;
    if (extractYear) {
      const bare = title.match(/\s+((?:19|20)\d{2})\s*$/u);
      const beforeYear = bare ? title.slice(0, bare.index).trim() : '';
      // A bare number after one word may be part of a numbered title. Bracketed
      // years are explicit; unwrapped years need a fuller title and a past/current
      // release, avoiding titles such as Film 1900, Class of 1984 and Blade Runner 2049.
      const bareRelease = bare && beforeYear.split(/\s+/u).length >= 2 && !/\b(?:of|in|from|to|by|at|on)\s*$/i.test(beforeYear) && Number(bare[1]) <= new Date().getFullYear() + 1 ? bare : null;
      const release = title.match(/\s*[\[(]((?:19|20)\d{2})[\])]\s*$/u) || bareRelease;
      if (release && meaningful(title.slice(0, release.index))) { year = Number(release[1]); title = title.slice(0, release.index).trim(); continue; }
    }
    break;
  }
  title = title.replace(/^[\s|┃│¦｜║:.-]+|[\s|┃│¦｜║:.-]+$/g, '').trim() || name.trim();
  return { title, year, language: attributeLanguage || (found.size === 1 ? [...found][0] : null), languageExplicit: !!attributeLanguage || languageExplicit, decorated };
}
export function normalizeTitle(value: string) { return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' '); }
/** Strip a repeated show around a season badge only when both identities agree. */
export function cleanSeriesTitle(value: string, season?: number): string {
  let title = value.trim();
  for (let pass = 0; pass < 4; pass++) {
    const repeated = title.match(/^(.+?)[\s|┃│¦｜║:._-]+[\[({]?(?:S(?:eason)?)[\s._-]*(\d{1,2})\b[\])}]?[\s|┃│¦｜║:._-]+(.+)$/i);
    if (!repeated) break;
    const left = cleanMediaTitle(repeated[1]), right = cleanMediaTitle(repeated[3]);
    if (season !== undefined && Number(repeated[2]) !== season || normalizeTitle(left.title) !== normalizeTitle(right.title) || left.year && right.year && left.year !== right.year || left.language && right.language && left.language !== right.language) break;
    const language = left.language || right.language, year = left.year || right.year;
    title = `${language ? `[${language}] ` : ''}${left.title}${year ? ` (${year})` : ''}`;
  }
  for (let pass = 0; pass < 4; pass++) {
    const prefix = title.match(/^[\[({]?(?:S(?:eason)?)[\s._-]*(\d{1,2})\b[\])}]?[\s|┃│¦｜║:._-]+(.+)$/i);
    if (prefix && (season === undefined || Number(prefix[1]) === season)) { title = prefix[2].trim(); continue; }
    const badge = title.match(/^(.+?)[\s|┃│¦｜║:._-]+[\[({]?(?:S(?:eason)?)[\s._-]*(\d{1,2})[\])}]?$/i);
    if (badge && (season === undefined || Number(badge[2]) === season)) { title = badge[1].trim(); continue; }
    break;
  }
  return title;
}

/** Channel brands such as Sky and HBO are names, not distribution badges. */
function cleanChannelTitle(value: string): string {
  let title = value.trim().replace(/\s+/g, ' ');
  const country = /^(?:US|USA|GB|UK|CA|AU|NZ|MX|BR|AR|CL|CO|PE|DE|AT|CH|FR|ES|PT|IT|NL|BE|IE|TR|SA|AE|EG|IL|IN|PK|BD|JP|KR|CN|TW|HK|ZA)$/;
  // This diamond is a provider badge. Strip S/SA only when attached to that
  // badge; ordinary regions, call signs and channel initials remain names.
  title = title.replace(/(^|[\s|┃│¦｜║:])([A-Z]{2,3})\s*◈\s*(?:(?:SA|S)(?:\s*[|┃│¦｜║:]\s*|\s+))?/g, (match, separator: string, code: string) => country.test(code) ? separator : match).trim();
  const decoration = /^[\s\p{Regional_Indicator}★☆✦✧❆❄⭐🌟]+|[\s\p{Regional_Indicator}★☆✦✧❆❄⭐🌟]+$/gu;
  const tag = (text: string) => {
    if (/^\d+(?:\.\d+)?\s*(?:m|k)b(?:ps)?\s+LAT$/i.test(text.trim())) return true;
    const parts = text.trim().split(/[|┃│¦｜║,;/+]|\s+/).filter(Boolean);
    return parts.length > 0 && parts.every(part => qualityTag.test(part) || !!languageTag(part) || country.test(part));
  };
  for (let pass = 0; pass < 24; pass++) {
    const plain = title.replace(decoration, '').trim();
    if (plain && plain !== title) { title = plain; continue; }
    const matches = [title.match(/^(?:\[([^\[\]]+)\]|\(([^()]+)\)|\{([^{}]+)\}|[|┃│¦｜║]([^|┃│¦｜║]+)[|┃│¦｜║])\s*/u) || title.match(/^(.{1,100}?)(?:\s*[|┃│¦｜║:]\s*|\s+-\s+)/u), title.match(/\s*(?:\[([^\[\]]+)\]|\(([^()]+)\)|\{([^{}]+)\}|[|┃│¦｜║]([^|┃│¦｜║]+)[|┃│¦｜║])$/u) || title.match(/(?:\s*[|┃│¦｜║:]\s*|\s+-\s+)(.{1,100}?)$/u)];
    let changed = false;
    for (let side = 0; side < matches.length; side++) {
      const match = matches[side]; if (!match || !tag(match.slice(1).find(Boolean)!)) continue;
      const remaining = (side === 0 ? title.slice(match[0].length) : title.slice(0, match.index)).replace(/^[\s|┃│¦｜║:.-]+|[\s|┃│¦｜║:.-]+$/g, '').trim();
      if (!remaining) continue;
      title = remaining; changed = true; break;
    }
    if (changed) continue;
    const quality = title.match(/^(\S+)\s+(.+)$/u), suffix = title.match(/^(.+?)\s+(\S+)$/u);
    if (quality && qualityTag.test(quality[1])) { title = quality[2]; continue; }
    if (suffix && qualityTag.test(suffix[2])) { title = suffix[1]; continue; }
    const eventQuality = title.match(/^(.+?)\s+(\S+)(\s+\(Live Events?\))$/i);
    if (eventQuality && qualityTag.test(eventQuality[2])) { title = eventQuality[1] + eventQuality[3]; continue; }
    break;
  }
  return title || value.trim();
}

/** Cosmetic title cleanup only; it neither translates names nor changes identity. */
export function cleanDisplayTitle(value: string, type: ContentType): string {
  if (type === 'live') return cleanChannelTitle(value);
  const base = cleanMediaTitle(value, {}, false).title;
  const episode = parseEpisodeTitle(base);
  return cleanMediaTitle(cleanSeriesTitle(episode?.title || base)).title;
}
export interface EpisodeDescriptor { title: string; season: number; episode: number; episodeName: string; }
/** Explicit season/episode coordinates only: ordinary title digits never supply numbering. */
export function parseEpisodeTitle(value: string): EpisodeDescriptor | null {
  const markers = [...value.matchAll(/(?<![\p{L}\p{N}])(?:S(?:eason)?[\s.#:_-]*(\d{1,2})[\s._:-]*(?:Episode|Ep|E)[\s.#:_-]*(\d{1,3})|(\d{1,2})x(\d{1,3}))(?![\p{L}\p{N}])/giu)];
  if (markers.length !== 1) return null;
  const marker = markers[0], season = Number(marker[1] ?? marker[3]), episode = Number(marker[2] ?? marker[4]);
  let before = value.slice(0, marker.index).trim(), after = value.slice(marker.index! + marker[0].length).trim();
  // Remove a wrapper around the coordinates, leaving brackets within show names intact.
  for (const [open, close] of [['[', ']'], ['(', ')'], ['{', '}']]) if (before.endsWith(open) && after.startsWith(close)) { before = before.slice(0, -1).trim(); after = after.slice(1).trim(); break; }
  const trim = (text: string) => text.replace(/^[\s|┃│¦｜║:._-]+|[\s|┃│¦｜║:._-]+$/g, '').trim();
  before = trim(before); after = trim(after);
  const title = cleanSeriesTitle(before || after, season);
  if (!title || /^(?:Episode|Ep|E)[\s._-]*\d+$/i.test(title)) return null;
  return { title, season, episode, episodeName: before ? after || `Episode ${episode}` : `Episode ${episode}` };
}
export function similarity(a: string, b: string) {
  if (a === b) return 1; if (!a || !b) return 0;
  const previous = [...Array(b.length + 1)].map((_, n) => n);
  for (let i = 1; i <= a.length; i++) { let diagonal = previous[0]; previous[0] = i; for (let j = 1; j <= b.length; j++) { const old = previous[j]; previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)); diagonal = old; } }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}
export function inferFormat(url: string): Source['format'] {
  const path = new URL(url).pathname.toLowerCase();
  if (/\.m3u8?$/.test(path)) return 'hls'; if (/\.mpd$/.test(path)) return 'dash'; if (/\.(mp4|m4v|mov)$/.test(path)) return 'mp4'; if (/\.webm$/.test(path)) return 'webm'; return 'unknown';
}
export function parseM3U(input: string): { entries: PlaylistEntry[]; errors: string[] } {
  // Large provider lists already retain the input and parsed entries. Walk the
  // lines without allocating two additional arrays of every line in the file.
  function* lines() { let start = 0; for (;;) { const end = input.indexOf('\n', start); if (end < 0) { yield input.slice(start).trim(); return; } yield input.slice(start, end).trim(); start = end + 1; } }
  let header = false, index = -1;
  const entries: PlaylistEntry[] = []; const errors: string[] = []; let pending: { attributes: Record<string, string>; name: string; line: number } | null = null; const identityCounts = new Map<string, number>(); const seenStreams = new Set<string>();
  for (const line of lines()) {
    index++; if (!line) continue;
    if (!header) { if (!line.startsWith('#EXTM3U')) throw new Error('Playlist must begin with #EXTM3U'); header = true; }
    if (line.startsWith('#EXTINF:')) {
      if (pending) errors.push(`Line ${pending.line}: missing stream URL`);
      let quote: string | null = null; let delimiter = -1;
      for (let i = 8; i < line.length; i++) { if ((line[i] === '"' || line[i] === "'") && (!quote || quote === line[i])) quote = quote ? null : line[i]; if (line[i] === ',' && !quote) { delimiter = i; break; } }
      if (delimiter < 0) { errors.push(`Line ${index + 1}: EXTINF has no title separator`); pending = null; continue; }
      const attributes: Record<string, string> = {};
      for (const match of line.slice(0, delimiter).matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)) attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
      pending = { attributes, name: line.slice(delimiter + 1).trim() || attributes['tvg-name'] || '', line: index + 1 }; continue;
    }
    if (line.startsWith('#EXTGRP:') && pending) { pending.attributes['group-title'] ||= line.slice(8).trim(); continue; }
    if (line.startsWith('#')) continue;
    if (!pending) { errors.push(`Line ${index + 1}: stream URL without EXTINF`); continue; }
    const { attributes, name } = pending; pending = null;
    if (!name) { errors.push(`Line ${index + 1}: title is empty`); continue; }
    let url: string; try { url = validateSourceUrl(line).toString(); } catch { errors.push(`Line ${index + 1}: invalid HTTP or HTTPS stream URL`); continue; }
    const group = attributes['group-title'] || '';
    const languageTags = cleanMediaTitle(name, attributes, false);
    let cleaned = languageTags.title;
    const explicit = (attributes.type || attributes['content-type'] || '').toLowerCase().trim();
    const explicitType = ['movie', 'series', 'live'].includes(explicit) ? explicit as ContentType : null;
    // Only the first provider path segment is a classification hint. Credentials, IDs,
    // attributes and URL digits never supply episode coordinates.
    const pathSegment = new URL(url).pathname.split('/')[1]?.toLowerCase();
    const pathType = ['movie', 'series', 'live'].includes(pathSegment) ? pathSegment as ContentType : null;
    const episodeMarker = parseEpisodeTitle(cleaned);
    const releaseYear = cleanMediaTitle(cleaned).year;
    // Extensionless IPTV channel links commonly use TV bouquets or continuous
    // 24/7 categories. TV movies/shows/series remain VOD evidence, and explicit
    // types, provider paths, episode coordinates and release years take priority.
    const continuousGroup = /(?:^|\D)24\s*[/_-]\s*7(?:\D|$)/i.test(group);
    const tvGroup = /\btv\b/i.test(group) && !/\b(?:movies?|films?|vod|series|serien|serials?|shows?)\b/i.test(group);
    const groupLive = /\blive\b|\bchannels?\b|\bnews\b|\bsports\b/i.test(group) || !releaseYear && (continuousGroup || tvGroup);
    // IPTV providers often call a channel group "FILMSKI / MOVIE". A direct
    // continuous transport stream without VOD identity is a channel hint, while
    // explicit movie/series labels, provider paths, years and episodes take priority.
    const channelTransport = /\.ts$/i.test(new URL(url).pathname) && !episodeMarker && !releaseYear;
    const type: ContentType = explicitType || pathType || (episodeMarker ? 'series' : groupLive || channelTransport ? 'live' : 'movie');
    if (type === 'live') cleaned = cleanChannelTitle(name);
    const episodic = type === 'series' ? episodeMarker : null;
    // A series language tag may sit at the end of its title before SxxExx.
    const identityTags = type === 'live' ? { ...extractLanguageTags(cleaned, attributes), year: null, languageExplicit: false, decorated: cleaned !== name } : cleanMediaTitle(episodic ? episodic.title : type === 'series' ? cleanSeriesTitle(cleaned) : cleaned, attributes);
    const identityName = identityTags.title;
    const language = languageTags.language && identityTags.language && languageTags.language !== identityTags.language ? null : languageTags.language || identityTags.language;
    const languageExplicit = languageTags.languageExplicit || identityTags.languageExplicit;
    const year = identityTags.year;
    let title = identityName;
    title = title.replace(/^[\s|┃│¦｜║:.-]+|[\s|┃│¦｜║:.-]+$/g, '').trim() || name;
    const season = episodic?.season ?? null; const episode = episodic?.episode ?? null;
    if (season !== null && (season > 99 || !episode || episode > 999)) { errors.push(`Line ${index + 1}: invalid episode numbers`); continue; }
    const imdb = attributes['imdb-id']; const tmdb = attributes['tmdb-id'];
    const externalId = imdb && /^tt\d{5,12}$/.test(imdb) ? { provider: 'imdb', id: imdb } : tmdb && /^\d{1,12}$/.test(tmdb) ? { provider: `tmdb-${type}`, id: tmdb } : undefined;
    const normalized = normalizeTitle(title);
    const stableId = attributes['tvg-id'] || `${normalized}|${year || ''}|${type}|${season ?? ''}|${episode ?? ''}`;
    const key = hash(`${stableId}|${normalized}|${year || ''}|${type}|${season ?? ''}|${episode ?? ''}${language ? `|lang:${language}` : ''}`);
    // Repeated identical identity in one playlist may represent separate servers. Preserve them
    // with a URL discriminator while normal identity remains stable across refreshes.
    if (seenStreams.has(`${key}:${url}`)) continue; seenStreams.add(`${key}:${url}`);
    const occurrence = identityCounts.get(key) || 0; identityCounts.set(key, occurrence + 1);
    const entryKey = occurrence ? `${key}:${occurrence}` : key;
    const categoryHeader = !year && !episodic && !explicitType && !pathType && normalized === normalizeTitle(group) && /\b(?:movies?|films?|vod|series|cartoni|channels?)\b/i.test(group);
    const ambiguous = type === 'series' ? !episodic : type === 'live' ? false : categoryHeader || !year && explicitType !== 'movie' && pathType !== 'movie' && !/movie|film|vod/i.test(group);
    entries.push({ name, title, normalized, year, type, season, episode, episodeName: episodic?.episodeName || '', url, attributes, poster: attributes['tvg-logo'] || '', group, format: inferFormat(url), key: entryKey, ambiguous, language, languageExplicit, decorated: languageTags.decorated || identityTags.decorated, externalId });
  }
  if (!header) throw new Error('Playlist must begin with #EXTM3U');
  if (pending) errors.push(`Line ${pending.line}: missing stream URL`);
  return { entries, errors: errors.slice(0, 100) };
}
