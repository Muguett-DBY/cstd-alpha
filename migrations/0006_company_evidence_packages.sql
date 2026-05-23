CREATE TABLE IF NOT EXISTS company_evidence_packages (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_key TEXT NOT NULL,
  watchlist_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  market TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  material_hash TEXT NOT NULL DEFAULT '',
  stable_hash TEXT NOT NULL,
  fresh_hash TEXT NOT NULL,
  object_key TEXT NOT NULL,
  status TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_message TEXT,
  UNIQUE(user_key, watchlist_id)
);

CREATE INDEX IF NOT EXISTS idx_company_evidence_user
ON company_evidence_packages (user_key, updated_at DESC);
