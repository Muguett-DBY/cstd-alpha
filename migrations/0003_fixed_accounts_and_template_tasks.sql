CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_username
ON users (username);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
ON auth_sessions (user_id, expires_at DESC);

ALTER TABLE user_watchlist ADD COLUMN user_id TEXT;
ALTER TABLE template_analysis ADD COLUMN user_id TEXT;
ALTER TABLE template_analysis ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE template_analysis ADD COLUMN object_key TEXT;
ALTER TABLE template_analysis ADD COLUMN started_at TEXT;
ALTER TABLE template_analysis ADD COLUMN completed_at TEXT;
ALTER TABLE template_analysis ADD COLUMN error_message TEXT;
