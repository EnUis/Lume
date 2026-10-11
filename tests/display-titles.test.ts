import { describe, expect, it } from 'vitest';
import { cleanDisplayTitle, cleanMediaTitle, cleanSeriesTitle, parseM3U } from '../lib/server/m3u';

describe('public title presentation', () => {
  it('recognizes Unicode playlist dividers without deleting ordinary title words', () => {
    expect(cleanDisplayTitle('EN┃ Yu-Gi-Oh', 'series')).toBe('Yu-Gi-Oh');
    expect(cleanDisplayTitle('EN┃ Ultimate Spiderman', 'series')).toBe('Ultimate Spiderman');
    for (const divider of ['┃', '│', '¦', '｜', '║']) {
      expect(cleanDisplayTitle(`DE${divider} The 100 S01EP02`, 'series')).toBe('The 100');
      expect(cleanDisplayTitle(`BBC One +1 ${divider} UK ${divider} HD`, 'live')).toBe('BBC One +1');
      expect(cleanMediaTitle(`EN${divider}HD${divider} Toy Story 2`)).toMatchObject({ title: 'Toy Story 2', language: 'en', languageExplicit: true });
      expect(cleanDisplayTitle(`Love ${divider} Death`, 'movie')).toBe(`Love ${divider} Death`);
    }
    const parsed = parseM3U('#EXTM3U\n#EXTINF:-1 type="series",EN┃ Ultimate Spiderman S01EP02\nhttps://fixture.example.test/series/2.mp4');
    expect(parsed.entries[0]).toMatchObject({ title: 'Ultimate Spiderman', normalized: 'ultimate spiderman', language: 'en', season: 1, episode: 2 });
    expect(parsed.entries[0].name).toBe('EN┃ Ultimate Spiderman S01EP02');
  });

  it('removes repeated season labels before an English metadata match is available', () => {
    expect(cleanDisplayTitle('مدرسة النخبة S01 مدرسة النخبة', 'series')).toBe('مدرسة النخبة');
    expect(cleanDisplayTitle('[DE] The 100 [S01] The 100', 'series')).toBe('The 100');
    expect(cleanDisplayTitle('Elite S01', 'series')).toBe('Elite');
    expect(cleanDisplayTitle('[Season 2] - Elite', 'series')).toBe('Elite');
    expect(cleanDisplayTitle('Elite - S01 EP02 - Desire', 'series')).toBe('Elite');
    expect(cleanDisplayTitle('[DE] S1 EP1 Elite (2018)', 'movie')).toBe('Elite');
  });

  it('keeps legitimate sequel numbers and conflicting identities intact', () => {
    for (const title of ['Blade Runner 2049', 'Class of 1984', '2001: A Space Odyssey', 'S1m0ne', 'Toy Story 2']) expect(cleanDisplayTitle(title, 'movie')).toBe(title);
    expect(cleanSeriesTitle('Show (2020) S01 Show (2025)')).toBe('Show (2020) S01 Show (2025)');
    expect(cleanSeriesTitle('Show S01 A Different Show')).toBe('Show S01 A Different Show');
    expect(cleanSeriesTitle('Show S02', 1)).toBe('Show S02');
  });

  it('removes channel distribution tags without stripping the actual channel brand', () => {
    expect(cleanDisplayTitle('FOX Sports 2 | MX ❆', 'live')).toBe('FOX Sports 2');
    expect(cleanDisplayTitle('🇩🇪 [DE] Sky Sport F1 HD', 'live')).toBe('Sky Sport F1');
    expect(cleanDisplayTitle('HBO - [US FHD]', 'live')).toBe('HBO');
    for (const title of ['Sky', 'HBO', 'HBO Max', 'CNN International', 'France 24', 'Canal+ Sport', 'BBC One +1']) expect(cleanDisplayTitle(title, 'live')).toBe(title);
  });

  it('cleans observed live-provider badges while preserving stations, regions and event descriptions', () => {
    const cases = [
      ['USA◈ NFL Game 14: No Scheduled Event', 'NFL Game 14: No Scheduled Event'],
      ['US◈ S| NEWS NATION', 'NEWS NATION'],
      ['US◈ SA | Aljazeera Balkans', 'Aljazeera Balkans'],
      ['US◈ SA: ABC 8 (WTNH) New Haven', 'ABC 8 (WTNH) New Haven'],
      ['Dallas | US◈ S Spectrum NEWS 1', 'Dallas | Spectrum NEWS 1'],
      ['Fox Sports 2 | 2MB LAT', 'Fox Sports 2'],
      ['NFL Red Zone HD (Live Events)', 'NFL Red Zone (Live Events)'],
      ['NFL Red Zone FHD (Live Events)', 'NFL Red Zone (Live Events)'],
      ['Austin | Spectrum News (SHD)', 'Austin | Spectrum News'],
    ];
    for (const [before, after] of cases) expect(cleanDisplayTitle(before, 'live')).toBe(after);
    for (const title of ['S Channel', 'SA Local News', 'ABC 8 (WTNH) New Haven', 'Dallas | Spectrum NEWS 1', 'Sky Sports F1 (Live Events)', 'LAT Television', 'CNN ◈ International', 'Premium Cinema', 'HBO Premium']) expect(cleanDisplayTitle(title, 'live')).toBe(title);
  });

  it('cleans future imports while retaining seasons as structure and channel brands', () => {
    const parsed = parseM3U('#EXTM3U\n#EXTINF:-1 type="series",Elite [S01]\nhttps://fixture.example.test/series/a.mp4\n#EXTINF:-1 type="series",Elite [S02]\nhttps://fixture.example.test/series/b.mp4\n#EXTINF:-1 type="live",Sky Sport F1 HD | DE\nhttps://fixture.example.test/live/c.ts');
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries.map(entry => entry.title)).toEqual(['Elite', 'Elite', 'Sky Sport F1']);
    expect(parsed.entries[2].language).toBe('de');
    expect(parsed.entries.slice(0, 2).every(entry => entry.ambiguous)).toBe(true);
  });
});
