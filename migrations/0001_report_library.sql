CREATE TABLE IF NOT EXISTS report_library (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  ticker TEXT,
  market TEXT,
  industry TEXT,
  sector TEXT,
  cqs REAL NOT NULL,
  ias REAL NOT NULL,
  conclusion TEXT NOT NULL,
  qualitative_band TEXT NOT NULL,
  position_advice TEXT NOT NULL,
  valuation_view TEXT NOT NULL,
  as_of TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  evidence_count INTEGER NOT NULL,
  score_item_count INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  report_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_library_rank
ON report_library (ias DESC, cqs DESC, company_name ASC);

CREATE INDEX IF NOT EXISTS idx_report_library_identity
ON report_library (market, ticker, company_name);
