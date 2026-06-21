CREATE TABLE IF NOT EXISTS valuation_source_snapshots (
  id TEXT PRIMARY KEY, user_key TEXT NOT NULL, research_item_id TEXT NOT NULL,
  market TEXT NOT NULL, as_of TEXT NOT NULL, payload_json TEXT NOT NULL,
  evidence_hash TEXT, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(user_key, research_item_id, content_hash)
);
CREATE TABLE IF NOT EXISTS valuation_forecast_versions (
  id TEXT PRIMARY KEY, user_key TEXT NOT NULL, valuation_run_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  parent_version_id TEXT, archetype TEXT NOT NULL, method TEXT NOT NULL,
  horizon_years INTEGER NOT NULL, draft_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(valuation_run_id, version)
);
CREATE TABLE IF NOT EXISTS valuation_assumption_values (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL, key TEXT NOT NULL, scenario TEXT NOT NULL,
  forecast_year INTEGER, value REAL NOT NULL, unit TEXT NOT NULL, origin TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0, confidence REAL, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  explanation TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS valuation_model_results (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL, model_key TEXT NOT NULL, weight REAL,
  payload_json TEXT NOT NULL, calculation_hash TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, UNIQUE(version_id, model_key)
);
CREATE TABLE IF NOT EXISTS valuation_actual_reviews (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL, metric_key TEXT NOT NULL,
  forecast_year INTEGER NOT NULL, forecast_value REAL NOT NULL, actual_value REAL NOT NULL,
  absolute_error REAL NOT NULL, percentage_error REAL, reviewed_at TEXT NOT NULL,
  UNIQUE(version_id, metric_key, forecast_year)
);
CREATE INDEX IF NOT EXISTS idx_valuation_forecast_versions_run
  ON valuation_forecast_versions (user_key, valuation_run_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_valuation_source_snapshots_item
  ON valuation_source_snapshots (user_key, research_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_valuation_assumption_values_version
  ON valuation_assumption_values (version_id, key, scenario, forecast_year);
