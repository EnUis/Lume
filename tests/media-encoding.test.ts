import { expect, it } from 'vitest';
import { MEDIA_RATE_LIMITS, mediaRateArguments } from '../lib/server/media-encoding';

it('bounds high-complexity HLS output below the full window and retry-grace memory budget', () => {
  const bytesForWindowAndGrace = (46 * (MEDIA_RATE_LIMITS.video + MEDIA_RATE_LIMITS.audio) + MEDIA_RATE_LIMITS.buffer) / 8;
  // Leave room for initialization, fragment headers and transport overhead.
  expect(bytesForWindowAndGrace).toBeLessThan(28 * 1024 * 1024);
  expect(mediaRateArguments).toEqual(['-maxrate', '4000000', '-bufsize', '8000000']);
});
