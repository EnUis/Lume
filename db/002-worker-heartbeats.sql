CREATE TABLE IF NOT EXISTS worker_heartbeats (owner TEXT PRIMARY KEY, last_seen BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS worker_last_seen ON worker_heartbeats(last_seen);
