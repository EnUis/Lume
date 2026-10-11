CREATE TABLE IF NOT EXISTS metadata_lookups (
  title_id TEXT PRIMARY KEY REFERENCES titles(id) ON DELETE CASCADE,
  identity_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT,
  provider_id TEXT,
  checked_at BIGINT,
  retry_after BIGINT NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS metadata_lookups_retry ON metadata_lookups(retry_after,title_id);
CREATE TABLE IF NOT EXISTS metadata_http_cache (cache_key TEXT PRIMARY KEY,response TEXT NOT NULL,expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS metadata_http_cache_expiry ON metadata_http_cache(expires_at);
CREATE TABLE IF NOT EXISTS metadata_provider_state (provider TEXT PRIMARY KEY,next_request_at BIGINT NOT NULL DEFAULT 0);
