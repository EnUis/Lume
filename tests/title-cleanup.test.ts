import { expect, it } from 'vitest';
import { cleanMediaTitle, parseM3U } from '../lib/server/m3u';

it('removes explicit provider, language and quality decorations before recovering a release year', () => {
  for (const name of ['The Tomb', 'District 9', 'After.Life', "'Til Lies Do Us Part"]) {
    expect(cleanMediaTitle(`${name} (2009) | 🌟 FREE IPTV WORLD 🌟`)).toEqual({ title: name, year: 2009, language: null, languageExplicit: false, decorated: true });
  }
  expect(cleanMediaTitle('[X][Provider] [DE] [1080p] A Film (2020) - [WEB-DL]')).toMatchObject({ title: 'A Film', year: 2020, language: 'de', decorated: true });
  expect(cleanMediaTitle('VIP | A Film (2020) | EN FHD')).toMatchObject({ title: 'A Film', year: 2020, language: 'en', decorated: true });
  expect(cleanMediaTitle('A Film (2020) | Example Service', { 'provider-name': 'Example Service' })).toMatchObject({ title: 'A Film', year: 2020, decorated: true });
  expect(cleanMediaTitle('A Film (2020) | provider.example.com')).toMatchObject({ title: 'A Film', year: 2020, decorated: true });
  expect(cleanMediaTitle('CINESTAR 1 (HD)')).toMatchObject({ title: 'CINESTAR 1' });
  expect(cleanMediaTitle('CINESTAR 1 ()')).toMatchObject({ title: 'CINESTAR 1', decorated: true });
});

it('recognizes direct IPTV transport channels despite a movie group without overriding explicit VOD identities', () => {
  const entry = (name: string, path: string, attributes = '') => `#EXTINF:-1 group-title="FILMSKI / MOVIE" ${attributes},${name}\nhttp://media.example.test:8080/${path}\n`;
  const result = parseM3U('#EXTM3U\n' + entry('STAR TV', '142.ts', 'tvg-id="142.ba"') + entry('SEHARA ONLINE', '145.ts') + entry('The Film', '500.ts', 'type="movie"') + entry('The Film (2020)', '501.ts') + entry('A Show S01E02', '502.ts') + entry('Another Film', 'movie/503.ts'));
  expect(result.entries.map(row => row.type)).toEqual(['live', 'live', 'movie', 'movie', 'series', 'movie']);
  expect(result.entries.map(row => row.ambiguous)).toEqual([false, false, false, false, false, false]);
});

it('treats subtitle labels as decoration without guessing an audio language', () => {
  for (const tag of ['MULTI-SUB', 'DUAL SUB', 'EN SUB', 'FR SUBTITLES']) expect(cleanMediaTitle(`Seaspiracy (2021) - [${tag}]`)).toMatchObject({ title: 'Seaspiracy', year: 2021, language: null, languageExplicit: false, decorated: true });
  expect(cleanMediaTitle('Seaspiracy (2021) [MULTI-SUB]', { 'audio-language': 'German' })).toMatchObject({ title: 'Seaspiracy', year: 2021, language: 'de', languageExplicit: true });
  expect(cleanMediaTitle('Seaspiracy (2021) [DUAL AUDIO]')).toMatchObject({ title: 'Seaspiracy', year: 2021, language: 'mul' });
});

it('preserves genuine title words, bracketed names and internal punctuation', () => {
  for (const name of ['Animale | Umano', 'After.Life', '[REC]', 'It', '1917', 'Film 360', 'Film 720', 'Film 1900', 'Class of 1984', 'Blade Runner 2049', '2001: A Space Odyssey', 'German Lessons', 'The English Patient', 'The X Files', 'The Film (Directors Cut)', 'The Film [Unknown Edition]']) {
    expect(cleanMediaTitle(name)).toMatchObject({ title: name, year: null, decorated: false });
  }
  expect(cleanMediaTitle('1917 (2019) [UHD]')).toMatchObject({ title: '1917', year: 2019 });
  expect(cleanMediaTitle('Animale | Umano (2024)')).toMatchObject({ title: 'Animale | Umano', year: 2024 });
});

it('cleans series identities before coordinates and reviews clear category headers while cleaning live channel badges', () => {
  const parsed = parseM3U('#EXTM3U\n#EXTINF:-1,[NETFLIX] [DE] A Show (2020) S02E03 - The Arrival [FHD]\nhttps://media.example.test/series/a.mp4\n#EXTINF:-1 group-title="CARTONI VOD",CARTONI VOD\nhttps://media.example.test/group.mp4\n#EXTINF:-1 type="live",[EN] World News HD\nhttp://media.example.test:8080/live/a.m3u8');
  expect(parsed.errors).toEqual([]);
  expect(parsed.entries[0]).toMatchObject({ title: 'A Show', year: 2020, language: 'de', season: 2, episode: 3, episodeName: 'The Arrival', decorated: true });
  expect(parsed.entries[1]).toMatchObject({ title: 'CARTONI VOD', ambiguous: true });
  expect(parsed.entries[2]).toMatchObject({ title: 'World News', type: 'live', language: 'en' });
});
