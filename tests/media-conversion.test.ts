import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { probeMedia, startMediaSession, stopMediaSession, streamMedia, mediaSessionStatus } from '../lib/server/media-runtime';
import { verifyStream } from '../lib/server/health';
import { convertedSeek, mediaDuration, mediaPosition } from '../lib/playback';
import { openDatabase } from '../lib/server/db';
import { handleApi } from '../lib/server/api';
import { encrypt, hash } from '../lib/server/security';
import { synchronizePlaylist, checkSource } from '../lib/server/pipeline';

let directory: string, server: Server, base: string;
const sessions: string[] = [];
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'lume-conversion-'));
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '8', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'mpeg4', '-c:a', 'ac3', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=deu', join(directory, 'film.mkv')], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', join(directory, 'film.mkv'), '-map', '0:v', '-map', '0:a:0', '-c', 'copy', join(directory, 'film.avi')], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-stream_loop', '3', '-i', join(directory, 'film.mkv'), '-t', '24', '-map', '0:v', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mpegts', join(directory, 'channel.ts')], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
  server = createServer((request, response) => {
    if (request.url === '/denied') { response.writeHead(401); response.end('Denied'); return; }
    if (request.url === '/html') { response.setHeader('Content-Type', 'text/html'); response.end('<html>This is a login page rather than a video.</html>'); return; }
    if (request.url === '/continuous.ts') {
      // An HTTP broadcast has neither a content length nor an EOF/seek endpoint.
      const bytes = readFileSync(join(directory, 'channel.ts')); let offset = 0;
      response.writeHead(200, { 'Content-Type': 'video/mp2t' });
      const timer = setInterval(() => {
        if (response.writableNeedDrain) return;
        const end = Math.min(offset + 188 * 14, bytes.length); response.write(bytes.subarray(offset, end)); offset = end === bytes.length ? 0 : end;
      }, 10);
      response.on('close', () => clearInterval(timer)); return;
    }
    const file = request.url?.split('?')[0] === '/film.avi' ? 'film.avi' : 'film.mkv'; const bytes = readFileSync(join(directory, file));
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/); const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (range) response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    else response.writeHead(200, { 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' }); response.end(bytes.subarray(start, end + 1));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 40000);
afterAll(async () => {
  for (const id of sessions) stopMediaSession(id, 'test-viewer');
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (directory) {
    const target = resolve(directory), expected = resolve(tmpdir()) + sep + 'lume-conversion-';
    if (!target.startsWith(expected) || target.slice(expected.length).includes(sep)) throw new Error('Unsafe fixture cleanup path');
    rmSync(target, { recursive: true, force: true });
  }
});

it('verifies actual MKV and AVI video instead of excluding a file extension, retaining both audio languages', async () => {
  const probe = await probeMedia(base + '/film.mkv'); expect(probe.duration).toBeGreaterThan(7); expect(probe.audioTracks.map(track => track.language)).toEqual(['eng', 'deu']);
  for (const file of ['film.mkv', 'film.avi']) expect(await verifyStream(base + '/' + file)).toMatchObject({ ok: true, format: 'unknown', quality: '180p' });
  expect(await verifyStream(base + '/denied')).toMatchObject({ ok: false }); expect(await verifyStream(base + '/html')).toMatchObject({ ok: false });
}, 30000);

it('transcodes MKV into decodable H264/AAC, starts at a requested position and chooses the requested audio stream', async () => {
  const probe = await probeMedia(base + '/film.mkv'); const conversion = await startMediaSession({ sourceId: 'fixture', url: base + '/film.mkv', urlHash: 'fixture-hash', viewer: 'test-viewer', startAt: 3, audioTrack: probe.audioTracks[1].index }); sessions.push(conversion.sessionId);
  expect(conversion.startAt).toBe(3); expect(conversion.audioTrack).toBe(probe.audioTracks[1].index);
  const stream = await streamMedia(conversion.sessionId, 'test-viewer', new AbortController().signal); const bytes = Buffer.from(await new Response(stream).arrayBuffer());
  const output = join(directory, 'converted.mp4'); writeFileSync(output, bytes);
  const metadata = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', output], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  expect(metadata.streams.map((stream: any) => stream.codec_name)).toEqual(['h264', 'aac']); expect(Number(metadata.format.duration)).toBeLessThan(6);
  const pcm = execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', output, '-map', '0:a:0', '-t', '1', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], { windowsHide: true, timeout: 10000 });
  let crossings = 0;
  for (let offset = 4; offset < pcm.length; offset += 4) if (pcm.readFloatLE(offset - 4) <= 0 && pcm.readFloatLE(offset) > 0) crossings++;
  const frequency = crossings / (pcm.length / 4 / 8000);
  expect(frequency).toBeGreaterThan(840); expect(frequency).toBeLessThan(920); // German track is 880 Hz; English is 440 Hz.
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', output, '-frames:v', '3', '-f', 'null', '-'], { windowsHide: true, timeout: 10000, stdio: 'pipe' });
  expect(mediaSessionStatus(conversion.sessionId, 'test-viewer').status).toBe('complete');
  expect(() => mediaSessionStatus(conversion.sessionId, 'another-viewer')).toThrow(/expired/);
}, 30000);

it('does not turn canceled conversion or expired sessions into failed upstream files', async () => {
  const conversion = await startMediaSession({ sourceId: 'fixture', url: base + '/film.mkv', urlHash: 'fixture-hash', viewer: 'test-viewer' }); sessions.push(conversion.sessionId);
  const controller = new AbortController(); controller.abort(); await expect(streamMedia(conversion.sessionId, 'test-viewer', controller.signal)).rejects.toMatchObject({ classification: 'transient' });
  stopMediaSession(conversion.sessionId, 'another-viewer'); expect(mediaSessionStatus(conversion.sessionId, 'test-viewer').status).toBe('ready');
  stopMediaSession(conversion.sessionId, 'test-viewer'); expect(() => mediaSessionStatus(conversion.sessionId, 'test-viewer')).toThrow(/expired/);
});

it('starts a continuous HTTP MPEG-TS broadcast at the live edge without a saved duration or seek', async () => {
  const conversion = await startMediaSession({ sourceId: 'live-fixture', url: base + '/continuous.ts', urlHash: 'live-fixture-hash', viewer: 'test-viewer', startAt: 120, live: true }); sessions.push(conversion.sessionId);
  expect(conversion.duration).toBeNull(); expect(conversion.startAt).toBe(0);
  expect(conversion.audioTracks).toHaveLength(1);
  const controller = new AbortController();
  const stream = await streamMedia(conversion.sessionId, 'test-viewer', controller.signal); const reader = stream.getReader();
  const chunks: Buffer[] = []; let size = 0;
  while (size <= 4096) { const next = await reader.read(); expect(next.done).toBe(false); chunks.push(Buffer.from(next.value!)); size += next.value!.byteLength; }
  expect(Buffer.concat(chunks).includes(Buffer.from('ftyp'))).toBe(true);
  await reader.cancel(); expect(mediaSessionStatus(conversion.sessionId, 'test-viewer').status).toBe('ready');
}, 45000);

it('keeps original movie duration and position across converted seeks instead of saving segment-relative progress', () => {
  const conversion = { sessionId: 'sample', startAt: 120, duration: 7200, audioTracks: [] };
  expect(mediaPosition(12, conversion)).toBe(132); expect(mediaDuration(Infinity, conversion)).toBe(7200);
  const ranges = { length: 1, start: () => 0, end: () => 30 };
  expect(convertedSeek(135, conversion, ranges)).toEqual({ restart: false, local: 15 });
  expect(convertedSeek(3600, conversion, ranges).restart).toBe(true); expect(convertedSeek(20, conversion, ranges).restart).toBe(true);
});

it('authorizes conversion against saved sources and revokes media access after source changes', async () => {
  const db = await openDatabase(':memory:');
  const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
  const api = (path: string, method = 'GET', data?: unknown) => handleApi(new Request(origin + '/api/' + path, { method, headers: { origin, 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) }), db);
  let sessionId: string | undefined;
  try {
    await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,?)', ['conversion', 'Conversion fixture', encrypt(`#EXTM3U\n#EXTINF:-1 type="movie",Conversion Fixture (2020)\n${base}/film.mkv`), Date.now()]);
    await synchronizePlaylist(db, 'conversion');
    const row = (await db.get('SELECT id,title_id FROM sources'))!;
    await checkSource(db, row.id);
    const grant = (await (await api('playback/' + row.title_id)).json()).sources[0];
    expect(grant.conversionRequired).toBe(true);
    const input = { sourceId: grant.id, playbackAttemptToken: grant.playbackAttemptToken };
    expect((await api('playback/prepare', 'POST', { sourceId: grant.id, url: base + '/film.mkv' })).status).toBe(403);
    expect((await api('playback/prepare', 'POST', { ...input, sourceId: 'other-source' })).status).toBe(403);
    expect((await api('playback/prepare', 'POST', { ...input, startAt: -1 })).status).toBe(400);
    const prepared = await api('playback/prepare', 'POST', { ...input, url: base + '/denied', startAt: 2, audioTrack: 2 });
    expect(prepared.status).toBe(200);
    const source = (await prepared.json()).source; sessionId = source.conversion.sessionId;
    expect(source.conversion.startAt).toBe(2); expect(source.conversion.audioTrack).toBe(2);
    expect(source.url).not.toContain(base);
    const path = source.url.replace('/api/', '');
    expect((await api(path, 'HEAD')).headers.get('content-type')).toBe('video/mp4');
    expect((await api(path.replace(sessionId!, '0'.repeat(48)), 'HEAD')).status).toBe(403);
    await db.run('UPDATE sources SET enabled=0 WHERE id=?', [row.id]);
    expect((await api(path, 'HEAD')).status).toBe(403);
    expect((await api('playback/prepare', 'POST', input)).status).toBe(404);
    await db.run('UPDATE sources SET enabled=1,url_hash=? WHERE id=?', [hash(base + '/other.mkv'), row.id]);
    expect((await api('playback/prepare', 'POST', input)).status).toBe(409);
    expect((await api(path, 'HEAD')).status).toBe(403);
    await db.run('UPDATE sources SET url_hash=? WHERE id=?', [hash(base + '/film.mkv'), row.id]);
    await db.run("UPDATE titles SET type='live' WHERE id=?", [row.title_id]);
    expect((await api('playback/prepare', 'POST', { ...input, startAt: 2 })).status).toBe(400);
    const livePrepared = await api('playback/prepare', 'POST', { ...input, previousSessionId: sessionId });
    expect(livePrepared.status).toBe(200); const liveSource = (await livePrepared.json()).source;
    sessionId = liveSource.conversion.sessionId;
    expect(liveSource.conversion).toMatchObject({ duration: null, startAt: 0 });
    const livePath = liveSource.url.replace('/api/', '');
    expect((await api(livePath, 'HEAD')).status).toBe(200);
    await db.run('UPDATE titles SET published=0 WHERE id=?', [row.title_id]);
    expect((await api('playback/prepare', 'POST', input)).status).toBe(404);
    expect((await api(livePath, 'HEAD')).status).toBe(403);
    expect((await api(path, 'HEAD')).status).toBe(403);
    await api('playback/release', 'POST', { sessionId });
    expect((await api('playback/session/' + sessionId)).status).toBe(503);
  } finally { if (sessionId) stopMediaSession(sessionId, 'anonymous'); await db.close(); }
}, 30000);
