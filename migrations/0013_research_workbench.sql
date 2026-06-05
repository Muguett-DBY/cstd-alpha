CREATE TABLE IF NOT EXISTS research_items (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  stage TEXT NOT NULL DEFAULT 'screening',
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'manual',
  evidence_hash TEXT,
  current_thesis_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE(user_key, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_research_items_user_stage
ON research_items (user_key, stage, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_items_entity
ON research_items (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS research_thesis_versions (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  thesis_markdown TEXT NOT NULL,
  core_citations_json TEXT NOT NULL DEFAULT '[]',
  counter_evidence_json TEXT NOT NULL DEFAULT '[]',
  evidence_hash TEXT,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES research_items(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_thesis_item_version
ON research_thesis_versions (item_id, version);

CREATE TABLE IF NOT EXISTS research_catalysts (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES research_items(id)
);

CREATE INDEX IF NOT EXISTS idx_research_catalysts_item
ON research_catalysts (item_id, status, due_at);

CREATE TABLE IF NOT EXISTS research_stage_suggestions (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  from_stage TEXT NOT NULL,
  to_stage TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (item_id) REFERENCES research_items(id)
);

CREATE INDEX IF NOT EXISTS idx_research_stage_suggestions_pending
ON research_stage_suggestions (user_key, status, created_at DESC);

CREATE TABLE IF NOT EXISTS research_notifications (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  item_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  status TEXT NOT NULL DEFAULT 'unread',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  read_at TEXT,
  FOREIGN KEY (item_id) REFERENCES research_items(id)
);

CREATE INDEX IF NOT EXISTS idx_research_notifications_user
ON research_notifications (user_key, status, created_at DESC);

CREATE TABLE IF NOT EXISTS valuation_runs (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  research_item_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  archetype TEXT NOT NULL,
  method TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  input_hash TEXT,
  evidence_hash TEXT,
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT,
  object_key TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (research_item_id) REFERENCES research_items(id)
);

CREATE INDEX IF NOT EXISTS idx_valuation_runs_user
ON valuation_runs (user_key, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_valuation_runs_entity
ON valuation_runs (entity_type, entity_id, updated_at DESC);
