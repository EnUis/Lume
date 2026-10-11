import { expect, it } from 'vitest';
import { parseM3U } from '../lib/server/m3u';

function entry(group: string, name = 'A Channel', attributes = '', pathname = '/viewer/access/12345') {
  return parseM3U(`#EXTM3U\n#EXTINF:-1 group-title="${group}" ${attributes},${name}\nhttps://fixture.example.test${pathname}`).entries[0];
}

it('recognizes extensionless TV bouquets and continuous channel groups without a .ts suffix', () => {
  for (const group of ['US | ABC TV', 'UK | BBC TV', 'DE | DEUTSCHE TV', 'US | DOCUMENTARY TV', 'US | 24-7 SERIES UHD', 'DE | MIXED SERIEN 24/7', 'US | CINEMA PPV 24 / 7']) {
    expect(entry(group), group).toMatchObject({ type: 'live', ambiguous: false, year: null, season: null, episode: null });
  }
});

it('keeps explicit types, provider paths, release identities and episode coordinates ahead of new channel hints', () => {
  expect(entry('ABC TV', 'A Film', 'type="movie"')).toMatchObject({ type: 'movie', ambiguous: false });
  expect(entry('24/7 SERIES', 'A Show S01E02', 'type="series"')).toMatchObject({ type: 'series', ambiguous: false, season: 1, episode: 2 });
  expect(entry('ABC TV', 'A Film', '', '/movie/viewer/access/12345.mkv')).toMatchObject({ type: 'movie', ambiguous: false });
  expect(entry('ABC TV', 'A Show S01E02', '', '/series/viewer/access/12345.mkv')).toMatchObject({ type: 'series', ambiguous: false });
  expect(entry('24/7', 'A Real Film (2021)')).toMatchObject({ type: 'movie', ambiguous: false, year: 2021 });
  expect(entry('ABC TV', 'A Real Film (2021)')).toMatchObject({ type: 'movie', ambiguous: false, year: 2021 });
  expect(entry('24/7 SERIES', 'A Show S01E02')).toMatchObject({ type: 'series', ambiguous: false, season: 1, episode: 2 });
  expect(entry('ABC TV', 'A Film (2021)', 'type="live"')).toMatchObject({ type: 'live', ambiguous: false });
});

it('retains ambiguous generic groups and does not interpret TV movie or TV series collections as live channels', () => {
  for (const group of ['TV SERIES', 'TV SHOWS', 'TV Movies', 'TV VOD', 'Movies TV', 'Television Drama', 'COUNTRY | LOCAL', '24/75', '124/7']) {
    expect(entry(group).type, group).not.toBe('live');
  }
  expect(entry('TV SERIES')).toMatchObject({ ambiguous: true });
  expect(entry('COUNTRY | LOCAL')).toMatchObject({ ambiguous: true });
  expect(entry('TV Movies')).toMatchObject({ type: 'movie', ambiguous: false });
});
