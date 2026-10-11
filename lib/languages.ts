/** Explicit provider labels only. Country flags are accepted as language hints. */
const definitions = [
  ['en', 'English', 'EN', 'ENG', 'English', 'Angol', '🇬🇧', '🇺🇸'],
  ['de', 'German', 'DE', 'DEU', 'GER', 'German', 'Deutsch', 'Német', '🇩🇪', '🇦🇹'],
  ['tr', 'Turkish', 'TR', 'TUR', 'Turkish', 'Türkçe', 'Turkce', '🇹🇷'],
  ['fr', 'French', 'FR', 'FRA', 'FRE', 'French', 'Français', 'Francais', '🇫🇷'],
  ['es', 'Spanish', 'ES', 'SPA', 'Spanish', 'Español', 'Espanol', 'Castellano', '🇪🇸'],
  ['it', 'Italian', 'IT', 'ITA', 'Italian', 'Italiano', '🇮🇹'],
  ['pt', 'Portuguese', 'PT', 'POR', 'Portuguese', 'Português', 'Portugues', '🇵🇹', '🇧🇷'],
  ['pl', 'Polish', 'PL', 'POL', 'Polish', 'Polski', '🇵🇱'],
  ['ru', 'Russian', 'RU', 'RUS', 'Russian', 'Русский', '🇷🇺'],
  ['ar', 'Arabic', 'AR', 'ARA', 'Arabic', 'العربية', '🇸🇦'],
  ['nl', 'Dutch', 'NL', 'NLD', 'DUT', 'Dutch', 'Nederlands', '🇳🇱'],
  ['ja', 'Japanese', 'JA', 'JPN', 'Japanese', '日本語', '🇯🇵'],
  ['ko', 'Korean', 'KO', 'KOR', 'Korean', '한국어', '🇰🇷'],
  ['zh', 'Chinese', 'ZH', 'ZHO', 'CHI', 'Chinese', '中文', 'Mandarin', '🇨🇳'],
  ['hu', 'Hungarian', 'HU', 'HUN', 'Hungarian', 'Magyar', '🇭🇺'],
  ['cs', 'Czech', 'CS', 'CZ', 'CES', 'CZE', 'Czech', 'Čeština', '🇨🇿'],
  ['sk', 'Slovak', 'SK', 'SLK', 'SLO', 'Slovak', 'Slovenčina', '🇸🇰'],
  ['ro', 'Romanian', 'RO', 'RON', 'RUM', 'Romanian', 'Română', '🇷🇴'],
  ['bg', 'Bulgarian', 'BG', 'BUL', 'Bulgarian', 'Български', '🇧🇬'],
  ['el', 'Greek', 'EL', 'GR', 'ELL', 'GRE', 'Greek', 'Ελληνικά', '🇬🇷'],
  ['uk', 'Ukrainian', 'UK', 'UKR', 'Ukrainian', 'Українська', '🇺🇦'],
  ['sv', 'Swedish', 'SV', 'SWE', 'Swedish', 'Svenska', '🇸🇪'],
  ['no', 'Norwegian', 'NO', 'NOR', 'Norwegian', 'Norsk', '🇳🇴'],
  ['da', 'Danish', 'DA', 'DAN', 'Danish', 'Dansk', '🇩🇰'],
  ['fi', 'Finnish', 'FI', 'FIN', 'Finnish', 'Suomi', '🇫🇮'],
  ['hi', 'Hindi', 'HI', 'HIN', 'Hindi', 'हिन्दी', '🇮🇳'],
  ['fa', 'Persian', 'FA', 'FAS', 'PER', 'Persian', 'Farsi', 'فارسی', '🇮🇷'],
  ['he', 'Hebrew', 'HE', 'HEB', 'Hebrew', 'עברית', '🇮🇱'],
  ['mul', 'Multilingual', 'MULTI', 'DUAL', 'Multilingual', 'Multi Audio', 'Dual Audio'],
] as const;
const aliasKey = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
const aliases = new Map<string, string>(); const labels = new Map<string, string>(); const flags = new Map<string, string>();
for (const [code, label, ...names] of definitions) {
  labels.set(code, label); aliases.set(code, code);
  for (const name of names) { aliases.set(aliasKey(name), code); if (name.startsWith('🇦') || /\p{Regional_Indicator}/u.test(name)) flags.set(name, code); }
}
export function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const exact = aliases.get(aliasKey(value)); if (exact) return exact;
  // A locale is accepted only as a whole attribute/tag, never read from title words.
  const locale = value.trim().match(/^([a-z]{2,3})[-_]([a-z]{2}|\d{3}|hans|hant)(?:[-_][a-z]{2})?$/i);
  return locale ? aliases.get(aliasKey(locale[1])) || null : null;
}
export function languageLabel(code: unknown, locale = 'en'): string {
  const normalized = normalizeLanguage(code); if (!normalized) return 'Unspecified';
  if (locale === 'en') return labels.get(normalized)!;
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(normalized) || labels.get(normalized)!; } catch { return labels.get(normalized)!; }
}
export interface LanguageTags { title: string; language: string | null; explicit: boolean }
function normalizeTag(value: string) {
  // Uppercase provider country tags differ from ISO language attributes: UK as a
  // title tag usually means English, while lang="uk" remains Ukrainian.
  const country = ({ US: 'en', GB: 'en', UK: 'en', BR: 'pt' } as Record<string, string>)[value.trim()];
  return country || normalizeLanguage(value);
}
export function extractLanguageTags(name: string, attributes: Record<string, unknown> = {}): LanguageTags {
  const attributeLanguage = ['audio-language', 'tvg-language', 'lang', 'language'].map(key => normalizeLanguage(attributes[key])).find(Boolean) || null;
  let title = name.trim(); const found = new Set<string>();
  // Only wrappers, explicit separators and flags at the edges are removed.
  // Ordinary words such as "German Lessons", "It", and numeric titles survive.
  for (let n = 0; n < 8; n++) {
    const prefix = title.match(/^(?:\(\s*([^()]+?)\s*\)|\[\s*([^\[\]]+?)\s*\]|\{\s*([^{}]+?)\s*\})\s*/u) || title.match(/^(.{1,40}?)(?:\s*[|:]\s*|\s+-\s+)/u);
    const suffix = title.match(/\s*(?:\(\s*([^()]+?)\s*\)|\[\s*([^\[\]]+?)\s*\]|\{\s*([^{}]+?)\s*\})$/u) || title.match(/(?:\s*[|:]\s*|\s+-\s+)(.{1,40}?)$/u);
    let changed = false;
    for (const [match, atStart] of [[prefix, true], [suffix, false]] as const) {
      if (!match) continue;
      const language = normalizeTag(match[1] || match[2] || match[3]); if (!language) continue;
      const remaining = atStart ? title.slice(match[0].length).trim() : title.slice(0, match.index).trim();
      if (!remaining) continue;
      found.add(language); title = remaining; changed = true; break;
    }
    if (changed) continue;
    for (const [flag, language] of flags) {
      const atStart = title.startsWith(flag); const atEnd = title.endsWith(flag);
      if (!atStart && !atEnd) continue;
      const remaining = (atStart ? title.slice(flag.length) : title.slice(0, -flag.length)).trim();
      if (!remaining) continue;
      found.add(language); title = remaining; changed = true; break;
    }
    if (!changed) break;
  }
  return { title, language: attributeLanguage || (found.size === 1 ? [...found][0] : null), explicit: !!attributeLanguage || found.size > 0 };
}
