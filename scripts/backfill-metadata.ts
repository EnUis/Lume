import '../lib/server/env';
import { database } from '../lib/server/db';
import { scheduleMetadataEnrichment } from '../lib/server/metadata';
import { workerError } from '../lib/server/worker-log';

async function main() {
  const option = (name: string, fallback: number) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : Number(process.argv[index + 1]); };
  const limit = option('--limit', 20); const background = option('--background', 5);
  const titleIds = process.argv.flatMap((argument, index) => argument === '--title-id' ? [process.argv[index + 1]] : []);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(background) || background < 0 || background > 20) throw new Error('Use --limit 1–100 and --background 0–20');
  if (titleIds.length > 100 || titleIds.some(value => !value || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))) throw new Error('Use up to 100 valid --title-id values');
  const db = await database();
  try { const report = await scheduleMetadataEnrichment(db, { limit, backgroundLimit: background, force: process.argv.includes('--force'), ...(titleIds.length ? { titleIds } : {}) }); console.log(`Queued ${report.queued} metadata lookups. The worker fills missing artwork/text and verifies English display titles after a confirmed match.`); }
  finally { await db.close(); }
}
main().catch(error => { console.error(workerError(error)); process.exitCode = 1; });
