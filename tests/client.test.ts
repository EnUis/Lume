import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, RequestError, requestJson } from '../lib/client';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('browser API request reliability', () => {
  it('sends same-origin sessions and preserves structured authentication errors without retrying', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'Invalid email or password' }, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'test@example.invalid', password: 'test-only-password' }) })).rejects.toMatchObject({ message: 'Invalid email or password', status: 401, code: 'http' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(options.credentials).toBe('same-origin');
    expect(options.cache).toBe('no-store');
    expect(new Headers(options.headers).get('content-type')).toBe('application/json');
  });
  it('shows a service error for a non-JSON server failure instead of a parser error or HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>private server traceback</html>', { status: 500 })));
    await expect(requestJson('/api/auth/login')).rejects.toMatchObject({ message: 'Lume could not complete this request. Please try again.', status: 500 });
  });
  it('rejects malformed successful responses rather than passing empty data into components', async () => {
    for (const body of ['<html>not JSON</html>', '', 'null', '"unexpected text"']) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
      await expect(requestJson('/api/auth/me')).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
  it('ends a stalled request with an actionable timeout and does not replay its mutation', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    vi.stubGlobal('fetch', fetcher);
    const result = requestJson('/api/auth/login', { method: 'POST' }, 50);
    const checked = expect(result).rejects.toMatchObject({ code: 'timeout', message: 'This request took too long. Please try again.' });
    await vi.advanceTimersByTimeAsync(51);
    await checked;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves caller cancellation so unmounted catalog requests do not show a network failure', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason)))));
    const result = requestJson('/api/catalog', { signal: controller.signal });
    const reason = new DOMException('Navigation cancelled this request', 'AbortError');
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
  });
  it('supports a successful empty deletion response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api('/list?titleId=test', { method: 'DELETE' })).resolves.toEqual({});
    expect(new RequestError('Unavailable', 503)).toBeInstanceOf(Error);
  });
});
