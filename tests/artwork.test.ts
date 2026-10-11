import { expect, it } from 'vitest';
import { artworkCandidates } from '../lib/artwork';
it('retains a real alternate image for failed banners and covers', () => {
  const title = { poster: 'https://images.example/poster.jpg', backdrop: 'https://images.example/banner.jpg' };
  expect(artworkCandidates(title, true)).toEqual([title.backdrop, title.poster]);
  expect(artworkCandidates(title)).toEqual([title.poster, title.backdrop]);
  expect(artworkCandidates({ poster: title.poster, backdrop: '' }, true)).toEqual([title.poster]);
});
it('does not repeatedly retry duplicate or unsafe artwork URLs', () => {
  expect(artworkCandidates({poster:'/images/cover.jpg',backdrop:' /images/cover.jpg '})).toEqual(['/images/cover.jpg']);
  expect(artworkCandidates({poster:'javascript:alert(1)',backdrop:'//unvalidated.example/a'})).toEqual([]);
});
