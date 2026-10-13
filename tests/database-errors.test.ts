import { afterEach, expect, it, vi } from 'vitest';
import { databaseConnectionFailure, databaseUnavailableResponse } from '../lib/server/database-errors';
afterEach(() => vi.restoreAllMocks());

it('returns retryable service errors during provider downtime without leaking endpoint details', async () => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = new Error('branch is hibernated, reactivate it to continue');
  expect(databaseConnectionFailure(error)).toBe('paused');
  const first = databaseUnavailableResponse(error)!;
  expect(first.status).toBe(503); expect(first.headers.get('Retry-After')).toBe('15');
  expect(await first.json()).toEqual({ error: 'The library is temporarily unavailable. Please try again shortly.', code: 'DATABASE_UNAVAILABLE' });
  for (let n = 0; n < 10; n++) databaseUnavailableResponse(Object.assign(new Error('getaddrinfo ENOTFOUND secret-database.example'), { code: 'ENOTFOUND' }));
  expect(log).toHaveBeenCalledTimes(1);
  expect(databaseUnavailableResponse(new Error('SQL syntax error'))).toBeNull();
  expect(databaseConnectionFailure({ code: '42501' })).toBeNull();
  expect(databaseUnavailableResponse({ classification: 'source', cause: { code: 'ENOTFOUND' } })).toBeNull();
});
