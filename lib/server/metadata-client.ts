import type { DB } from './db';
import { safeFetch, type SafeFetcher } from './outbound';
import { hash } from './security';

export class MetadataDeferred extends Error { constructor(message: string, public retryAt: number) { super(message); } }
export interface MetadataClientOptions { fetcher?: SafeFetcher; now?: () => number; sleep?: (ms: number) => Promise<void>; userAgent?: string }
export function metadataClient(db: DB, options: MetadataClientOptions = {}) {
  const fetcher = options.fetcher || safeFetch; const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  return async (provider: string, url: string, headers: Record<string, string> = {}, ttlMs = 86400000): Promise<any> => {
    // Credentials contribute only to the hash, preventing cross-credential cache reuse.
    const key = hash(JSON.stringify([provider, url, headers.Authorization || '']));
    const cached = await db.get('SELECT response FROM metadata_http_cache WHERE cache_key=? AND expires_at>?', [key, now()]);
    if (cached) { try { return JSON.parse(cached.response); } catch { await db.run('DELETE FROM metadata_http_cache WHERE cache_key=?', [key]); } }
    const time = now(); const spacing = provider === 'tvmaze' ? 600 : 1100;
    // One atomic, portable reservation shares the request budget across worker processes.
    const slot = await db.get('INSERT INTO metadata_provider_state(provider,next_request_at) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET next_request_at=CASE WHEN metadata_provider_state.next_request_at>? THEN metadata_provider_state.next_request_at+? ELSE ? END WHERE metadata_provider_state.next_request_at<=? RETURNING next_request_at', [provider, time + spacing, time, spacing, time + spacing, time + 15000]);
    if (!slot) { const state = await db.get('SELECT next_request_at FROM metadata_provider_state WHERE provider=?', [provider]); throw new MetadataDeferred(`${provider} metadata provider is cooling down`, Number(state?.next_request_at) || time + 60000); }
    const wait = Number(slot.next_request_at) - spacing - time; if (wait > 0) await sleep(wait);
    const response = await fetcher(url, { maxBytes: 2097152, timeoutMs: 15000, headers: { Accept: 'application/json', 'User-Agent': options.userAgent || process.env.METADATA_USER_AGENT || 'Lume-Metadata/1.0 (automatic catalog lookup)', ...headers } });
    let data: any; try { data = JSON.parse(response.body.toString('utf8')); } catch { if (response.status === 200) throw new Error(`${provider} metadata provider returned invalid JSON`); }
    if ([429, 503].includes(response.status) || data?.error?.code === 'maxlag') {
      const seconds = Number(response.headers['retry-after']); const parsedDate = Date.parse(response.headers['retry-after'] || '');
      const retryAt = Math.max(now() + 60000, Math.min(now() + 3600000, Number.isFinite(seconds) && seconds > 0 ? now() + seconds * 1000 : Number.isFinite(parsedDate) ? parsedDate : now() + 120000));
      await db.run('INSERT INTO metadata_provider_state(provider,next_request_at) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET next_request_at=CASE WHEN metadata_provider_state.next_request_at>excluded.next_request_at THEN metadata_provider_state.next_request_at ELSE excluded.next_request_at END', [provider, retryAt]);
      throw new MetadataDeferred(`${provider} metadata provider temporarily deferred requests`, retryAt);
    }
    if (response.status !== 200 || response.truncated) throw new Error(`${provider === 'licensed' ? 'Licensed metadata provider' : `${provider} metadata provider`} returned HTTP ${response.status}${response.truncated ? ' (incomplete response)' : ''}`);
    if (!data || typeof data !== 'object' || data.error) throw new Error(`${provider} metadata provider returned an invalid response`);
    await db.run('INSERT INTO metadata_http_cache(cache_key,response,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET response=excluded.response,expires_at=excluded.expires_at', [key, JSON.stringify(data), now() + ttlMs]);
    return data;
  };
}
