ALTER TABLE sources ADD COLUMN language TEXT;
ALTER TABLE sources ADD COLUMN original_name TEXT;
ALTER TABLE sources ADD COLUMN playback_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN playback_blocked_at BIGINT;
CREATE INDEX IF NOT EXISTS sources_verified_playback ON sources(health,playback_blocked,enabled,removed,title_id,episode_id,playlist_id,last_success);
CREATE TABLE IF NOT EXISTS title_redirects (alias_id TEXT PRIMARY KEY,title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS title_redirect_target ON title_redirects(title_id);
