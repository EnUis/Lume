# Deployment and operations

## Services

`compose.yaml` defines PostgreSQL 17, a Next.js web service, and an independently supervised worker. Only the web service binds a host port, on loopback. PostgreSQL is on the private Docker network. Data persists in a named database volume. The runtime uses an unprivileged user.

Node 24 is required for the development SQLite implementation. PostgreSQL is the intended deployment database. Database migrations run idempotently when a process opens its database; add subsequent versioned migrations rather than editing a deployed schema in place. Coordinate migration rollouts before scaling workers.

The development custom server avoids launching child compiler processes in the restricted desktop environment. Production uses the standard Next standalone server produced by the build; it does not use the development custom server.

Local `npm run dev` supervises a child background worker automatically. Its shutdown stops that child, and worker exits trigger a five-second restart. `DEV_WORKER_AUTOSTART=false` opts out for installations with an independently managed development worker. Production Docker uses its separate supervised worker service. Workers publish a database heartbeat every 15 seconds; the admin dashboard reports stale/missing heartbeats after 60 seconds and shows unclaimed jobs.

## Configuration

Set `POSTGRES_PASSWORD` to a strong URL-safe value. Generate `SOURCE_ENCRYPTION_KEY` from 32 random bytes in base64. Never commit `.env`, export secrets in logs, or replace the encryption key without migrating stored ciphertext. The development key is generated privately at `data/.source-key`; production fails without explicit key configuration.

Set `APP_ORIGIN` to the exact public HTTPS origin; production mutations fail closed without it. Same-origin mutation requests are mandatory. Development uses the actual Host header and request protocol unless configured, including natural localhost/127.0.0.1 access. Forwarded origin headers are not trusted for this check. Do not set `TRUST_PROXY=true` unless your reverse proxy discards and overwrites incoming forwarding headers. Shared unauthenticated rate limits are conservative when no trusted client-IP provider is configured.

Configure health concurrency conservatively (default 3, maximum 8), failure confidence (default 3), and monitor interval (default 6 hours). Playlist intervals include 5/12/24 hours and administrator-defined values. Workers continuously schedule due synchronization and health jobs; stopping them stops automatic updates.

Automatic missing artwork and descriptions are enabled by default with `METADATA_AUTO_ENRICH=true`. Without credentials, series use TVmaze, then Wikidata/Wikipedia when needed; movies use Wikidata/Wikipedia. Lookups require a unique content identity and preserve administrator edits. The worker prioritizes verified titles and performs bounded background enrichment. Set `METADATA_AUTO_ENRICH=false` to disable these lookups. Metadata jobs do not gate source verification or existing manual metadata.

`METADATA_LANGUAGE` defaults to `en`; supported values are two-letter language codes with an optional region, such as `en-US`. Set `METADATA_USER_AGENT` to a descriptive application identity and contact for Wikimedia requests. The supplied Compose default is `Lume-Metadata/1.0 (automatic catalog lookup)`.

For TMDB, supply `TMDB_READ_ACCESS_TOKEN` or `TMDB_API_KEY`; the read access token takes precedence when both are set. A configured licensed HTTPS adapter using both `METADATA_PROVIDER_URL` and `METADATA_API_KEY` takes precedence over TMDB. Without either adapter, the no-key providers remain available. Credentials stay on the server. `compose.yaml` passes all seven metadata settings through the shared web/worker environment; restart both services after changing them. Provider contracts, attribution and image rights are described in [METADATA.md](METADATA.md).

## Video conversion

The runtime image includes FFmpeg, ffprobe and CA certificates. Local installs need the same tools on PATH or `FFMPEG_PATH` / `FFPROBE_PATH` configured. `MEDIA_CONVERSION=true` and `MEDIA_MAX_PROCESSES=2` are the defaults; the latter caps active converters per web process. See [MEDIA.md](MEDIA.md) for streaming, proxy and scaling requirements.

## Playback URLs and licensing

Direct delivery is suitable for public or browser-safe signed media URLs. Browser playback necessarily receives the URL used for video requests. Do not use direct mode for confidential long-lived upstream credentials. Configure the server-side playback-signing adapter and enable its requirement for private providers; its key remains server-side. Upstream origins must support the requested browser codecs and CORS for adaptive playback. Configure valid HTTPS media; the application never proxies arbitrary URLs or bypasses DRM.

Only import media and artwork you have the legal right to distribute. The built-in sample playlist is for development and should be deliberately enabled or removed before launch. The Sintel item is specifically a trailer sample, not the entire film.

## HTTPS reverse proxy

Terminate TLS with a managed ingress or a proxy such as Caddy/Nginx. Route requests to `127.0.0.1:3000` and preserve the origin. The authenticated playlist-upload route has no application size cap; configure unlimited proxy upload bodies for `/api/admin/playlists` (for example, Nginx `client_max_body_size 0` in that location). Other API bodies retain their 11 MiB cap. Set connection and request timeouts for your expected upload sizes. Playlist/media requests now allow local/private destinations and any valid TCP port at the user's request; network policy must permit the media services you intend to use. Only trusted administrators/editors should have import access. DNS pinning and HTTP(S) validation remain, but private-network blocking is intentionally disabled for these requests.

The application supplies content-type, frame, referrer, permissions, and CSP headers. The development-compatible CSP permits inline scripts/styles required by Next. For a public rollout, implement request nonces and an appropriate tighter production script policy as part of your security review. Adaptive engines need blob workers and HTTPS media/connect origins. Avoid broadening image-loader server origins for arbitrary administrator poster URLs; externally hosted imported images use direct browser image elements.

## Monitoring and maintenance

Use `/api/health` for readiness. Supervise both containers, collect structured worker events, and alert on failed jobs, persistent unavailable sources, queue age, and stale playlist synchronization. The admin control room reports health, sync history, snapshots, reviews, and an audit log. Source error messages redact URLs and tokens.

Take daily PostgreSQL backups and test restores, retaining the encryption secret separately in your secret manager. Track growing health/import/job history and establish retention appropriate to your catalog; this implementation retains detailed reports and snapshots rather than silently deleting recovery evidence. It does not yet implement an automatic archival/retention policy.

Build from the committed lockfile. Run unit/integration tests, browser tests with real authorized sources, and an actual PostgreSQL/Docker staging deployment before public use. Load-test imports and discovery with the expected catalog size, and verify multi-worker leasing under failure. A small successful SQLite test is not proof of commercial operating capacity.

## Boundaries still requiring deployment work

- Licensed DRM/CDM integration, license credentials, and provider-specific signing policy.
- Email verification, password reset/recovery, and operational account-abuse controls.
- Real PostgreSQL integration/backup tests and multi-worker/load tests.
- Object-storage/CDN upload integration if administrators need hosted asset uploads rather than image URLs.
- Accessibility and playback checks on Safari, mobile devices, TVs, fullscreen and Picture-in-Picture.
- Public-Internet security review, stricter CSP nonces, monitoring alerts, and data-retention policies.

No unsupported or untested integration is reported as working.
