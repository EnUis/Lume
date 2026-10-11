# English display names and applied series cleanup

Verified on 9 October 2026 in the supplied Windows workspace. The previous [Live TV implementation report](VERIFICATION-LIVE-2026-10-09.md) and [admin report](VERIFICATION-ADMIN-2026-10-09.md) remain as historical records.

## Result

- Public title presentation cleans repeated show names, season/episode badges and channel distribution/quality labels. Actual season and episode numbers remain in the series structure and player.
- New imports use parser version 8. Original-name aliases preserve English titles during refreshes, including existing live-channel sources. Explicit episode coordinates can fill a previously missing assignment without changing the English title, source health or manual blocks. Decorated language/country tags and live-channel distribution badges are cleaned for display.
- Automatic metadata policy version 3 cleans names before searching, includes live channels, can resolve a confirmed IMDb identity, and prioritizes visible names with foreign lettering. Older metadata results are revisited while current provider cooldowns remain respected.
- Applied the offline series repair to the active PostgreSQL catalog: **10,017 series entries repaired**, **2,123 episode records recovered**, and **4,978 duplicate series entries merged**. Conflicting identities remain for review.
- Applied **53 reviewed English display labels**; 1 already matched. These include literal title translations and readable spellings of proper names/brands. Such translations do not establish a new film identity or audio language. Original names remain searchable aliases.
- The pictured show now displays **Elite School**, with its existing episodes under one series. Its English name and release year were checked against [ElCinema's record](https://elcinema.com/en/work/2090246/), which links [season 2](https://elcinema.com/en/work/2097711/) and [season 3](https://elcinema.com/en/work/2100375/). A source-by-source check confirmed the 35 imported episodes came from those three original season containers (10, 15 and 10 episodes); every existing episode ID and coordinate was retained. The application has no hardcoded show-name translation list.

## Verification

- Complete final suite: **335 tests across 40 files**, no failures. Full TypeScript check and isolated production build passed.
- A fresh private backup captured 108,591 titles, 306,186 sources, 182,387 episodes, 3 playlists and 1 user. The initial sequential preview was stopped after a representative sample and rolled back; committed repair then used bounded PostgreSQL concurrency with unchanged validation and per-title transaction checks.
- Read-only preservation comparison passed: original source IDs, encrypted URLs and hashes, enabled/removed flags, existing playback blocks, account password hashes and roles, original aliases and provider bindings were retained. Every previous title and episode ID either remains or resolves through a valid redirect.
- The restarted local app returned healthy responses. Live TV remained separate: **1,172 channels**, **2,780 movies**, **6 series** at verification. Counts may change as normal health checks resume.
- The live title endpoint returned **Elite School**, with **35 episodes**, and no season marker or duplicated Arabic label in its display name.
- Browser checks found no console warnings/errors on the inspected pages. Fallback cover typography was adjusted and visually checked so long titles use balanced whole-word wrapping.

## Limits

Automatic online matching depends on provider coverage and availability. Unmatched new entries retain their cleaned original identity until matched or reviewed; the worker does not invent movie identities. Manual display translations in this maintenance pass are distinct from verified release names. Existing stream language choices are unchanged.

The two visible series without artwork (Yu-Gi-Oh and Ultimate Spiderman) were explicitly queued and retried through the metadata pipeline. Their provider was temporarily cooling down; the application retains readable cover placeholders and the normal retry schedule until a confirmed match succeeds.

The restarted import worker still encountered upstream playlist failures: one HTTP 404 response and one playlist with no valid entries. The existing catalog was preserved. Those provider responses require a working upstream playlist; title cleanup does not fabricate replacement stream links.

Browser verification passed after restarting the app: the Elite School detail page showed its clean English heading, artwork and description, and its episode selector switched between three seasons. The separate Live TV category rendered channel cards. A screenshot is saved at `outputs/lume-clean-series.jpg` beside the app directory. A post-update scan found no remaining foreign-script labels in the visible catalog at verification time.
