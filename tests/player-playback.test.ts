import { describe, expect, it } from 'vitest';
import { chooseLanguageSource, failoverDecision, GrantRefreshLimiter, isExpiredGrant, playbackTransferState, PlaybackSuccessEvidence, preferredSubtitle, rankSources, resumeSeekTarget, secondsLabel, skipWindow, sourceLanguageChoices } from '../lib/playback';
import type { Source } from '../lib/types';

const source = (id: string, overrides: Partial<Source> = {}): Source => ({ id, titleId: 'film', episodeId: null, name: id, format: 'mp4', health: 'healthy', enabled: true, priority: 0, quality: null, lastChecked: null, lastSuccess: null, error: null, url: `https://example.test/${id}.mp4`, ...overrides });

describe('source selection and failover', () => {
  it('puts measured health ahead of priority and excludes unusable sources', () => {
    const ordered = rankSources([source('degraded', { health: 'degraded', priority: 99, lastSuccess: 100 }), source('healthy'), source('unknown', { health: 'unknown' }), source('never-verified', { health: 'degraded' }), source('off', { enabled: false }), source('dead', { health: 'unavailable' }), source('no-url', { url: undefined })]);
    expect(ordered.map(entry => entry.id)).toEqual(['healthy', 'degraded']);
  });
  it('uses successful-check recency to break equally prioritized ties', () => {
    expect(rankSources([source('older', { lastSuccess: 10 }), source('newer', { lastSuccess: 20 })])[0].id).toBe('newer');
  });
  it('excludes formats the browser cannot play before choosing a server', () => {
    const ordered = rankSources([source('dash', { format: 'dash', priority: 100 }), source('mp4')], entry => entry.format !== 'dash');
    expect(ordered.map(entry => entry.id)).toEqual(['mp4']);
  });
  it('preserves time across failures and never cycles back through failed servers', () => {
    const sources = [source('one', { priority: 3 }), source('two', { priority: 2 }), source('three', { priority: 1 })];
    const first = failoverDecision(sources, 'one', [], 72.5);
    expect(first.source?.id).toBe('two');
    expect(first.position).toBe(72.5);
    const second = failoverDecision(sources, 'two', first.attemptedIds, first.position);
    expect(second.source?.id).toBe('three');
    expect(failoverDecision(sources, 'three', second.attemptedIds, 73).source).toBeNull();
  });
  it('sanitizes invalid seek positions', () => {
    expect(failoverDecision([source('a')], 'a', [], NaN).position).toBe(0);
    expect(failoverDecision([source('a')], 'a', [], -4).position).toBe(0);
  });
  it('avoids attempting expired grants even when their source has higher priority', () => {
    const ordered = rankSources([source('expired', { priority: 100, expiresAt: 1000 }), source('valid', { expiresAt: 3000 })], undefined, 2000);
    expect(ordered.map(entry => entry.id)).toEqual(['valid']);
    expect(isExpiredGrant({ expiresAt: 1000 }, 1000)).toBe(true);
    expect(isExpiredGrant({}, 2000)).toBe(false);
  });
});

describe('language versions and playback evidence', () => {
  it('offers only available normalized language versions and chooses a saved preference', () => {
    const sources = [source('english', { language: 'ENG', priority: 10 }), source('german-one', { language: 'de' }), source('german-two', { language: 'GER' }), source('turkish-blocked', { language: 'tr', playbackBlocked: true }), source('french-offline', { language: 'fr', health: 'unavailable' })];
    expect(sourceLanguageChoices(sources)).toEqual([{ code: 'en', label: 'English' }, { code: 'de', label: 'German' }]);
    expect(chooseLanguageSource(sources, 'German')?.id).toBe('german-one');
    expect(chooseLanguageSource(sources, 'French')?.id).toBe('english');
  });
  it('tries a same-language alternate without silently moving to another language', () => {
    const sources = [source('german-one', { language: 'de', priority: 5 }), source('english', { language: 'en', priority: 99 }), source('german-two', { language: 'de', priority: 1 })];
    const first = failoverDecision(sources, 'german-one', [], 184.5, 'de');
    expect(first.source?.id).toBe('german-two');
    expect(first.position).toBe(184.5);
    expect(failoverDecision(sources, 'german-two', first.attemptedIds, 185, 'de').source).toBeNull();
    expect(chooseLanguageSource(sources, 'en')?.id).toBe('english');
  });
  it('keeps untagged playable versions separate from known languages and excludes pending or blocked versions', () => {
    const sources = [source('untagged'), source('english', { language: 'en' }), source('german-pending', { language: 'de', health: 'unknown' }), source('turkish-blocked', { language: 'tr', playbackBlocked: true }), source('untagged-alternate')];
    expect(sourceLanguageChoices(sources)).toEqual([{ code: 'en', label: 'English' }, { code: 'und', label: 'Original / unspecified' }]);
    const decision = failoverDecision(sources, 'untagged', [], 38, 'und');
    expect(decision.source?.id).toBe('untagged-alternate');
    expect(failoverDecision(sources, 'untagged-alternate', decision.attemptedIds, 38, 'und').source).toBeNull();
  });
  it('retains playing intent and position through overlapping language connection requests', () => {
    const original = playbackTransferState({ currentTime: 184.5, paused: false, ended: false }, 0);
    const secondRequest = playbackTransferState({ currentTime: 0, paused: true, ended: false }, 0, original);
    expect(secondRequest).toEqual({ position: 184.5, playing: true });
    const paused = playbackTransferState({ currentTime: 62, paused: true, ended: false }, 0);
    expect(playbackTransferState({ currentTime: 0, paused: true, ended: false }, 0, paused)).toEqual({ position: 62, playing: false });
    expect(playbackTransferState(null, NaN)).toEqual({ position: 0, playing: false });
  });
  it('waits for a real duration before restoring position and handles shorter language versions', () => {
    expect(resumeSeekTarget(184.5, 0)).toBeNull();
    expect(resumeSeekTarget(184.5, NaN)).toBeNull();
    expect(resumeSeekTarget(184.5, Infinity)).toBeNull();
    expect(resumeSeekTarget(184.5, 600)).toBe(184.5);
    expect(resumeSeekTarget(184.5, 120)).toBe(119.8);
  });
  it('never automatically uses a playback-blocked source even after a container check passes', () => {
    const blocked = source('blocked', { health: 'healthy', playbackBlocked: true, playbackRetry: true, priority: 100 });
    expect(rankSources([blocked, source('working')]).map(entry => entry.id)).toEqual(['working']);
    expect(rankSources([blocked], undefined, Date.now(), true).map(entry => entry.id)).toEqual(['blocked']);
    expect(failoverDecision([source('failed'), blocked], 'failed', [], 10).source).toBeNull();
  });
  it('requires real playing and time advancement, excluding metadata, pauses, and seeks', () => {
    const evidence = new PlaybackSuccessEvidence();
    expect(evidence.advance(100, false, false)).toBe(false);
    evidence.playing(100);
    expect(evidence.advance(100.1, false, false)).toBe(false);
    expect(evidence.advance(101, true, false)).toBe(false);
    evidence.seeking();
    expect(evidence.advance(180, false, false)).toBe(false);
    evidence.playing(180);
    expect(evidence.advance(180.5, false, true)).toBe(false);
    expect(evidence.advance(180.5, false, false)).toBe(true);
    expect(evidence.advance(181, false, false)).toBe(false);
  });
});

describe('bounded playback access renewal', () => {
  it('renews an expired grant once and prevents renewed failure recursion', () => {
    const limiter = new GrantRefreshLimiter();
    expect(limiter.claim([{ expiresAt: 1000 }], 2000)).toBe(true);
    expect(limiter.claim([{ expiresAt: 3000 }], 4000)).toBe(false);
    expect(limiter.claim([{ expiresAt: 1000 }], 5000)).toBe(false);
  });
  it('does not consume the refresh budget for public or unexpired sources', () => {
    const limiter = new GrantRefreshLimiter();
    expect(limiter.claim([{}, { expiresAt: 3000 }], 2000)).toBe(false);
    expect(limiter.claim([{ expiresAt: NaN }, { expiresAt: -1 }], 2000)).toBe(false);
    expect(limiter.claim([{ expiresAt: 3000 }], 4000)).toBe(true);
  });
  it('permits a new bounded attempt after an explicit viewer retry', () => {
    const limiter = new GrantRefreshLimiter();
    expect(limiter.claim([{ expiresAt: 1000 }], 2000)).toBe(true);
    limiter.reset();
    expect(limiter.claim([{ expiresAt: 1000 }], 2000)).toBe(true);
  });
});

describe('verified timing', () => {
  it('shows skipping only inside an explicitly defined interval', () => {
    expect(skipWindow({ introStart: 10, introEnd: 30 }, 9)).toBeNull();
    expect(skipWindow({ introStart: 10, introEnd: 30 }, 10)).toEqual({ label: 'Skip intro', end: 30 });
    expect(skipWindow({ introStart: 10, introEnd: 30 }, 30)).toBeNull();
    expect(skipWindow({}, 12)).toBeNull();
    expect(skipWindow({ recapStart: 5, recapEnd: 3 }, 5)).toBeNull();
  });
  it('formats long films and unknown durations', () => {
    expect(secondsLabel(3671)).toBe('1:01:11');
    expect(secondsLabel(Infinity)).toBe('0:00');
  });
  it('matches available language tracks and leaves unavailable preferences off', () => {
    const tracks = [{ id: '0', language: 'en-US' }, { id: '1', language: 'fr' }];
    expect(preferredSubtitle(tracks, 'en')?.id).toBe('0');
    expect(preferredSubtitle(tracks, 'fr')?.id).toBe('1');
    expect(preferredSubtitle(tracks, 'de')).toBeNull();
    expect(preferredSubtitle(tracks, 'off')).toBeNull();
  });
});
