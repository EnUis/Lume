import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type { DB } from '../lib/server/db';
import { importPlaybackBlocks, lockImportUrls } from '../lib/server/import-batches';
import { synchronizePlaylist } from '../lib/server/pipeline';
import { encrypt, hash } from '../lib/server/security';

const schema = `lume_import_test_${randomBytes(8).toString('hex')}`;
let setup: Pool, pool: Pool;
function adapter(client: PoolClient): DB {
  const query = (sql: string, values: unknown[] = []) => { let n = 0; return client.query(sql.replace(/\?/g, () => `$${++n}`), values); };
  const db: DB = { dialect: 'postgres', all: async (sql, values) => (await query(sql, values)).rows,
    get: async (sql, values) => (await query(sql, values)).rows[0], run: async (sql, values) => { await query(sql, values); },
    transaction: fn => fn(db), close: async () => {} };
  return db;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('batched PostgreSQL imports in an isolated test schema', () => {
  beforeAll(async () => {
    setup = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
    await setup.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3, options: `-c search_path=${schema}`, connectionTimeoutMillis: 10000 });
    await pool.query(readdirSync(resolve('db')).filter(name => /^\d+.*\.sql$/.test(name)).sort().map(file => readFileSync(resolve('db', file), 'utf8')).join('\n'));
  }, 60000);
  afterAll(async () => { await pool?.end(); if (setup) { try { await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await setup.end(); } } }, 30000);

  it('holds the same ordered two-key URL locks until transaction rollback', async () => {
    const client = await pool.connect(), observer = await pool.connect();
    const a = '0000000180000002' + '0'.repeat(48), b = 'ffffffff00000003' + '0'.repeat(48);
    try {
      await client.query('BEGIN'); await lockImportUrls(adapter(client), [b, a, b]);
      const held = (await client.query("SELECT classid::text, objid::text, objsubid FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' ORDER BY classid")).rows;
      expect(held).toEqual([{ classid: '1', objid: '2147483650', objsubid: 2 }, { classid: '4294967295', objid: '3', objsubid: 2 }]);
      await observer.query('BEGIN');
      expect((await observer.query('SELECT pg_try_advisory_xact_lock(1,-2147483646) AS acquired')).rows[0].acquired).toBe(false);
      await client.query('ROLLBACK');
      expect((await observer.query('SELECT pg_try_advisory_xact_lock(1,-2147483646) AS acquired')).rows[0].acquired).toBe(true);
    } finally { await client.query('ROLLBACK'); await observer.query('ROLLBACK'); client.release(); observer.release(); }
  });

  it('returns only the newest indexed playback block for each requested URL', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO titles(id,name,normalized,type,created_at,updated_at) VALUES('blocked-title','Fixture','fixture','movie',0,0)");
      await client.query("INSERT INTO sources(id,title_id,entry_key,name,url_encrypted,url_hash,playback_blocked,playback_blocked_at,error,failures,created_at) SELECT 'copy-'||n,'blocked-title','copy-'||n,'Fixture','encrypted','shared-hash',1,n,'Failure '||n,n,0 FROM generate_series(1,1000)n");
      const blocks = await importPlaybackBlocks(adapter(client), ['shared-hash', 'missing-hash', 'shared-hash']);
      expect(blocks.size).toBe(1); expect(blocks.get('shared-hash')).toMatchObject({ playback_blocked_at: '1000', error: 'Failure 1000', failures: 1000 });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('imports batched sources/jobs without losing languages, episodes or inherited playback blocks', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); const db = adapter(client);
      const shared = 'https://provider.example/movie/shared.mp4';
      await db.run("INSERT INTO titles(id,name,normalized,type,created_at,updated_at) VALUES('old-title','Old fixture','old fixture','movie',0,0)");
      await db.run("INSERT INTO sources(id,title_id,entry_key,name,url_encrypted,url_hash,playback_blocked,playback_blocked_at,health,error,created_at) VALUES('old-source','old-title','old','Old fixture',?,?,1,50,'unavailable','Known browser failure',0)", [encrypt(shared), hash(shared)]);
      const content = '#EXTM3U\n' + Array.from({ length: 30 }, (_, n) => `#EXTINF:-1,(EN) Import fixture ${n}\nhttps://provider.example/movie/${n}.mp4\n`).join('')
        + `#EXTINF:-1,(DE) Shared Film (2020)\n${shared}\n#EXTINF:-1,(EN) Shared Film (2020)\n${shared}\n`
        + '#EXTINF:-1,(DE) Fixture Series S1 E1\nhttps://provider.example/series/de/1.mp4\n#EXTINF:-1,(EN) Fixture Series S1 E1\nhttps://provider.example/series/en/1.mp4\n';
      await db.run('INSERT INTO playlists(id,name,content_encrypted,created_at) VALUES(?,?,?,?)', ['fixture', 'Fixture import', encrypt(content), Date.now()]);
      expect(await synchronizePlaylist(db, 'fixture', undefined, undefined, { batchSize: 12 })).toMatchObject({ added: 34, batches: 3, reviews: 0 });
      expect(Number((await db.get("SELECT COUNT(*) n FROM jobs WHERE type='health'"))?.n)).toBe(34);
      const blocked = await db.all("SELECT health,playback_blocked,error,title_id FROM sources WHERE playlist_id='fixture' AND url_hash=?", [hash(shared)]);
      expect(blocked).toHaveLength(2); expect(new Set(blocked.map(row => row.title_id)).size).toBe(1);
      for (const source of blocked) expect(source).toMatchObject({ health: 'unavailable', playback_blocked: 1, error: 'Known browser failure' });
      expect(Number((await db.get('SELECT COUNT(*) n FROM episodes'))?.n)).toBe(1);
      expect(await synchronizePlaylist(db, 'fixture')).toMatchObject({ unchanged: 34, contentChanged: false });
    } finally { await client.query('ROLLBACK'); client.release(); }
  }, 60000);
});
