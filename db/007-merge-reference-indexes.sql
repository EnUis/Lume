CREATE INDEX IF NOT EXISTS sources_episode_reference ON sources(episode_id);
CREATE INDEX IF NOT EXISTS episodes_season_reference ON episodes(season_id);
CREATE INDEX IF NOT EXISTS review_candidate_reference ON review_queue(candidate_id);
CREATE INDEX IF NOT EXISTS sources_url_playback_reference ON sources(url_hash,playback_blocked,playback_blocked_at);
