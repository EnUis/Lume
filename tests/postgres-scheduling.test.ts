import { expect, it } from 'vitest';
import { Pool } from 'pg';
import type { DB } from '../lib/server/db';
import { scheduleDueJobs } from '../lib/server/jobs';

it.skipIf(!process.env.TEST_DATABASE_URL)('schedules modern millisecond timestamps on PostgreSQL without narrowing subtraction to int4', async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  const query = (sql: string, values: unknown[] = []) => { let index = 0; return client.query(sql.replace(/\?/g, () => `$${++index}`), values); };
  const db: DB = {
    dialect: 'postgres', all: async (sql, values) => (await query(sql, values)).rows,
    get: async (sql, values) => (await query(sql, values)).rows[0], run: async (sql, values) => { await query(sql, values); },
    transaction: async fn => fn(db), close: async () => {},
  };
  try {
    await client.query('BEGIN');
    // Session-local tables cannot alter the configured application's library.
    await client.query(`CREATE TEMP TABLE playlists(id TEXT,enabled INTEGER,next_sync BIGINT) ON COMMIT DROP;
      CREATE TEMP TABLE sources(id TEXT,playlist_id TEXT,enabled INTEGER,removed INTEGER,last_checked BIGINT,health TEXT,failures INTEGER) ON COMMIT DROP;
      CREATE TEMP TABLE jobs(id TEXT,type TEXT,payload TEXT,status TEXT,run_after BIGINT,created_at BIGINT,dedupe_key TEXT,attempts INTEGER DEFAULT 0,max_attempts INTEGER DEFAULT 4,completed_at BIGINT,error TEXT) ON COMMIT DROP;
      CREATE TEMP TABLE sessions(id TEXT,expires_at BIGINT) ON COMMIT DROP;
      CREATE TEMP TABLE rate_limits(bucket TEXT,reset_at BIGINT) ON COMMIT DROP`);
    const now = Date.now();
    await db.run("INSERT INTO sources VALUES('old',NULL,1,0,?,'healthy',0),('recent',NULL,1,0,?,'healthy',0),('cooling',NULL,1,0,?,'unavailable',6),('new',NULL,1,0,NULL,'unknown',0)", [now - 86400000, now - 60000, now - 60000]);
    expect(await scheduleDueJobs(db)).toMatchObject({ healthQueued: 2 });
    expect((await db.all('SELECT dedupe_key FROM jobs ORDER BY dedupe_key')).map(row => row.dedupe_key)).toEqual(['health:new', 'health:old']);
    expect(await scheduleDueJobs(db)).toMatchObject({ healthQueued: 0 });
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
}, 30000);
