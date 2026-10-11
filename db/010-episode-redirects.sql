CREATE TABLE IF NOT EXISTS episode_redirects (alias_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS episode_redirect_target ON episode_redirects(episode_id);
