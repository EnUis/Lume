import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUEST_PROGRESS_KEY, mergeProgress, migrateGuestProgress, readGuestProgress, saveGuestProgress, validProgress } from '../lib/progress';
import type { Progress } from '../lib/types';

const entry = (overrides: Partial<Progress> = {}): Progress => ({ titleId: 'film', episodeId: null, position: 90, duration: 1000, updatedAt: Date.now() - 1000, ...overrides });

afterEach(() => { vi.unstubAllGlobals(); });

function browserStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, dispatchEvent: vi.fn() });
  vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
  return values;
}

describe('guest viewing history validation', () => {
  it('accepts valid film and episode entries', () => {
    expect(validProgress(entry())).toBe(true);
    expect(validProgress(entry({ episodeId: 'episode-1' }))).toBe(true);
  });
  it('rejects corrupt storage and impossible playback positions', () => {
    for (const value of [null, [], 'film', entry({ titleId: '' }), entry({ position: NaN }), entry({ position: -1 }), entry({ duration: Infinity }), entry({ position: 1001 }), entry({ updatedAt: Date.now() + 120_000 })]) expect(validProgress(value)).toBe(false);
  });
  it('keeps the latest timestamp without combining different episodes', () => {
    const old = entry({ updatedAt: 1000, position: 30 });
    const newer = entry({ updatedAt: 2000, position: 80 });
    const episode = entry({ episodeId: 'episode-2', updatedAt: 3000 });
    expect(mergeProgress([old, episode], [newer])).toEqual([episode, newer]);
  });
  it('drops invalid entries while preserving valid history', () => {
    expect(mergeProgress([entry(), entry({ duration: 0 }), entry({ titleId: 'bad', position: -2 })])).toHaveLength(1);
  });
  it('handles corrupt browser storage without breaking playback', () => {
    const storage = browserStorage();
    storage.set(GUEST_PROGRESS_KEY, '{broken');
    expect(readGuestProgress()).toEqual([]);
    expect(saveGuestProgress(entry())).toBe(true);
    expect(readGuestProgress()).toHaveLength(1);
  });
  it('does not discard guest history when account migration fails', async () => {
    browserStorage();
    const original = entry();
    saveGuestProgress(original);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Your viewing history could not be transferred. Please try again.' }, { status: 503 })));
    await expect(migrateGuestProgress()).rejects.toThrow('could not be transferred');
    expect(readGuestProgress()).toEqual([original]);
  });
  it('preserves newer progress created during account migration', async () => {
    browserStorage();
    const original = entry({ updatedAt: Date.now() - 2000 });
    const newer = entry({ position: 120, updatedAt: Date.now() - 1000 });
    saveGuestProgress(original);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => { saveGuestProgress(newer); return Response.json({ migrated: 1 }); }));
    expect(await migrateGuestProgress()).toBe(1);
    expect(readGuestProgress()).toEqual([newer]);
  });
  it('retains a partially accepted migration because rejected entries are not identified', async () => {
    browserStorage();
    saveGuestProgress(entry());
    saveGuestProgress(entry({ titleId: 'another-film' }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ migrated: 1 })));
    expect(await migrateGuestProgress()).toBe(1);
    expect(readGuestProgress()).toHaveLength(2);
  });
  it('batches a large guest history within the account API limit', async () => {
    const storage = browserStorage();
    storage.set(GUEST_PROGRESS_KEY, JSON.stringify(Array.from({ length: 350 }, (_, index) => entry({ titleId: `film-${index}` }))));
    const sizes: number[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
      const size = JSON.parse(options.body as string).progress.length;
      sizes.push(size);
      return Response.json({ migrated: size });
    }));
    expect(await migrateGuestProgress()).toBe(350);
    expect(sizes).toEqual([300, 50]);
    expect(readGuestProgress()).toEqual([]);
  });
});
