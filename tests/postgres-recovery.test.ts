import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const instances: any[] = [];
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  class MockClient extends EventEmitter {
    query = vi.fn(async () => ({ rows: [] }));
    release = vi.fn();
  }
  class Pool extends EventEmitter {
    connection = new MockClient();
    query = vi.fn(async () => ({ rows: [] }));
    connect = vi.fn(async () => this.connection);
    end = vi.fn(async () => {});
    constructor() { super(); instances.push(this); }
  }
  return { Pool };
});
import { openDatabase } from '../lib/server/db';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); instances.length = 0; });

it('handles idle PostgreSQL disconnect events without terminating the web process or leaking connection details', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture:secret@localhost/test');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const db = await openDatabase(); const pool = instances[0];
  expect(() => pool.emit('error', new Error('disconnect with private provider details'))).not.toThrow();
  pool.emit('error', new Error('second disconnect'));
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning.mock.calls[0][0]).not.toMatch(/secret|private provider/);
  await expect(db.get('SELECT 1')).resolves.toBeUndefined();
  await db.close();
});

it('discards a disconnected transaction client and preserves the original failure', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture:secret@localhost/test');
  const db = await openDatabase(); const connection = instances[0].connection as EventEmitter & { release: any; query: any };
  const error = new Error('Connection reset');
  await expect(db.transaction(async () => { connection.emit('error', error); return 1; })).rejects.toBe(error);
  expect(connection.release).toHaveBeenLastCalledWith(true);
  expect(connection.listenerCount('error')).toBe(0);
  const original = new Error('Original query error');
  connection.query.mockImplementation(async (sql: string) => { if (sql === 'ROLLBACK') throw new Error('Connection gone'); return { rows: [] }; });
  await expect(db.transaction(async () => { throw original; })).rejects.toBe(original);
  expect(connection.release).toHaveBeenLastCalledWith(true);
  await db.close();
});
