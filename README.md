# Lume

A functional movie and TV streaming application with an original cinematic interface, persistent catalog, playlist ingestion, independently verified streams, background synchronization, optional accounts, and a custom player.

See [verification and deployment limits](docs/VERIFICATION.md) for the checks performed locally, including the active PostgreSQL catalog. Docker deployment and full browser playback coverage remain unverified.

## Run locally

Requirements: Node.js 24+, npm, and FFmpeg with ffprobe on PATH (or configured executable paths). SQLite is included in Node; no database installation is needed for development.

```sh
npm ci
npm run init
npm run dev
```

Open **http://127.0.0.1:3000**. Local `npm run dev` now starts both the website and its background importer/health worker automatically, restarts the worker if it exits, and stops it when the app closes. Imports are queued, processed in batches, and then checked per source. Keep the app running while a large playlist is being processed. The homepage refreshes visible content automatically as verification completes.

A few representative, never-checked sources from each new playlist are checked before the older bulk queue, allowing working titles to appear while the rest of a large import is verified. This changes scheduling only; every public title still needs a successful real source check.

The worker also prioritizes one never-checked source per published title that has no working source yet, before additional episodes, languages, or servers. Each scheduling pass scans at most 1,000 titles and promotes at most 100 checks; existing retries and playback blocks are preserved. Imports and metadata have their own worker lanes. `HEALTH_CONCURRENCY` controls only simultaneous stream checks (1–4, default 4), bounded by the video-probing capacity.

Admin counts distinguish **verified stream links** from **visible titles**. Several links can belong to one title, and a verified link attached to an unpublished or incomplete title still cannot appear publicly. The playlist card shows these reasons separately, plus how many streams were checked in the last ten minutes. Title reviews overlap stream counts and are not a fourth source-health status.

The admin playlist table shows queued/importing/verification/review stages, source counts, and visible titles. An offline-worker warning identifies stopped processing instead of implying that a saved playlist is already playable. Production Docker continues to run its separate worker service. Set `DEV_WORKER_AUTOSTART=false` only if you deliberately run a separate development worker; `npm run worker -- --once` drains currently due jobs once.

In an environment that blocks executable dependency install helpers, `npm ci --ignore-scripts` works with the supplied in-process CLI and test configuration. Typechecking remains a separate required check.

The initial catalog imports actual Blender open films through the same ingestion pipeline used for administrator playlists: **Big Buck Bunny**, **Tears of Steel**, and the clearly labeled **Sintel official trailer**. Unknown sources remain hidden until the worker verifies them. The sample playlist can be disabled or deleted in administration. Do not import content without distribution rights.

### Create your administrator

There are no default credentials. In PowerShell:

```powershell
$lumaPassword = Read-Host 'Choose a password of at least 12 characters' -AsSecureString
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $lumaPassword).Password
npm run admin -- --email you@example.com --name 'Library administrator'
Remove-Item Env:ADMIN_PASSWORD
```

On macOS/Linux, set `ADMIN_PASSWORD` through your secret manager or a hidden terminal prompt, then run `npm run admin -- --email you@example.com --name 'Library administrator'`. Avoid putting the password in shell arguments or history.

Sign in at **/admin**. Add authorized playlist URLs or upload files, choose a refresh interval, and inspect job reports. Local development starts the worker automatically; deployed services need the separate worker running. Administrators can appoint editors through the role-management API; editors cannot perform destructive catalog operations.

## How it works

- The PostgreSQL deployment and SQLite development database use a normalized SQL schema with migrations and indexes. Videos remain separate source records linked to a movie or an individual episode.
- M3U entries are classified as movies, episodes, or live channels. Movies and TV shows have their own default discovery feeds; Live TV is a separate category with channel playback and bookmarks, without saved-position resume. All categories require verified, enabled sources. Exact identifiers and conservative title/year matching merge servers. Ambiguous identities enter a review queue, including missing-year/remake conflicts.
- Movie and series names drop recognized language, quality and provider labels. Release years are stored separately. Compatible versions share one clean title and retain individual source languages for the player's language selector. Real title words, conflicting remakes and administrator edits remain protected.
- Missing covers and descriptions are filled automatically through TVmaze for series and Wikidata/Wikipedia for films, with exact name/type/year checks, source credits, cached results and bounded background requests. Existing artwork and manually edited metadata remain intact. Optional TMDB or licensed-provider credentials add another provider. See [automatic metadata](docs/METADATA.md) for configuration and attribution.
- Every refresh stores an encrypted snapshot, updates sources without deleting progress, marks absent sources, and queues individual checks. Failed fetches preserve the previous catalog. Administrators can restore saved snapshots.
- Public discovery requires a published title with an enabled, healthy, unblocked source from an enabled playlist. One failed health check makes that source unavailable immediately. A reported browser playback failure also adds a persistent block that successful header checks cannot remove. One working alternative keeps a movie visible; series visibility depends on available episodes.
- Durable database jobs use leases, ownership checks, heartbeats, retries, backoff, and deduplication. This deliberately uses PostgreSQL rather than adding Redis as a second persistence dependency. Run the worker as a separate supervised process.
- The player uses native video, HLS.js, DASH.js, or automatic server conversion, ranks compatible verified sources, and preserves position and play/pause state when switching audio-language versions. Automatic failover stays within the selected language; other available languages can be selected explicitly. Stream audio/caption/quality options come from actual engine tracks. A verified playback failure immediately hides that source from public discovery; an explicit retry restores it only after real playback advances. Intro/recap buttons require administrator-entered timestamps.
- Explicit language tags and playlist language attributes identify separate source versions under one movie or series. For example, English, German and Turkish versions appear once with a language selector when their content identity matches. Missing languages are labeled unspecified; uncertain remakes or conflicting identities remain separate for review. Merged title URLs redirect to the surviving title, preserving existing saved references and account data.
- Guests keep history and My List in browser storage. Accounts use HttpOnly sessions and persistent progress, history, favorites, lists, and preferences. Guest-history migration requires explicit consent.
- Playlist uploads and remote playlist downloads have no application-defined file-size or entry-count cap. Imports and stream checks accept valid HTTP/HTTPS URLs on any TCP port, including localhost, private hosts, and URLs with embedded credentials. DNS pinning, limited redirects, timeouts, and bounded health samples remain. Source URLs and uploaded playlists are encrypted. There is no arbitrary streaming proxy.

Large imports are limited by available browser/server memory and database capacity. Remove any reverse-proxy upload cap on `/api/admin/playlists` when deploying. Only signed-in administrators/editors can import playlists; other API request size limits remain. Direct playback requires the viewer to reach the source; converted playback requires the Lume server to reach it. Direct browser restrictions trigger the server conversion fallback. The server must be able to open and decode the upstream video; accepting a URL does not guarantee that its server is available.

For older imports, stop the development server and every independent worker, then run `npm run repair-languages -- --dry-run` to preview or `npm run repair-languages` to apply cleanup. The command recovers source languages and release years from encrypted snapshots, cleans recognized labels, consolidates compatible versions, and keeps redirects from old title and episode IDs. Saved playback progress follows these redirects. It saves a SQLite backup beside the database in `backups/` and copies an existing local `.source-key`; externally configured encryption keys must be backed up separately. PostgreSQL operators must back up the database and encryption key before this command; it does not create PostgreSQL backups. Existing internal `luma` identifiers, the default `data/luma.sqlite` path, session cookie and browser storage keys are retained for compatibility.

Public catalog and discovery responses use `no-store`, and the player refreshes browsing after a failure or recovery. Playback reporting uses opaque, URL-bound 15-minute attempt tokens. A failure blocks every source reference with the identical URL; each needs its own fresh retry that actually plays and advances to recover. Renewing a token or saving the same source URL does not clear a block. A replacement URL requires new verification and inherits any existing block on that URL. New imports or manually added references cannot republish a known failed URL.

See [architecture and API contracts](docs/ARCHITECTURE.md), [backend operations](docs/BACKEND.md), and [deployment](docs/DEPLOYMENT.md).

## MKV and other video formats

MKV, AVI, raw transport streams and other FFmpeg-readable video containers are verified by reading their actual video tracks, then converted on demand to browser-compatible H.264/AAC. Native playback stays available for compatible files; a browser format/codec failure tries conversion before hiding a source. Seeking restarts conversion at the selected movie position, and embedded audio tracks can be selected in playback settings. Existing separate language versions continue to share one title.

See [video conversion setup and limits](docs/MEDIA.md). Missing conversion tools, server capacity and canceled requests do not mark a working upstream video unavailable. Unreachable, denied, damaged or undecodable video still fails verification.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

Browser tests use a running application and real permitted sample video bytes:

```sh
npx playwright install chromium
npm run test:e2e
```

Use `PLAYWRIGHT_CHANNEL=chrome` for an installed Chrome browser or `E2E_BASE_URL` for another local address. The browser tests check actual time advancement, guest resume, manual switching, failover, and mobile controls. They do not turn a successful health request into a claim that browser playback works.

## Production

Copy `.env.example` to `.env`, supply strong PostgreSQL and encryption secrets, and set the public HTTPS `APP_ORIGIN`. Run:

```sh
docker compose up --build -d
docker compose exec web node scripts/run.cjs init --no-seed
docker compose exec -e ADMIN_PASSWORD web node scripts/run.cjs create-admin --email you@example.com --name Administrator
```

`ADMIN_PASSWORD` must be securely set in the invoking environment. Omit `--no-seed` only when deliberately installing the labeled development collection. The web port binds to loopback; put it behind an HTTPS reverse proxy. Production sessions use Secure cookies.

Back up PostgreSQL and the encryption key together. Read [deployment instructions](docs/DEPLOYMENT.md) for secrets, monitoring, rollback, and the playback-signing interface. DRM and provider-specific playback require licensed integrations; unsupported DRM sources remain unverified rather than being bypassed.

## Credits

Blender Foundation / Blender Studio. See the application’s **About & credits** page and individual title attribution. Original film credits remain intact. Poster artwork and film stills originate from the respective open-film projects; the film stills were extracted from permitted sample streams. DM Sans and Manrope are distributed under the SIL Open Font License; copies are in `public/fonts/`.
