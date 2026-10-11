# Live TV, artwork, English titles and episode grouping

Checked on 9 October 2026 in the supplied Windows workspace. Previous [admin and playlist verification](VERIFICATION-ADMIN-2026-10-09.md), [media verification](VERIFICATION-MEDIA-2026-10-05.md), and [catalog verification](VERIFICATION-CATALOG-2026-10-05.md) remain available as historical reports.

## Implemented

- A separate **Live TV** navigation category, channel search, channel cards, detail pages and live playback. Ordinary discovery remains movies and series. Public channels still require a verified available source from an enabled playlist. Live playback avoids movie resume offsets and seek controls.
- Artwork components try the available poster or backdrop when the preferred image fails. When neither image works, a styled title fallback replaces the broken image. Channel logos retain their proportions. Metadata scheduling now considers missing banners as well as missing posters and descriptions.
- Verified English display names from supported metadata providers, with original names retained as searchable aliases. Subsequent imports recognize those aliases and preserve the English name. Ambiguous matches, conflicting identities and administrator locks remain protected.
- Episode parsing covers `S1 EP1`, `S1EP1`, `Season 1 Ep. 1`, leading episode markers and repeated show/season labels. An offline, batched repair combines compatible existing episode cards into series, retaining seasons, episode numbers, language sources, account collections and playback redirects. See [series repair](SERIES-REPAIR.md).

## Validation

- The complete automated test run passed: **307 tests across 38 files**, with no failures. It covers live visibility and playback routing, real continuous transport-stream conversion, artwork selection, English alias reimports, episode parsing and repair, old playback/progress redirects, authentication and the existing import/health behavior.
- The full TypeScript check passed.
- The optimized Next.js production build passed in an isolated source copy without private environment files or active catalog data.
- Read-only checks against the active PostgreSQL database found **1,181 eligible live channels**, **2,721 movies** and **6 series** through the updated catalog helpers. These counts are a snapshot; background verification can change availability.
- The existing server health endpoint returned HTTP 200 with its database connected. Its live catalog still returned zero channels, indicating it had not loaded the updated behavior.
- A consistent private backup captured 28 tables, 108,346 titles, 300,586 sources, 3 playlists and 1 user before this repair work. Background imports continued afterward. Private database backups and encryption material are excluded from the source archive.

## Pending application to the active library

Windows denied access to stop the existing local server process. The user was asked to stop Lume in its terminal with Ctrl+C. The active catalog repair and forced metadata backfill have **not** been applied while that process and its background work remain running. A fresh backup, dry-run review, committed repair and restart are still needed; code and isolated tests are complete.

Browser automation could not attach to the in-app browser because its focus-emulation command timed out. This update has no completed visual browser inspection or authenticated end-to-end browser verification. The earlier admin screenshots belong to the previous report, not this update.

English names and artwork require a confirmed provider match. The active configuration has no TMDB or licensed-provider key, so the public provider fallbacks apply. Unmatched entries keep their existing names and title fallback; the app does not invent translations or substitute unrelated posters. Details and attribution are documented in [metadata](METADATA.md).
