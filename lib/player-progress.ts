import type { Episode, Progress, Title } from './types';
import { mergeProgress } from './progress';

/** Resolve merged history only for this title; unrelated records remain intact. */
export function canonicalizeTitleProgress(title: Title, history: Progress[]): Progress[] {
  const titleIds = new Set([title.id, ...(title.alternateIds || [])]);
  const episodes = title.episodes || [];
  const episodeIds = new Map(episodes.map(episode => [episode.id, episode.id]));
  for (const episode of episodes) for (const alias of episode.alternateIds || []) {
    if (!episodeIds.has(alias)) episodeIds.set(alias, episode.id);
  }
  const unrelated: Progress[] = [], matching: Progress[] = [];
  for (const entry of history) {
    if (!titleIds.has(entry.titleId)) { unrelated.push(entry); continue; }
    // A previously separate episode may have been saved as a movie. Its former
    // title ID is an episode alias after repair; preserve that exact chapter.
    matching.push({ ...entry, titleId: title.id, episodeId: entry.episodeId ? episodeIds.get(entry.episodeId) || entry.episodeId : episodeIds.get(entry.titleId) || null });
  }
  return [...unrelated, ...mergeProgress(matching)].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Old episode links and merged viewing records select the current episode. */
export function selectPlaybackEpisode(title: Title, history: Progress[], initialEpisodeId?: string): Episode | null {
  const episodes = [...(title.episodes || [])].sort((a, b) => a.season - b.season || a.number - b.number);
  const latestEpisode = history.find(entry => entry.titleId === title.id && entry.episodeId)?.episodeId;
  const requested = initialEpisodeId || latestEpisode;
  return episodes.find(episode => episode.available && (episode.id === requested || episode.alternateIds?.includes(requested || '')))
    || episodes.find(episode => episode.available) || null;
}
