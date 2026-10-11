export class RequestError extends Error {
  constructor(message: string, public status = 0, public code: 'http' | 'network' | 'timeout' | 'invalid_response' = 'http') {
    super(message); this.name = 'RequestError';
  }
}

/** Same-origin JSON requests; never retry mutations automatically. */
export async function requestJson<T>(url: string, options: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const headers = new Headers(options.headers);
  // Payload-free actions still follow the server's JSON mutation contract.
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body == null && ['POST', 'PUT', 'PATCH'].includes(method) ? '{}' : options.body;
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (typeof body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  try {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, body, headers, signal: controller.signal });
    const content = await response.text();
    let data: unknown;
    try { data = content ? JSON.parse(content) : undefined; } catch { /* Never show an HTML error page or parser exception to a viewer. */ }
    if (!response.ok) {
      const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : undefined;
      throw new RequestError(message || (response.status >= 500 ? 'Lume could not complete this request. Please try again.' : `This request could not be completed (${response.status}).`), response.status);
    }
    if (response.status === 204 && !content) return {} as T;
    if (data === undefined || data === null || typeof data !== 'object') throw new RequestError('Lume returned an incomplete response. Please try again.', response.status, 'invalid_response');
    return data as T;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (options.signal?.aborted) throw options.signal.reason || error;
    if (timedOut) throw new RequestError('This request took too long. Please try again.', 0, 'timeout');
    throw new RequestError('Could not connect to Lume. Check your connection and try again.', 0, 'network');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> { return requestJson<T>(`/api${path}`, options); }
export function minutes(seconds: number | null) { return seconds ? `${Math.round(seconds / 60)} min` : ''; }
