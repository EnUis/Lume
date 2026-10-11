# Verification record

Verified in the supplied workspace on 5 October 2026. The active installation uses PostgreSQL; the old local SQLite file is not its current catalog. [Earlier checks](VERIFICATION-2026-10-04.md) are retained as a dated historical record.

| Check | Result |
| --- | --- |
| Automated tests | 242 passed across 29 files |
| Complete application TypeScript check | Passed |
| Optimized Next.js production build | Passed in an isolated source copy, leaving the running development build intact |
| Active PostgreSQL | Schema 10; 360 titles, 386 sources, 2 playlists and 1 existing account |
| Public HTTP checks | 9 passed: catalog, live-type filter, channel search, discovery, saved collection, channel detail/playback exclusion, series metadata and About credits |
| Connected-browser visual checks | Clean Lume homepage with online artwork/description, no channel cards, concise hero text and working metadata attribution disclosure |
| Real browser playback | Spooks S1E1 advanced beyond 27 seconds, 1024×576 video, readyState 4, no media error; paused after verification |
| Background worker | Running with a recent PostgreSQL heartbeat; routine completed-job JSON absent from terminal logs |

## Changes applied to the existing library

A private consistent PostgreSQL snapshot and encryption configuration backup were taken before repair. No private database, source URL, credential, account or backup is included in the source download.

- Cleaned 352 movie/series title labels and recovered 65 release years. Eight compatible duplicate records were consolidated. Every previous title ID still resolves through a surviving record or redirect.
- Corrected 279 imported movie records that were actually continuous live channels, including channels grouped as “FILMSKI / MOVIE.” Together with 11 previously identified channels, all 290 live titles are excluded from public browsing, search, saved collections, detail and playback APIs. Administration retains them. Two residual empty-bracket labels were cleaned during this repair.
- Replaced 19 episode labels consisting only of the provider watermark with Episode 1, Episode 2, and the appropriate episode number. Narrative names and recorded manual edits remain protected.
- Verified preservation of all 386 source IDs and the account's existing password hash and role against the backup. Automated merge tests cover saved progress/history/lists/favorites, episode redirects, existing URL blocks, conflicting release years/provider IDs and metadata locks.
- Performed real no-key metadata lookups through TVmaze and Wikimedia against the active PostgreSQL database. Spooks, After.Life, District 9, The Astronaut Farmer and The Tomb received confirmed metadata. Additional missing fields continue through the bounded worker queue. Provider rate limits defer work and retry; ambiguous matches are left unchanged.
- Fixed a queue timestamp race that could immediately requeue a newly scheduled lookup, and numeric-title cleanup that could mistake a legitimate title number for a quality label or release year. Regression coverage includes actual watermark patterns and meaningful numeric titles.
- Account and guest playback resume resolve merged title and episode aliases. The visible player language menu shows only available versions. This installation currently offers Original / unspecified for the verified Spooks episode; no extra language is invented from the show's identity.

## Current playback and verification limits

At the final catalog check, Spooks was the one public title with available episodes. The 65 dated movie sources in the current playlist are Matroska/MKV files rejected by the browser player; artwork does not make those sources playable. They remain hidden until supported MP4, WebM or HLS renditions are supplied and verified. Other unpublished, unavailable or ambiguous records likewise remain outside public discovery.

Automated language-switch tests passed, including position/play-state preservation and language-specific failover. Switching between two real external language renditions, adaptive audio tracks, fullscreen/Picture-in-Picture, mobile layouts, formal load testing, Docker deployment and licensed TMDB credentials were not exercised in this update. Actual PostgreSQL catalog migration/repair, metadata transactions, worker scheduling and public APIs were exercised; this does not establish production-wide concurrency guarantees.

Public-source artwork retains its source and image-specific rights attribution. Metadata/provider configuration is described in [METADATA.md](METADATA.md). Health checks establish sampled availability at check time, not continuous availability on every device.
