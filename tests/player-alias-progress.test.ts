import { describe, expect, it } from 'vitest';
import { canonicalizeTitleProgress, selectPlaybackEpisode } from '../lib/player-progress';
import type { Progress, Title } from '../lib/types';

const title: Title = {
  id: 'series', alternateIds: ['old-series', 'older-series'], name: 'Merged series', type: 'series', year: 2026,
  synopsis: '', poster: '', backdrop: '', genres: [], duration: null, ageRating: null, cast: [], director: '',
  featured: false, demo: false, published: true, createdAt: 1, attribution: '',
  episodes: [
    { id: 'episode-1', alternateIds: ['old-episode-1'], titleId: 'series', season: 1, number: 1, name: 'First', duration: 1000, available: true },
    { id: 'episode-2', alternateIds: ['old-episode-2', 'older-episode-2'], titleId: 'series', season: 1, number: 2, name: 'Second', duration: 1000, available: true },
    { id: 'episode-3', alternateIds: ['old-episode-3'], titleId: 'series', season: 1, number: 3, name: 'Third', duration: 1000, available: false },
  ],
};
const progress = (overrides: Partial<Progress>): Progress => ({ titleId: 'series', episodeId: 'episode-1', position: 90, duration: 1000, updatedAt: 1000, ...overrides });

describe('player progress after title and episode merges', () => {
  it('keeps the episode when former episode cards had movie-level guest progress', () => {
    const repaired = { ...title, alternateIds: [...title.alternateIds!, 'split-ep2'], episodes: title.episodes!.map(episode => episode.id === 'episode-2' ? { ...episode, alternateIds: [...episode.alternateIds!, 'split-ep2'] } : episode) };
    const history = canonicalizeTitleProgress(repaired, [progress({ titleId: 'split-ep2', episodeId: null, position: 230 })]);
    expect(history).toEqual([progress({ titleId: title.id, episodeId: 'episode-2', position: 230 })]);
    expect(selectPlaybackEpisode(repaired, history)?.id).toBe('episode-2');
  });
  it('resumes an old title/episode link at the latest merged position, including when it is lower', () => {
    const history = canonicalizeTitleProgress(title, [
      progress({ titleId: 'old-series', episodeId: 'old-episode-2', position: 700, updatedAt: 1000 }),
      progress({ episodeId: 'episode-2', position: 800, updatedAt: 2000 }),
      progress({ titleId: 'older-series', episodeId: 'older-episode-2', position: 125, updatedAt: 3000 }),
    ]);
    const selected = selectPlaybackEpisode(title, history, 'old-episode-2');
    expect(selected?.id).toBe('episode-2');
    expect(history).toEqual([progress({ episodeId: 'episode-2', position: 125, updatedAt: 3000 })]);
    expect(history.find(entry => entry.titleId === title.id && entry.episodeId === selected?.id)?.position).toBe(125);
  });

  it('automatically resumes the latest canonical episode without mixing another title history', () => {
    const history = canonicalizeTitleProgress(title, [
      progress({ titleId: 'old-series', episodeId: 'old-episode-1', updatedAt: 1000 }),
      progress({ titleId: 'old-series', episodeId: 'old-episode-2', position: 225, updatedAt: 2000 }),
      progress({ titleId: 'another-series', episodeId: 'old-episode-1', updatedAt: 5000 }),
    ]);
    expect(selectPlaybackEpisode(title, history)?.id).toBe('episode-2');
    expect(history.find(entry => entry.titleId === title.id && entry.episodeId === 'episode-2')?.position).toBe(225);
  });

  it('preserves unrelated entries and unknown episode IDs rather than guessing a different chapter', () => {
    const unrelated = progress({ titleId: 'another-series', episodeId: 'old-episode-2', updatedAt: 5000 });
    const unknown = progress({ titleId: 'old-series', episodeId: 'episode-not-in-this-response', updatedAt: 2000 });
    const history = canonicalizeTitleProgress(title, [unrelated, unknown]);
    expect(history.find(entry => entry.titleId === 'another-series')).toBe(unrelated);
    expect(history.find(entry => entry.titleId === title.id)).toEqual({ ...unknown, titleId: title.id });
    expect(unrelated.episodeId).toBe('old-episode-2');
    expect(unknown.titleId).toBe('old-series');
  });

  it('maps movie aliases to one canonical movie record and skips unavailable episode links', () => {
    const movie = { ...title, id: 'movie', alternateIds: ['old-movie'], type: 'movie' as const, episodes: undefined };
    expect(canonicalizeTitleProgress(movie, [progress({ titleId: 'old-movie', episodeId: null, updatedAt: 1000 }), progress({ titleId: 'movie', episodeId: null, position: 190, updatedAt: 2000 })])).toEqual([progress({ titleId: 'movie', episodeId: null, position: 190, updatedAt: 2000 })]);
    expect(selectPlaybackEpisode(title, [], 'old-episode-3')?.id).toBe('episode-1');
  });
});
