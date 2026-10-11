-- Keep dashboard aggregates on compact indexes rather than encrypted source rows.
CREATE INDEX IF NOT EXISTS sources_admin_summary ON sources(removed,playlist_id,enabled,health,playback_blocked);
CREATE INDEX IF NOT EXISTS sources_admin_playable ON sources(health,enabled,removed,playback_blocked,playlist_id,title_id,episode_id);
CREATE INDEX IF NOT EXISTS sources_review_reference ON sources(id,removed,playlist_id);
CREATE INDEX IF NOT EXISTS titles_admin_summary ON titles(type,published,id);
-- Let both supported planners choose the new covering indexes for existing data.
ANALYZE sources;
ANALYZE titles;
