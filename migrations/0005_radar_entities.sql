CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name_cn TEXT NOT NULL,
  name_en TEXT,
  main_business TEXT,
  country TEXT,
  exchange TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS securities (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  market TEXT NOT NULL,
  currency TEXT,
  listing_status TEXT NOT NULL DEFAULT 'listed',
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS industries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  level INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES industries(id)
);

CREATE TABLE IF NOT EXISTS themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry_id TEXT,
  description TEXT,
  FOREIGN KEY (industry_id) REFERENCES industries(id)
);

CREATE TABLE IF NOT EXISTS company_theme_memberships (
  company_id TEXT NOT NULL,
  theme_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, theme_id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (theme_id) REFERENCES themes(id)
);

CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  url TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  related_company_id TEXT,
  related_industry_id TEXT,
  related_theme_id TEXT,
  confidence REAL,
  raw_value TEXT,
  FOREIGN KEY (related_company_id) REFERENCES companies(id),
  FOREIGN KEY (related_industry_id) REFERENCES industries(id),
  FOREIGN KEY (related_theme_id) REFERENCES themes(id)
);

CREATE TABLE IF NOT EXISTS indicator_values (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  indicator_name TEXT NOT NULL,
  value REAL,
  period TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS radar_runs (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL DEFAULT 'A/H',
  run_time TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS radar_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  industry_id TEXT,
  theme_id TEXT,
  stage TEXT NOT NULL,
  conclusion TEXT,
  confidence REAL,
  risk REAL,
  growth_score REAL,
  momentum_score REAL,
  evidence_score REAL,
  valuation_risk REAL,
  bubble_risk REAL,
  decline_risk REAL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (run_id) REFERENCES radar_runs(id),
  FOREIGN KEY (industry_id) REFERENCES industries(id),
  FOREIGN KEY (theme_id) REFERENCES themes(id)
);

CREATE TABLE IF NOT EXISTS watchlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS watchlist_items (
  watchlist_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (watchlist_id, entity_type, entity_id),
  FOREIGN KEY (watchlist_id) REFERENCES watchlists(id)
);

CREATE INDEX IF NOT EXISTS idx_securities_ticker_market ON securities(ticker, market);
CREATE INDEX IF NOT EXISTS idx_industries_parent_level ON industries(parent_id, level);
CREATE INDEX IF NOT EXISTS idx_evidence_related ON evidence_items(related_industry_id, related_theme_id, published_at);
CREATE INDEX IF NOT EXISTS idx_indicator_entity ON indicator_values(entity_type, entity_id, indicator_name, period);
CREATE INDEX IF NOT EXISTS idx_radar_items_run_stage ON radar_items(run_id, stage);
