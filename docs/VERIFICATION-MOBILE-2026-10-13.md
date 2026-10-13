# Mobile playback and playlist processing

Verified locally on 13 October 2026. The release starts from the current GitHub
main branch and preserves its Render Dockerfile and database startup script.

## Changes

- Safari prefers native HLS. Incompatible and mixed-content sources can use
  same-origin H.264/AAC conversion with signed, bounded HLS fragments.
- Native playback starts without waiting for metadata after a source change.
  A rejected autoplay request restores an accessible Play button. Stale play
  rejections cannot interrupt a later successful tap.
- Startup requests bound both headers and bodies; merged series details have a
  separate larger response bound. Mobile layouts include touch and safe-area fixes.
- Import batches preserve grouping, blocked URLs and durable jobs while reducing
  database calls. Unchanged snapshots bypass parsing.
- PostgreSQL claims use one atomic statement with indexed queue heads and
  SKIP LOCKED. Verification defaults to eight lanes, with four checks per origin
  and four expensive probes. Local resource waiting does not hide a source.
- First-title scheduling advances through sparse windows with bounded work and
  resumes after the last promoted title. Millisecond arithmetic uses BIGINT.

## Results

- 410 application tests passed. Seven PostgreSQL tests skipped in that invocation
  passed separately against an isolated PostgreSQL 17 container.
- Real PostgreSQL tests cover simultaneous claims, retry/lease ownership, locked
  rows, timestamp scheduling, advisory locks, URL blocks and batched imports.
- Five browser lifecycle regressions passed using real taps and controlled
  WebKit-style media behavior. These do not emulate physical iPhone decoding.
- Actual FFmpeg conversion tests passed. TypeScript and production build passed.
- An isolated 2,000-entry benchmark reduced movie import database calls from
  10,145 to 2,205 (78%) and episode calls from 12,439 to 4,499 (64%). These figures
  measure database calls, not a guarantee of provider or production throughput.
- EXPLAIN on 20,000 PostgreSQL jobs confirmed indexed queue heads and terminal
  cleanup. Advisory-lock plans sort URL keys before acquiring locks.

GitHub Actions could not start because GitHub reports an account billing lock;
the checks above were run locally. A physical iPhone was not available for final
device testing. Provider availability and the web server's conversion capacity
continue to affect playback.
