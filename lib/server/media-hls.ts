/** A bounded HLS window over FFmpeg's fragmented MP4 output. No full movie is cached. */
type Fragment = { sequence: number; duration: number; body: Buffer };

function boxes(bytes: Buffer): { type: string; body: Buffer }[] {
  const result: { type: string; body: Buffer }[] = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    if (size < 8 || offset + size > bytes.length) throw new Error('Invalid converted video metadata.');
    result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), body: bytes.subarray(offset + 8, offset + size) });
    offset += size;
  }
  return result;
}

/** The converter fixes the video track to 24 fps / 24000 ticks per second. */
function fragmentDuration(moof: Buffer): number {
  for (const traf of boxes(moof.subarray(8)).filter(box => box.type === 'traf')) {
    const children = boxes(traf.body), header = children.find(box => box.type === 'tfhd')?.body;
    if (!header || header.readUInt32BE(4) !== 1) continue;
    const flags = header.readUIntBE(1, 3);
    let position = 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
    const defaultDuration = flags & 8 ? header.readUInt32BE(position) : 1000;
    let duration = 0;
    for (const run of children.filter(box => box.type === 'trun')) {
      const runFlags = run.body.readUIntBE(1, 3), count = run.body.readUInt32BE(4);
      position = 8 + (runFlags & 1 ? 4 : 0) + (runFlags & 4 ? 4 : 0);
      for (let index = 0; index < count; index++) {
        duration += runFlags & 0x100 ? run.body.readUInt32BE(position) : defaultDuration;
        position += (runFlags & 0x100 ? 4 : 0) + (runFlags & 0x200 ? 4 : 0) + (runFlags & 0x400 ? 4 : 0) + (runFlags & 0x800 ? 4 : 0);
      }
    }
    if (duration > 0) return duration / 24000;
  }
  throw new Error('Converted video has no timed video frames.');
}

export class MediaHlsWindow {
  private initialization = Buffer.alloc(0);
  private fragments: Fragment[] = [];
  private retired: { fragment: Fragment; until: number | null }[] = [];
  private longestPlaylist = 0;
  private nextSequence = 0;
  private lastRequested = -1;
  private complete = false;
  private error: unknown;
  private started = false;
  private waiters = new Set<() => void>();
  private controller = new AbortController();
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private bytes = 0;

  constructor(private open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>) {}

  private notify() { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  private async changed() {
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.waiters.delete(wake); resolve(); }, 1000);
      const wake = () => { clearTimeout(timer); resolve(); };
      this.waiters.add(wake);
    });
  }
  stop() {
    this.error ||= new Error('This playback session expired. Press retry to continue.');
    this.fragments = []; this.retired = []; this.initialization = Buffer.alloc(0); this.bytes = 0;
    this.controller.abort(); void this.reader?.cancel().catch(() => {}); this.notify();
  }
  private check() { if (this.error) throw this.error; }
  private pruneRetired() {
    const now = Date.now();
    this.retired = this.retired.filter(entry => {
      if (entry.until === null || entry.until > now) return true;
      this.bytes -= entry.fragment.body.length; return false;
    });
  }
  private start() {
    if (this.started) return;
    this.started = true;
    void this.pump().catch(error => { this.error = error; this.stop(); });
  }
  private async pump() {
    this.reader = (await this.open(this.controller.signal)).getReader();
    let pending = Buffer.alloc(0), moof: Buffer | undefined;
    try {
      while (!this.controller.signal.aborted) {
        // Pause the pipe when a viewer pauses: retain two old segments and at most
        // eight ahead, instead of letting a converted movie run away from them.
        while (this.nextSequence > this.lastRequested + 8 && !this.controller.signal.aborted) await this.changed();
        this.check();
        const next = await this.reader.read();
        if (next.done) { this.complete = true; this.notify(); return; }
        pending = Buffer.concat([pending, Buffer.from(next.value)]);
        while (pending.length >= 8) {
          const size = pending.readUInt32BE(0);
          if (size < 8 || size > 16 * 1024 * 1024) throw new Error('Converted video exceeded its segment limit.');
          if (pending.length < size) break;
          const box = pending.subarray(0, size), type = box.toString('ascii', 4, 8);
          pending = pending.subarray(size);
          if (type === 'ftyp' || type === 'moov') {
            if (this.initialization.length + box.length > 1024 * 1024) throw new Error('Converted video metadata is too large.');
            this.initialization = Buffer.concat([this.initialization, box]);
          } else if (type === 'moof') moof = box;
          else if (type === 'mdat' && moof) {
            const body = Buffer.concat([moof, box]);
            this.fragments.push({ sequence: this.nextSequence++, duration: fragmentDuration(moof), body }); this.bytes += body.length; moof = undefined;
            while (this.fragments[0]?.sequence < this.lastRequested - 2) this.retired.push({ fragment: this.fragments.shift()!, until: null });
            this.pruneRetired();
            if (this.bytes > 32 * 1024 * 1024) throw new Error('Converted video exceeded its memory limit.');
            this.notify();
            while (this.nextSequence > this.lastRequested + 8 && !this.controller.signal.aborted) await this.changed();
            this.check();
          }
        }
      }
    } finally { await this.reader.cancel().catch(() => {}); }
  }
  async resource(name: string, query = ''): Promise<{ body: Buffer; type: string }> {
    if (name !== 'index.m3u8' && name !== 'init.mp4' && !/^segment-\d+\.m4s$/.test(name)) throw new Error('Unknown video segment.');
    this.start();
    const deadline = Date.now() + 65000;
    while (!this.complete && this.fragments.length < 2) { this.check(); if (Date.now() >= deadline) throw new Error('Video preparation took too long. Please retry.'); await this.changed(); }
    this.check();
    this.pruneRetired();
    if (!this.fragments.length || !this.initialization.length) throw new Error('The converted video did not contain playable frames.');
    if (name === 'index.m3u8') {
      this.longestPlaylist = Math.max(this.longestPlaylist, this.fragments.reduce((sum, fragment) => sum + fragment.duration, 0));
      // RFC 8216 §6.2.2: requests from a previously issued playlist may still be
      // in flight. Start the grace period when removal is actually advertised.
      for (const entry of this.retired) if (entry.until === null) entry.until = Date.now() + (this.longestPlaylist + entry.fragment.duration) * 1000;
      const target = Math.max(2, ...this.fragments.map(fragment => Math.ceil(fragment.duration)));
      const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES', `#EXT-X-MEDIA-SEQUENCE:${this.fragments[0].sequence}`, `#EXT-X-MAP:URI="init.mp4${query}"`];
      for (const fragment of this.fragments) lines.push(`#EXTINF:${fragment.duration.toFixed(6)},`, `segment-${fragment.sequence}.m4s${query}`);
      if (this.complete) lines.push('#EXT-X-ENDLIST');
      return { body: Buffer.from(lines.join('\n') + '\n'), type: 'application/vnd.apple.mpegurl' };
    }
    if (name === 'init.mp4') return { body: this.initialization, type: 'video/mp4' };
    const sequence = Number(name.match(/^segment-(\d+)\.m4s$/)![1]);
    const fragment = this.fragments.find(value => value.sequence === sequence) || this.retired.find(entry => entry.fragment.sequence === sequence)?.fragment;
    if (!fragment) throw new Error('This video segment expired. Press retry to continue.');
    this.lastRequested = Math.max(this.lastRequested, sequence); this.notify();
    return { body: fragment.body, type: 'video/mp4' };
  }
}
