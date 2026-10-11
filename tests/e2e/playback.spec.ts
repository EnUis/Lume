import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Progress, Source, Title } from '../../lib/types';

type Sample = { title: Title; source: Source };
const progressStorageKey = 'luma.progress.v1';

async function authorizedSample(request: APIRequestContext): Promise<Sample> {
  const overrideId = process.env.E2E_TITLE_ID;
  const catalogResponse = await request.get('/api/catalog?type=movie&limit=100');
  expect(catalogResponse.ok(), 'The running application must expose its real catalog API.').toBeTruthy();
  const { titles } = await catalogResponse.json() as { titles: Title[] };
  const candidates = titles.filter(title => overrideId ? title.id === overrideId : title.demo)
    .sort((a, b) => Number(b.name.toLowerCase().includes('big buck bunny')) - Number(a.name.toLowerCase().includes('big buck bunny')));
  expect(candidates.length, 'Initialize the licensed sample catalog and run the worker until a sample source is verified, or set E2E_TITLE_ID to an authorized movie.').toBeGreaterThan(0);
  for (const title of candidates) {
    const response = await request.get(`/api/playback/${title.id}`);
    if (!response.ok()) continue;
    const { sources } = await response.json() as { sources: Source[] };
    const source = sources.find(entry => entry.url && entry.format === 'mp4');
    if (source) return { title, source };
  }
  throw new Error('These playback tests require a verified MP4 sample so that genuine decoding, seeking, and independent source failures can be checked.');
}

async function reveal(page: Page) {
  const size = page.viewportSize()!;
  await page.mouse.move(size.width / 2, size.height - 90);
}

async function waitForPlayableVideo(page: Page) {
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).readyState), {
    timeout: 60_000, message: 'The actual sample must load metadata and a decodable frame.',
  }).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
}

async function startAndAdvance(page: Page) {
  await waitForPlayableVideo(page);
  await reveal(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime), {
    timeout: 20_000, message: 'Video time must advance through real decoded media.',
  }).toBeGreaterThan(1);
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).videoHeight)).toBeGreaterThan(0);
}

async function seekWithKeyboard(page: Page) {
  await page.locator('.player-frame').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(20);
  await reveal(page);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  return page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime);
}

async function savedGuestPosition(page: Page, titleId: string) {
  return page.evaluate(({ key, id }) => {
    const entries = JSON.parse(localStorage.getItem(key) || '[]') as Progress[];
    return entries.find(entry => entry.titleId === id)?.position ?? 0;
  }, { key: progressStorageKey, id: titleId });
}

async function pinRealSource(page: Page, sample: Sample) {
  await page.route(`**/api/playback/${sample.title.id}*`, route => route.fulfill({ json: { sources: [sample.source] } }));
}

test('real sample time advances, guest progress persists, and refreshing resumes the saved position', async ({ page, request }) => {
  const sample = await authorizedSample(request);
  await pinRealSource(page, sample);
  await page.goto(`/watch/${sample.title.id}`);
  await startAndAdvance(page);
  const position = await seekWithKeyboard(page);
  await expect.poll(() => savedGuestPosition(page, sample.title.id)).toBeGreaterThan(20);
  await page.reload();
  await waitForPlayableVideo(page);
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(position - 1);
  expect(await page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeLessThan(position + 2);
  await page.goto('/');
  const continuing = page.locator('section').filter({ has: page.getByRole('heading', { name: /Pick up where you left off/ }) });
  await expect(continuing.getByRole('link', { name: `View ${sample.title.name}`, exact: true })).toBeVisible();
});

test('manual source switching keeps the actual decoded playback timestamp', async ({ page, request }) => {
  const sample = await authorizedSample(request);
  const first = { ...sample.source, id: `e2e-primary-${sample.source.id}`, name: 'E2E primary', priority: 100 };
  const backup = { ...sample.source, id: `e2e-backup-${sample.source.id}`, name: 'E2E backup', priority: 10 };
  // Only the source list is controlled; both entries play actual authorized media bytes.
  await page.route(`**/api/playback/${sample.title.id}*`, route => route.fulfill({ json: { sources: [first, backup] } }));
  await page.goto(`/watch/${sample.title.id}`);
  await startAndAdvance(page);
  const before = await seekWithKeyboard(page);
  await reveal(page);
  await page.getByRole('button', { name: 'Select playback server' }).click();
  await page.getByRole('button', { name: /E2E backup/ }).click();
  await waitForPlayableVideo(page);
  await expect(page.locator('.player-stream-name')).toContainText('E2E backup');
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(before - 1);
  expect(await page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeLessThan(before + 2);
  expect(await page.locator('video').evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
});

test('a failed first media connection automatically falls back to a genuine working stream', async ({ page, request, baseURL }) => {
  const sample = await authorizedSample(request);
  const brokenUrl = new URL('/__e2e__/unreachable.mp4', baseURL).toString();
  const first = { ...sample.source, id: `e2e-broken-${sample.source.id}`, name: 'E2E interrupted', url: brokenUrl, priority: 100 };
  const backup = { ...sample.source, id: `e2e-working-${sample.source.id}`, name: 'E2E working', priority: 10 };
  const reported: string[] = [];
  await page.route('**/__e2e__/unreachable.mp4', route => route.abort('failed'));
  await page.route('**/api/playback/failure', async route => {
    reported.push((route.request().postDataJSON() as { sourceId: string }).sourceId);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/playback/${sample.title.id}*`, route => route.fulfill({ json: { sources: [first, backup] } }));
  await page.goto(`/watch/${sample.title.id}`);
  await startAndAdvance(page);
  await expect(page.locator('.player-stream-name')).toContainText('E2E working');
  expect(reported).toContain(first.id);
  expect(await page.locator('video').evaluate(element => (element as HTMLVideoElement).currentSrc)).toBe(sample.source.url);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test.describe('mobile viewer', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('mobile menu works and guest viewing history remains available after navigation', async ({ page, request }) => {
    const sample = await authorizedSample(request);
    await page.goto('/');
    await page.getByRole('button', { name: 'Toggle menu' }).tap();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Movies', exact: true }).tap();
    await expect(page).toHaveURL(/view=movie/);
    await expect(page.getByRole('heading', { name: 'Movie night, made.' })).toBeVisible();
    await pinRealSource(page, sample);
    await page.goto(`/watch/${sample.title.id}`);
    await startAndAdvance(page);
    const video = page.locator('video');
    // A programmatic seek sets up history; native seeked events still exercise the player save path.
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 21; });
    await expect.poll(() => savedGuestPosition(page, sample.title.id)).toBeGreaterThanOrEqual(20);
    await video.tap();
    await page.getByRole('button', { name: 'Playback settings' }).tap();
    await expect(page.getByRole('slider', { name: 'Playback volume' })).toBeVisible();
    await page.getByRole('button', { name: 'Playback servers', exact: true }).tap();
    await expect(page.getByRole('complementary', { name: 'Playback servers' })).toBeVisible();
    await page.getByRole('button', { name: 'Close panel' }).tap();
    await page.getByRole('link', { name: 'Back to title' }).tap();
    await expect(page.getByRole('link', { name: 'Continue watching', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('link', { name: 'Continue watching', exact: true })).toBeVisible();
    expect(await savedGuestPosition(page, sample.title.id)).toBeGreaterThanOrEqual(20);
  });
});
