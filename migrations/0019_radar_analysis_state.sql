CREATE TABLE IF NOT EXISTS radar_analysis_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  job_id TEXT NOT NULL,
  run_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'publishing', 'failing', 'completed', 'failed')),
  evidence_hash TEXT,
  message TEXT,
  radar_generated_at TEXT,
  token_usage_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
