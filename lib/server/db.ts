import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';

export type Row = Record<string, any>;
export interface DB {
  dialect?: 'postgres' | 'sqlite';
  all<T extends Row = Row>(sql: string, values?: unknown[]): Promise<T[]>;
  get<T extends Row = Row>(sql: string, values?: unknown[]): Promise<T | undefined>;
  run(sql: string, values?: unknown[]): Promise<void>;
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function isSqliteBusy(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const detail = error as { code?: unknown; errcode?: unknown };
  const primary = Number(detail.errcode) & 255;
  return detail.code === 'ERR_SQLITE_ERROR' && (primary === 5 || primary === 6);
}
async function retrySqlite<T>(operation: () => T): Promise<T> {
  const deadline = performance.now() + 10000; let delay = 25;
  for (;;) {
    try { return operation(); }
    catch (error) {
      if (!isSqliteBusy(error) || performance.now() >= deadline) throw error;
      await new Promise(resolveRetry => setTimeout(resolveRetry, Math.min(delay, Math.max(1, deadline - performance.now()))));
      delay = Math.min(delay * 2, 250);
    }
  }
}
function pgSql(sql: string) { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); }
export function postgresConnectionString(value: string) {
  const url = new URL(value);
  // Preserve the current driver's full certificate verification explicitly,
  // avoiding deprecated sslmode aliases and future changes in their meaning.
  if (url.searchParams.get('uselibpqcompat') !== 'true' && ['prefer', 'require', 'verify-ca'].includes(url.searchParams.get('sslmode') || '')) url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}
function pgAdapter(client: Pool | PoolClient, pool?: Pool): DB {
  const api: DB = {
    dialect: 'postgres',
    async all<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T[]> { return (await client.query(pgSql(sql), values)).rows as T[]; },
    async get<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T | undefined> { const rows = (await client.query(pgSql(sql), values)).rows; return rows[0] as T | undefined; },
    async run(sql, values = []) { await client.query(pgSql(sql), values); },
    async transaction(fn) {
      if (!pool) return fn(api);
      const connection = await pool.connect();
      let disconnected: Error | undefined;
      const onError = (error: Error) => { disconnected ||= error; };
      connection.on('error', onError);
      try {
        await connection.query('BEGIN'); const result = await fn(pgAdapter(connection));
        if (disconnected) throw disconnected;
        await connection.query('COMMIT'); return result;
      } catch (error) {
        // A lost connection cannot roll back; preserve the original error and
        // discard the client instead of crashing on its asynchronous error event.
        try { if (!disconnected) await connection.query('ROLLBACK'); } catch (rollbackError) { disconnected = rollbackError as Error; }
        throw error;
      } finally { connection.release(!!disconnected); connection.removeListener('error', onError); }
    },
    async close() { if (pool) await pool.end(); },
  }; return api;
}
export async function openDatabase(path?: string): Promise<DB> {
  let api: DB;
  if (!path && process.env.DATABASE_URL && !/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  if (!path && process.env.DATABASE_URL?.startsWith('postgres')) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: postgresConnectionString(process.env.DATABASE_URL), max: 12, statement_timeout: 15000, connectionTimeoutMillis: 10000, idle_in_transaction_session_timeout: 60000, application_name: 'lume' });
    let lastConnectionWarning = 0;
    pool.on('error', () => {
      // pg removes the idle client and reconnects on the next request.
      // Never print connection strings or provider error details.
      if (Date.now() - lastConnectionWarning > 30000) { lastConnectionWarning = Date.now(); console.warn('Database connection interrupted. Reconnecting on the next request.'); }
    });
    api = pgAdapter(pool, pool);
  } else {
    const dbPath = path || process.env.SQLITE_PATH || resolve(process.cwd(), 'data/luma.sqlite');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    const connection = await retrySqlite(() => new DatabaseSync(dbPath));
    // Short native waits plus bounded asynchronous retries let other HTTP work
    // proceed while an independent importer owns the SQLite writer lock.
    try { await retrySqlite(() => connection.exec('PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;')); }
    catch (error) { connection.close(); throw error; }
    let queue: Promise<unknown> = Promise.resolve();
    const execute = {
      async all<T extends Row = Row>(sql: string, values: unknown[] = []) { return retrySqlite(() => connection.prepare(sql).all(...values as any[]) as T[]); },
      async get<T extends Row = Row>(sql: string, values: unknown[] = []) { return retrySqlite(() => connection.prepare(sql).get(...values as any[]) as T | undefined); },
      async run(sql: string, values: unknown[] = []) { await retrySqlite(() => connection.prepare(sql).run(...values as any[])); },
    };
    const scoped: DB = { dialect: 'sqlite', ...execute, transaction: async fn => fn(scoped), close: async () => connection.close() };
    const enqueue = <T>(fn: () => Promise<T>) => { const result = queue.then(fn, fn); queue = result.catch(() => {}); return result; };
    api = {
      dialect: 'sqlite',
      all: (sql, values) => enqueue(() => execute.all(sql, values)) as any,
      get: (sql, values) => enqueue(() => execute.get(sql, values)) as any,
      run: (sql, values) => enqueue(() => execute.run(sql, values)),
      transaction: fn => enqueue(async () => {
        await retrySqlite(() => connection.exec('BEGIN IMMEDIATE'));
        try { const result = await fn(scoped); await retrySqlite(() => connection.exec('COMMIT')); return result; }
        catch (error) { connection.exec('ROLLBACK'); throw error; }
      }), close: () => enqueue(async () => connection.close()),
    };
  }
  try {
    const migration = readFileSync(resolve(process.cwd(), 'db/001-initial.sql'), 'utf8');
    const followupMigrations = [
      { version: 2, source: readFileSync(resolve(process.cwd(), 'db/002-worker-heartbeats.sql'), 'utf8') },
      { version: 3, source: readFileSync(resolve(process.cwd(), 'db/003-availability-index.sql'), 'utf8') },
      { version: 4, source: readFileSync(resolve(process.cwd(), 'db/004-import-query-indexes.sql'), 'utf8') },
      { version: 5, source: readFileSync(resolve(process.cwd(), 'db/005-job-claim-indexes.sql'), 'utf8') },
      { version: 6, source: readFileSync(resolve(process.cwd(), 'db/006-languages-playback.sql'), 'utf8') },
      { version: 7, source: readFileSync(resolve(process.cwd(), 'db/007-merge-reference-indexes.sql'), 'utf8') },
      { version: 8, source: readFileSync(resolve(process.cwd(), 'db/008-admin-summary-indexes.sql'), 'utf8') },
      { version: 9, source: readFileSync(resolve(process.cwd(), 'db/009-automatic-metadata.sql'), 'utf8') },
      { version: 10, source: readFileSync(resolve(process.cwd(), 'db/010-episode-redirects.sql'), 'utf8') },
    ];
    const migrations = [{ version: 1, source: migration }, ...followupMigrations];
    const appliedVersions = async (db: DB) => {
      const table = await db.get(db.dialect === 'postgres'
        ? "SELECT to_regclass('schema_migrations') AS name"
        : "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
      return new Set<number>(table?.name ? (await db.all('SELECT version FROM schema_migrations')).map(row => Number(row.version)) : []);
    };
    // Even CREATE INDEX IF NOT EXISTS takes a table lock in PostgreSQL. Replaying
    // the initial schema on every connection can block all startup behind an
    // importer. An installed schema needs only this read-only version check.
    const installed = await appliedVersions(api);
    if (migrations.every(item => installed.has(item.version))) return api;
    await api.transaction(async tx => {
      // Web and worker may boot simultaneously. PostgreSQL DDL needs a shared
      // transaction lock because concurrent CREATE IF NOT EXISTS can still race.
      if (!path && process.env.DATABASE_URL?.startsWith('postgres')) await tx.run('SELECT pg_advisory_xact_lock(1364544864)');
      // Another process may have finished migration while this one waited.
      const applied = await appliedVersions(tx);
      for (const item of migrations) if (!applied.has(item.version)) {
        for (const statement of item.source.split(';').map(x => x.trim()).filter(Boolean)) await tx.run(statement);
        await tx.run('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?) ON CONFLICT(version) DO NOTHING', [item.version, Date.now()]);
      }
    });
  } catch (error) { await api.close(); throw error; }
  return api;
}
let singleton: Promise<DB> | undefined;
export function database() {
  if (!singleton) {
    const opening = openDatabase(); singleton = opening;
    void opening.catch(() => { if (singleton === opening) singleton = undefined; });
  }
  return singleton;
}
