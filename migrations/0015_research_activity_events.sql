-- Activity events table for research workbench timeline
CREATE TABLE IF NOT EXISTS research_activity_events (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_activity_events_item ON research_activity_events (item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_activity_events_user ON research_activity_events (user_key, created_at DESC);
