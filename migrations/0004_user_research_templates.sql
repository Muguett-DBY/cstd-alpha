CREATE TABLE IF NOT EXISTS user_research_templates (
  id TEXT NOT NULL,
  user_id TEXT,
  user_key TEXT NOT NULL,
  title TEXT NOT NULL,
  short_title TEXT NOT NULL,
  focus TEXT NOT NULL,
  prompt TEXT NOT NULL,
  full_prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  default_title TEXT NOT NULL,
  default_short_title TEXT NOT NULL,
  default_focus TEXT NOT NULL,
  default_prompt TEXT NOT NULL,
  default_full_prompt TEXT NOT NULL,
  default_enabled INTEGER NOT NULL DEFAULT 1,
  default_sort_order INTEGER NOT NULL DEFAULT 0,
  default_is_system INTEGER NOT NULL DEFAULT 0,
  default_deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_key, id)
);

CREATE INDEX IF NOT EXISTS idx_user_research_templates_user
ON user_research_templates (user_key, sort_order ASC);
