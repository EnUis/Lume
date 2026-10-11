# MKV playback verification

Verified on 5 October 2026 in the supplied workspace. The active installation uses PostgreSQL; the old SQLite catalog was not modified. [Earlier catalog cleanup and metadata verification](VERIFICATION-CATALOG-2026-10-05.md) is retained as history; its former MKV restriction has been replaced by this update.

## Playback verified

- Generated real MKV and AVI files with MPEG-4 video and two AC3 audio tracks. Both passed health checks through actual ffprobe inspection.
- Converted MKV to decodable H.264/AAC fragmented MP4, sought to a requested offset, and checked the selected second audio track by measuring its 880 Hz test tone rather than only checking a menu label.
- In the connected browser, the existing District 9 MKV played as 1024×576 video, readyState 4, with no media error. Playback advanced beyond 39 seconds.
- Seeking to 5:00 started a new converted stream and playback advanced beyond 5:39. Reopening the watch page restored 6:18 and playback continued to 6:50. The browser error log was empty. A screenshot is provided alongside the source archive.
- Rechecked all 68 sources carrying the former Matroska-format rejection. All 68 passed actual upstream/video inspection and became healthy; their URLs and IDs were preserved.
- Temporary server capacity, missing tools, cancellation and expired sessions do not hide an upstream movie. Broken/denied links and confirmed decode failures remain unavailable. Live channels remain excluded from client discovery and playback.

## Authorization and reliability

Conversion API regression tests reject missing or mismatched attempt tokens, changed source URLs, disabled sources, live channels, incorrect session access and invalid seek input. A supplied arbitrary client URL is ignored in favor of the saved source. Released sessions expire and sessions are isolated by viewer. Database recovery tests cover idle pool errors and transaction disconnects without leaking private connection details or crashing on unhandled error events.

Release checks: 249 automated tests passed across 31 files; complete application TypeScript check passed; optimized Next.js production build passed in an isolated copy. A functional 100,001-entry import regression exceeded its old 15-second timeout on this busy 8 GB development computer; the test still checks all entries and errors, with a 60-second allowance. No playlist limits were added.

## Existing data and remaining work

A private consistent PostgreSQL snapshot and encryption configuration backup preceded changes. Checks against that snapshot found no lost source/title IDs and no changed password hash or role. New playlists continue to import and verify in the background, so catalog totals change while the worker runs. Missing images/descriptions continue through the existing bounded metadata queue.

This update verifies one real external MKV in the browser plus local multi-track MKV/AVI fixtures. It does not promise playback for corrupted video, unavailable providers, DRM-protected streams or codecs absent from the installed FFmpeg build. Converted output is at most 1280 pixels wide with AAC stereo; embedded subtitle conversion and HDR tone mapping are not included. Docker configuration includes FFmpeg but Docker deployment, load testing and multiple web-instance routing were not exercised. See [MEDIA.md](MEDIA.md) for deployment and session limits.
