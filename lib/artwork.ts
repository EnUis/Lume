import type { Title } from './types';

/** Try the other saved image when the preferred artwork is missing or broken. */
export function artworkCandidates(title: Pick<Title, 'poster' | 'backdrop'>, landscape = false): string[] {
  return [...new Set((landscape ? [title.backdrop, title.poster] : [title.poster, title.backdrop])
    .map(value => value?.trim() || '').filter(value => /^(?:https?:\/\/|\/(?!\/))/i.test(value)))];
}
