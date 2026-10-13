/** pg sometimes omits a code when its socket closes or its connect timer fires. */
export function databaseConnectionFailure(error: unknown): 'dns' | 'connection' | 'paused' | null {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const detail = error as { code?: string; message?: string; cause?: unknown };
    // Video-runtime errors describe upstream media/capacity, not the database.
    if ('classification' in detail && ['source', 'capacity', 'configuration', 'cancelled', 'session'].includes(String((detail as { classification?: unknown }).classification))) return null;
    if (/branch is hibernated|database (?:branch )?is (?:paused|suspended)/i.test(detail.message || '')) return 'paused';
    if (/^(?:ENOTFOUND|EAI_AGAIN)$/.test(detail.code || '') || /^getaddrinfo (?:ENOTFOUND|EAI_AGAIN)\b/.test(detail.message || '')) return 'dns';
    if (/^(?:08[0-9A-Z]{3}|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|57P0[123])$/.test(detail.code || '') || /^(?:Connection terminated(?: unexpectedly| due to connection timeout)?|Connection closed unexpectedly|timeout exceeded when trying to connect)$/i.test(detail.message || '')) return 'connection';
    error = detail.cause;
  }
  return null;
}

let lastDatabaseNotice = 0;
export function databaseUnavailableResponse(error: unknown): Response | null {
  const failure = databaseConnectionFailure(error); if (!failure) return null;
  if (Date.now() - lastDatabaseNotice >= 60000) {
    lastDatabaseNotice = Date.now();
    console.warn(failure === 'paused' ? 'Database is paused by its hosting provider. Reactivate the database branch to restore the library.' : 'Database connection is temporarily unavailable. Requests will retry after the connection recovers.');
  }
  return Response.json({ error: 'The library is temporarily unavailable. Please try again shortly.', code: 'DATABASE_UNAVAILABLE' }, { status: 503, headers: { 'Retry-After': '15', 'Cache-Control': 'no-store' } });
}
