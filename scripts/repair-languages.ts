import '../lib/server/env';
import { DatabaseSync, backup } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { database } from '../lib/server/db';
import { backfillSourceLanguages, previewLanguageRepair, previewSeriesRepair, repairLanguageCatalog, repairSeriesCatalog } from '../lib/server/language-repair';
import { sanitizeError } from '../lib/server/security';

async function main() {
  if (process.argv.includes('--help')) { console.log('Usage: npm run repair-languages -- [--series-only] [--dry-run]\n--series-only repairs explicit episode labels and consolidates compatible series in bounded batches. It uses saved source labels/snapshots and does not fetch provider links. Stop workers before repair. Back up PostgreSQL and configured encryption keys first. --dry-run rolls back catalog changes; normal startup migrations still apply.'); return; }
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun && !process.env.DATABASE_URL) {
    const sqlitePath = resolve(process.env.SQLITE_PATH || 'data/luma.sqlite');
    if (existsSync(sqlitePath)) {
      const directory = join(dirname(sqlitePath), 'backups'); mkdirSync(directory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const connection = new DatabaseSync(sqlitePath);
      try { await backup(connection, join(directory, `before-language-repair-${stamp}.sqlite`)); } finally { connection.close(); }
      const key = resolve('data/.source-key'); if (!process.env.SOURCE_ENCRYPTION_KEY && existsSync(key)) copyFileSync(key, join(directory, `source-key-${stamp}`));
      console.log('A SQLite backup and any local development source key were saved beside the database in backups/. Back up configured encryption keys separately.');
    }
  }
  const db = await database();
  // This is the database pool, not a transaction-scoped adapter. Previews keep
  // their single rollback transaction sequential; committed repairs are bounded.
  const repairOptions = { concurrency: db.dialect === 'postgres' ? 6 : 1 };
  try {
    if (process.argv.includes('--series-only')) {
      const report = dryRun ? await previewSeriesRepair(db) : await repairSeriesCatalog(db, progress => { console.log(JSON.stringify({ event: 'catalog.series', ...progress })); }, repairOptions);
      console.log(JSON.stringify({ event: 'series.repair.complete', committed: !dryRun, ...report })); return;
    }
    if (dryRun) { const preview = await previewLanguageRepair(db); console.log(JSON.stringify({ event: 'catalog.repair.preview', committed: false, sources: preview.sources, ...preview.report })); return; }
    const sources = await backfillSourceLanguages(db, count => { console.log(JSON.stringify({ event: 'source.languages', updated: count })); });
    const report = await repairLanguageCatalog(db, progress => { console.log(JSON.stringify({ event: 'catalog.languages', ...progress })); }, repairOptions);
    console.log(JSON.stringify({ event: 'language.repair.complete', sources, ...report }));
  } finally { await db.close(); }
}
main().catch(error => { console.error(sanitizeError(error)); process.exitCode = 1; });
