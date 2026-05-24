CREATE TABLE IF NOT EXISTS assistant_threads (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  summary_object_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_threads_user ON assistant_threads (user_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_thread ON assistant_messages (thread_id, created_at ASC);

CREATE TABLE IF NOT EXISTS assistant_memories (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_memories_user ON assistant_memories (user_key, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_memory_candidates (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  message_id TEXT,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_memory_candidates_user ON assistant_memory_candidates (user_key, status, created_at DESC);

CREATE TABLE IF NOT EXISTS assistant_tool_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_tool_runs_thread ON assistant_tool_runs (thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assistant_usage_events (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  user_key TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  prompt_cache_hit_tokens INTEGER,
  prompt_cache_miss_tokens INTEGER,
  elapsed_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_usage_thread ON assistant_usage_events (thread_id, created_at DESC);
