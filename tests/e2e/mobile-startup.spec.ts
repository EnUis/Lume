import { expect, test, type Page } from '@playwright/test';

// These are player lifecycle regressions, not a claim to emulate an iPhone
// decoder. Actual HLS/MP4 bytes are checked separately by media-conversion.test.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  launchOptions: { args: ['--disable-gpu', '--disable-renderer-backgrounding', '--disable-frame-rate-limit'] },
});

async function fixture(page: Page, kind: 'movie' | 'series' | 'live', gate: boolean | 'delayed') {
  await page.addInitScript(({ gate }) => {
    const values = new WeakMap<HTMLMediaElement, { ready: number; paused: boolean; time: number; src: string }>();
    const state = (video: HTMLMediaElement) => {
      let entry = values.get(video);
      if (!entry) { entry = { ready: 0, paused: true, time: 0, src: '' }; values.set(video, entry); }
      return entry;
    };
    const calls: string[] = [];
    Object.assign(window, { mobilePlayCalls: calls });
    HTMLMediaElement.prototype.canPlayType = function(type) { return /mpegurl|mp4/.test(type) ? 'probably' : ''; };
    Object.defineProperties(HTMLMediaElement.prototype, {
      // Keep genuine decoder/network events from interfering with this controlled
      // lifecycle fixture. No provider or synthetic manifest is ever fetched.
      src: { get() { return state(this).src; }, set(src) { state(this).src = src; } },
      readyState: { get() { return state(this).ready; } },
      paused: { get() { return state(this).paused; } },
      duration: { get() { return state(this).ready ? 60 : NaN; } },
      currentTime: { get() { return state(this).time; }, set(time) { state(this).time = time; } },
    });
    HTMLMediaElement.prototype.load = function() { state(this).ready = 0; state(this).paused = true; };
    HTMLMediaElement.prototype.pause = function() { if (!state(this).paused) { state(this).paused = true; this.dispatchEvent(new Event('pause')); } };
    HTMLMediaElement.prototype.play = function() {
      const src = state(this).src;
      calls.push(src);
      if (src.includes('original.mp4')) return Promise.reject(new DOMException('Requires compatible playback', 'NotSupportedError'));
      if (!src) return Promise.reject(new DOMException('Missing source', 'NotSupportedError'));
      // WebKit may refuse an asynchronous source replacement and withhold
      // metadata until a new tap. The player must expose that tap immediately.
      if (gate && calls.filter(value => value.includes('/hls/')).length === 1) {
        if (gate === 'delayed') return new Promise<void>((_resolve, reject) => Object.assign(window, { rejectEarlierPlay: () => reject(new DOMException('Earlier attempt refused', 'NotAllowedError')) }));
        return Promise.reject(new DOMException('Fresh tap required', 'NotAllowedError'));
      }
      state(this).paused = false; state(this).ready = 4; state(this).time = 1;
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('loadedmetadata'));
      this.dispatchEvent(new Event('playing'));
      this.dispatchEvent(new Event('timeupdate'));
      return Promise.resolve();
    };
  }, { gate });
  const source = { id: 'fixture-source', titleId: 'mobile-fixture', episodeId: kind === 'series' ? 'episode-one' : null, name: 'Fixture', format: 'mp4', url: 'https://media.invalid/original.mp4', priority: 1, enabled: true, health: 'healthy', playbackAttemptToken: 'fixture-token' };
  const episodes = kind === 'series' ? [{ id: 'episode-one', titleId: 'mobile-fixture', season: 1, number: 1, name: 'Episode one', available: true }] : [];
  const prepared: object[] = [], failures: object[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/titles/mobile-fixture') body = { title: { id: 'mobile-fixture', name: 'Mobile fixture', type: kind, episodes } };
    else if (path === '/api/auth/me') body = { user: null };
    else if (path === '/api/progress') body = { progress: [] };
    else if (path === '/api/preferences') body = { preferences: { autoplay: true, language: 'en' } };
    else if (path === '/api/playback/mobile-fixture') body = { sources: [source] };
    else if (path === '/api/playback/prepare') {
      prepared.push(route.request().postDataJSON());
      body = { source: { ...source, format: 'hls', url: '/api/media/mobile-session/hls/index.m3u8?access=fixture', conversion: { sessionId: 'mobile-session', duration: kind === 'live' ? null : 60, startAt: 0, audioTracks: [] } } };
    } else if (path === '/api/playback/failure') { failures.push(route.request().postDataJSON()); body = { ok: true }; }
    else body = { ok: true };
    await route.fulfill({ json: body });
  });
  await page.goto('/watch/mobile-fixture');
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; } nextjs-portal { display: none !important; }' });
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeVisible({ timeout: 30000 });
  return { prepared, failures };
}

for (const kind of ['movie', 'series', 'live'] as const) {
  test(`${kind}: source conversion exposes a fresh tap when native HLS defers metadata`, async ({ page }) => {
    const { prepared, failures } = await fixture(page, kind, true);
    await page.getByRole('button', { name: 'Play video', exact: true }).tap();
    await expect.poll(() => prepared.length).toBe(1);
    expect(prepared[0]).toMatchObject({ delivery: 'hls', startAt: 0 });
    await expect(page.getByText('Tap play to continue.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Play video', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    expect(failures).toEqual([]);
    expect(await page.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime)).toBe(1);
  });
}

test('a permitted source replacement starts before native metadata has loaded', async ({ page }) => {
  const { failures } = await fixture(page, 'movie', false);
  await page.getByRole('button', { name: 'Play video', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test('a late gesture rejection cannot undo a later successful play on the same source', async ({ page }) => {
  const { failures } = await fixture(page, 'movie', 'delayed');
  await page.getByRole('button', { name: 'Play video', exact: true }).tap();
  await expect.poll(() => page.evaluate(() => (window as unknown as { mobilePlayCalls: string[] }).mobilePlayCalls.filter(src => src.includes('/hls/')).length)).toBe(1);
  await page.getByRole('button', { name: 'Play', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { rejectEarlierPlay: () => void }).rejectEarlierPlay());
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});
