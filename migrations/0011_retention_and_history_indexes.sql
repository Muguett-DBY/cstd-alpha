CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
ON auth_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_radar_runs_time
ON radar_runs (run_time DESC);

CREATE INDEX IF NOT EXISTS idx_radar_runs_status_time
ON radar_runs (status, run_time DESC);

CREATE INDEX IF NOT EXISTS idx_report_library_ticker
ON report_library (ticker);
