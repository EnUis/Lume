CREATE INDEX IF NOT EXISTS jobs_ready_type ON jobs(type,run_after,created_at) WHERE status='queued' AND attempts<max_attempts;
CREATE INDEX IF NOT EXISTS jobs_running_type ON jobs(type,run_after,created_at,lease_until) WHERE status='running' AND attempts<max_attempts;
CREATE INDEX IF NOT EXISTS jobs_expired_terminal ON jobs(lease_until) WHERE status='running' AND attempts>=max_attempts;
CREATE INDEX IF NOT EXISTS jobs_ready_order ON jobs(run_after,created_at) WHERE status='queued' AND attempts<max_attempts;
CREATE INDEX IF NOT EXISTS jobs_running_order ON jobs(run_after,created_at,lease_until) WHERE status='running' AND attempts<max_attempts;
CREATE INDEX IF NOT EXISTS review_status_recent ON review_queue(status,created_at);
ANALYZE jobs;
