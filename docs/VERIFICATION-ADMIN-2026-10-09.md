# Playlist errors and admin layout verification

Verified on 9 October 2026 in the supplied Windows workspace. Previous [media playback verification](VERIFICATION-MEDIA-2026-10-05.md) and [catalog cleanup verification](VERIFICATION-CATALOG-2026-10-05.md) remain available.

## Provider diagnosis

The two saved GitHub-hosted playlists returned HTTP 404. Their repositories still exist, but GitHub commit records show both configured playlist files were removed on 5 October 2026, not renamed. No replacement link was found. The third provider returned an empty HTTP 885 response. That provider-specific code does not establish the cause; the provider must confirm a working link. No saved provider URL was changed or exposed.

Failed playlist refreshes retain saved sources and metadata. Viewer availability still depends on verified streams, publication and playlist enablement. The current catalog contains 66 visible titles (65 movies and 1 series), with live channels excluded.

## Changes

- Distinguish queued first imports, scheduled retries, active refreshes, exhausted jobs and disabled playlists. Show the previous provider failure once with an actionable explanation.
- Back off repeated permanent provider failures for at least one hour and honor bounded Retry-After responses. Manual Refresh now advances a waiting retry without taking over a running lease.
- Replacing a playlist link clears obsolete failure state and queues the new configuration. A stale in-flight fetch cannot overwrite a replacement link's import. Repeated guards use bounded encrypted fingerprints rather than transferring an entire uploaded file per batch.
- Retain concise worker logging and back off repeated worker startup failures.
- Replace the wide playlist table with responsive cards, visible-title counts, separate refresh information, expandable stream counts, search and attention filtering. Improve typography, spacing, input styling and checkbox/slider defaults.
- Expired admin access clears privileged screen state. Catalog requests discard obsolete results and successful searches clear stale errors.

## Checks

- Complete automated suite: 261 tests passed across 34 files. After the final presentation and large-upload changes, 16 focused tests passed (10 import-performance and 6 presentation tests). This covers 268 distinct tests across the two runs. The backend retry/starter subset also passed after its final change.
- Full application TypeScript check passed after the final code changes.
- Optimized Next.js production build passed in a separate source copy without private environment files or active data.
- Desktop 1440px and phone 390px checks rendered the actual playlist React component and application CSS with fictional fixture data. Neither layout overflowed the page horizontally, and the native stream-details disclosure opened correctly. These were read-only component previews, not an authenticated end-to-end admin session.
- The actual running app's admin gate and sign-in form rendered without browser errors. No password reset or account change was made. Authenticated refresh/edit behavior was verified through isolated API regression tests.
- Running local health endpoint returned 200 with the active PostgreSQL database connected. Public catalog returned 200, 66 total titles, and no live channels. Unauthenticated admin access returned 401 as expected. Background worker heartbeat is online.
- Compared with a private consistent database backup: no missing source IDs, no missing title IDs, no changed account password hashes or roles. Totals: 1 user, 3 playlists, 6,992 titles and 7,064 sources. Background health work can change availability over time.

## Remaining external dependency

New valid links are needed for the deleted provider playlists; response 885 requires a working provider response. Application fixes cannot recreate deleted third-party files or make an unavailable provider deliver content. Existing verified content remains available while these refreshes need attention.
