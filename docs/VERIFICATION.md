# Database timeout and development startup recovery

Verified on 10 October 2026, Europe/Budapest. The [previous title-cleanup verification](VERIFICATION-ENGLISH-2026-10-09.md) remains available.

## Cause and changes

The live PostgreSQL activity showed `CREATE INDEX IF NOT EXISTS jobs_claim` waiting for a relation lock held by an abandoned import transaction. Opening the database replayed the initial schema on every startup, so the website and worker repeatedly waited on this DDL and hit the existing 15-second statement timeout.

- Database startup now reads installed migration versions, avoids DDL and migration locks for an up-to-date schema, and applies only missing migrations. It rechecks versions under the PostgreSQL migration lock to handle concurrent starters.
- PostgreSQL connections retain the 15-second query limit and now have a 10-second connection limit and a 60-second idle-in-transaction limit. This bounds abandoned transaction locks without extending slow queries indefinitely.
- The diagnosed connection was released only after verifying its database, user, exact import-query shape and idle transaction age over ten minutes. Its unfinished transaction rolled back; committed library data was retained.
- Worker maintenance runs independently of consumers. Scheduling failures back off per stage; transient claim failures pause the affected consumer. Bounded health scheduling uses batched inserts while preserving retry deadlines and running leases.
- Bulk catalog and recent-discovery queries build a distinct set of verified titles, while detail/playback queries keep their selective lookup. Availability and playback-block rules are unchanged. A read-only PostgreSQL plan comparison reduced recent-feed execution from 310ms to 84ms, eliminating 53,687 repeated per-title source lookups.
- The development launcher checks the existing listener before preparing Next. A healthy Lume server is reused without another worker. Native Next locks are respected; stale JSON PIDs do not trigger lock-file deletion or process killing.

## Verification

- Fixed database startup completed in **312ms** while the original import blocker still existed.
- **15 live HTTP requests passed**, covering health, discovery, movies, series and Live TV in three rounds of concurrent requests. The slowest was **2671ms** while build/test checks and the worker were active.
- The existing user-started web server remained running. Its worker was restarted through that server's supervisor after the final worker edits. Fresh heartbeats and completed health/metadata jobs were observed; the blocking transaction was absent.
- Running `npm run dev` against the live instance exited successfully with an already-running message and did not launch another server or worker.
- Browser inspection showed the restored homepage hero and catalog rows, with no captured console warnings/errors. Preview: `outputs/lume-recovered-home.jpg` beside the application directory.
- Regression suite: **351 passed initially and 1 failed** while the production build ran concurrently. The failed 12MB authenticated-upload case completed in about eight seconds against the test runner's default deadline. The complete upload file then passed **4 tests** separately, with that case completing in about 1.5 seconds. All **352 unique tests across 43 files** were therefore verified without weakening application or test timeouts.
- Full TypeScript check and isolated production build passed.

## Remaining external limitations

Upstream playlists, streams and metadata services can independently return errors or defer requests. These fixes restore database access and prevent scheduling failures from triggering the same startup loop; they do not make an unavailable provider serve content. No source URL, account password or library title was manually replaced for this recovery.
