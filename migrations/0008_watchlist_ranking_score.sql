CREATE TABLE IF NOT EXISTS watchlist_ranking_score (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  watchlist_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  market TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  model TEXT,
  company_quality_score REAL,
  investment_attractiveness_score REAL,
  overall_score REAL,
  verdict TEXT,
  summary TEXT,
  content_json TEXT,
  evidence_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  UNIQUE(user_key, watchlist_id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_ranking_user
ON watchlist_ranking_score (user_key, overall_score DESC, updated_at DESC);
