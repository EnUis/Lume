// The HLS window plus retry grace can retain 46 seconds. VBV bounds keep
// even complex 720p footage comfortably below its 32 MiB memory budget.
export const MEDIA_RATE_LIMITS = { video: 4_000_000, audio: 160_000, buffer: 8_000_000 } as const;
export const mediaRateArguments = ['-maxrate', String(MEDIA_RATE_LIMITS.video), '-bufsize', String(MEDIA_RATE_LIMITS.buffer)];
