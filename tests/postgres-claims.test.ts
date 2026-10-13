import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import type { DB } from '../lib/server/db';
import { leaseJob } from '../lib/server/jobs';

const schema = `lume_claim_test_${randomBytes(8).toString('hex')}`;
let setup: Pool, pool: Pool, db: DB;
describe.skipIf(!process.env.TEST_DATABASE_URL)('atomic PostgreSQL claims in an isolated test schema', () => {
  beforeAll(async () => {
    setup = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
    await setup.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 12, options: `-c search_path=${schema}`, connectionTimeoutMillis: 10000 });
    const query = (sql: string, values: unknown[] = []) => { let n = 0; return pool.query(sql.replace(/\?/g, () => `$${++n}`), values); };
    db = { dialect: 'postgres', get: async (sql, values) => (await query(sql, values)).rows[0], all: async (sql, values) => (await query(sql, values)).rows, run: async (sql, values) => { await query(sql, values); }, transaction: async () => { throw new Error('A PostgreSQL claim must be atomic without another transaction round trip'); }, close: async () => {} };
    await pool.query(`CREATE TABLE jobs(id TEXT PRIMARY KEY,type TEXT,payload TEXT DEFAULT '{}',status TEXT DEFAULT 'queued',run_after BIGINT,created_at BIGINT DEFAULT 0,attempts INTEGER DEFAULT 0,max_attempts INTEGER DEFAULT 4,lease_until BIGINT,lease_owner TEXT,completed_at BIGINT,error TEXT);
      CREATE INDEX jobs_ready_type ON jobs(type,run_after,created_at) WHERE status='queued' AND attempts<max_attempts;
      CREATE INDEX jobs_running_type ON jobs(type,run_after,created_at,lease_until) WHERE status='running' AND attempts<max_attempts;
      CREATE INDEX jobs_expired_terminal ON jobs(lease_until) WHERE status='running' AND attempts>=max_attempts;`);
  }, 30000);
  beforeEach(async () => { await pool.query('TRUNCATE jobs'); });
  afterAll(async () => {
    await pool?.end();
    if (setup) { try { await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await setup.end(); } }
  });
  it('claims each due job once across simultaneous workers and leaves future jobs alone', async () => {
    const now = Date.now();
    await pool.query("INSERT INTO jobs(id,type,run_after,created_at) SELECT 'job-'||n,'health',$1,n FROM generate_series(1,8)n", [now - 1]);
    await pool.query("INSERT INTO jobs(id,type,run_after) VALUES('future','health',$1),('sync','sync',0)", [now + 60000]);
    const claims = (await Promise.all(Array.from({ length: 12 }, (_, n) => leaseJob(db, `worker-${n}`, ['health'])))).filter(Boolean);
    expect(claims).toHaveLength(8); expect(new Set(claims.map(row => row!.id)).size).toBe(8);
    expect(claims.every(row => row!.attempts === 1 && row!.status === 'running')).toBe(true);
    expect((await pool.query("SELECT COUNT(*)::int n FROM jobs WHERE status='queued'")).rows[0].n).toBe(2);
  }, 30000);
  it('honors retries and ownership, recovers crashed leases, and preserves priority across types', async () => {
    const now = Date.now();
    await pool.query(`INSERT INTO jobs(id,type,status,run_after,created_at,attempts,lease_until,lease_owner) VALUES
      ('expired','health','running',0,0,1,$1,'crashed'),
      ('terminal','health','running',0,0,4,$1,'crashed'),
      ('current','health','running',0,0,1,$2,'other'),
      ('retry','health','queued',$2,0,1,NULL,NULL),
      ('metadata','metadata','queued',1,0,0,NULL,NULL),
      ('unknown','custom','queued',0,1,0,NULL,NULL)`, [now - 1, now + 60000]);
    expect(await leaseJob(db, 'recovered', ['metadata', 'health'])).toMatchObject({ id: 'expired', attempts: 2, lease_owner: 'recovered' });
    expect((await pool.query("SELECT status,lease_owner FROM jobs WHERE id='terminal'")).rows[0]).toEqual({ status: 'failed', lease_owner: null });
    expect(await leaseJob(db, 'next', ['metadata', 'health'])).toMatchObject({ id: 'metadata', attempts: 1 });
    expect(await leaseJob(db, 'idle', ['health'])).toBeNull();
    expect(await leaseJob(db, 'unfiltered')).toMatchObject({ id: 'unknown' });
    expect((await pool.query("SELECT lease_owner FROM jobs WHERE id='current'")).rows[0].lease_owner).toBe('other');
  });
  it('skips a row held by another transaction instead of blocking all stream checks', async () => {
    await pool.query("INSERT INTO jobs(id,type,run_after) VALUES('locked','health',0),('free','health',1)");
    const owner = await pool.connect();
    try {
      await owner.query('BEGIN'); await owner.query("SELECT id FROM jobs WHERE id='locked' FOR UPDATE");
      expect(await leaseJob(db, 'unblocked', ['health'])).toMatchObject({ id: 'free' });
    } finally { await owner.query('ROLLBACK'); owner.release(); }
    expect(await leaseJob(db, 'next', ['health'])).toMatchObject({ id: 'locked' });
  }, 15000);
});
