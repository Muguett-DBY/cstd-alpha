CREATE TABLE IF NOT EXISTS user_watchlist (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  company_name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  market TEXT NOT NULL,
  exchange_name TEXT,
  listing_place TEXT,
  market_type TEXT,
  source TEXT,
  report_library_id TEXT,
  added_at TEXT NOT NULL,
  UNIQUE(user_key, ticker, market)
);

CREATE INDEX IF NOT EXISTS idx_user_watchlist_user
ON user_watchlist (user_key, added_at DESC);

CREATE TABLE IF NOT EXISTS template_analysis (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  watchlist_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_title TEXT NOT NULL,
  company_name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  market TEXT NOT NULL,
  model TEXT NOT NULL,
  title TEXT NOT NULL,
  score REAL,
  verdict TEXT NOT NULL,
  summary TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_key, watchlist_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_template_analysis_user
ON template_analysis (user_key, updated_at DESC);
