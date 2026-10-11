# Repairing existing episode cards

New playlist imports recognize explicit episode labels such as `Show S1 EP1`, `S1 EP2 Show`, `Show Season 1 Ep. 3` and `Show 1x04`. Existing catalogs can be repaired without fetching playlist providers:

1. Stop the website and all background workers that use the catalog.
2. Back up the database and its configured encryption keys. SQLite repair creates a local backup automatically; PostgreSQL requires a separate backup.
3. From the application directory, preview the repair:

   ```sh
   npm run repair-languages -- --series-only --dry-run
   ```

4. Review the counts and conflicts, then apply:

   ```sh
   npm run repair-languages -- --series-only
   ```

5. Verify source IDs and account data against the backup. Former merged title IDs should either still exist or resolve through their saved redirects. Restart the application with `npm run dev` (which also starts its worker), or restart the separate website and worker services for production.

The repair reads candidates in bounded batches. Committed PostgreSQL repairs use at most six independent title transactions at once; SQLite and dry-run rollback transactions remain sequential. It drains in-flight work before surfacing an error. It uses saved original source labels, with saved encrypted playlist snapshots as a fallback when those labels are missing. It does not retrieve provider URLs. Sources keep their identifiers, credentials, availability and manual blocks. Compatible title identities are combined, while conflicting years, provider identifiers, manual edits and ambiguous episode coordinates are protected or left for review.

Each series retains its seasons, episodes and per-episode source languages. Separate show families may merge concurrently, while each family's merges remain sequential. Transactional PostgreSQL deadlocks receive a bounded retry; other failures stop new work and wait for active transactions. Old episode-card links redirect to the appropriate chapter. Account history, favorites and lists are preserved; guest progress resolves old title and episode identifiers when the updated client loads its collection.

After repair, the background metadata worker gradually checks eligible titles for missing artwork, descriptions and verified English display names. To queue a bounded batch immediately:

```sh
npm run backfill-metadata -- --limit 20 --background 5 --force
```

This queues work; it does not perform every online lookup immediately. Repeat `--title-id ID` to restrict a batch to selected titles. See [metadata provider matching and limits](METADATA.md).

The dry run rolls back catalog changes; normal database startup migrations still apply. Keep other writers stopped throughout preview and repair, and retain the backup until redirects and source/account preservation have been checked.
