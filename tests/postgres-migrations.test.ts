import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ outside: [1,2,3,4,5,6,7,8,9,10] as number[], inside: [1,2,3,4,5,6,7,8,9,10] as number[], pools: [] as any[] }));
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  const result = (sql: string, versions: number[]) => ({ rows: sql.includes('to_regclass') ? [{name:'schema_migrations'}] : sql === 'SELECT version FROM schema_migrations' ? versions.map(version => ({version})) : [] });
  class Connection extends EventEmitter {
    query = vi.fn(async (sql: string) => result(sql, state.inside));
    release = vi.fn();
  }
  class Pool extends EventEmitter {
    connection = new Connection();
    query = vi.fn(async (sql: string) => {
      if (/CREATE|ALTER|INSERT|UPDATE|DELETE/.test(sql)) throw new Error('Unexpected schema write on startup');
      return result(sql, state.outside);
    });
    connect = vi.fn(async () => this.connection);
    end = vi.fn(async () => {});
    constructor(public options: Record<string, unknown>) { super(); state.pools.push(this); }
  }
  return { Pool };
});
import { openDatabase } from '../lib/server/db';
afterEach(() => { vi.unstubAllEnvs(); state.outside=[1,2,3,4,5,6,7,8,9,10]; state.inside=[...state.outside]; state.pools.length=0; });

it('opens an installed PostgreSQL schema without index DDL, writes or migration locks', async () => {
  vi.stubEnv('DATABASE_URL','postgresql://fixture:secret@localhost/test');
  const db=await openDatabase(),pool=state.pools[0];
  expect(pool.query.mock.calls.map((call: any[])=>call[0])).toEqual(["SELECT to_regclass('schema_migrations') AS name",'SELECT version FROM schema_migrations']);
  expect(pool.connect).not.toHaveBeenCalled();
  expect(pool.options).toMatchObject({statement_timeout:15000,connectionTimeoutMillis:10000,idle_in_transaction_session_timeout:60000});
  await db.close();
});

it('applies only the missing migration after locking and rechecking versions', async () => {
  vi.stubEnv('DATABASE_URL','postgresql://fixture:secret@localhost/test');
  state.outside=state.inside=[1,2,3,4,5,6,7,8,9];
  const db=await openDatabase(),calls=state.pools[0].connection.query.mock.calls;
  const sql=calls.map((call: any[])=>call[0]).join('\n');
  expect(sql).toContain('pg_advisory_xact_lock');
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS episode_redirects');
  expect(sql).not.toContain('CREATE INDEX IF NOT EXISTS jobs_claim');
  expect(calls.filter((call: any[])=>call[0].startsWith('INSERT INTO schema_migrations')).map((call: any[])=>call[1][0])).toEqual([10]);
  expect(calls.at(-1)[0]).toBe('COMMIT');
  await db.close();
});

it('does not replay migrations completed by another starter before the lock is acquired', async () => {
  vi.stubEnv('DATABASE_URL','postgresql://fixture:secret@localhost/test');
  state.outside=[1,2,3,4,5,6,7,8,9];
  const db=await openDatabase(),sql=state.pools[0].connection.query.mock.calls.map((call: any[])=>call[0]).join('\n');
  expect(sql).toContain('pg_advisory_xact_lock');
  expect(sql).not.toMatch(/CREATE|ALTER|INSERT/);
  expect(sql).toContain('COMMIT');
  await db.close();
});
