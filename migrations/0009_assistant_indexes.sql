CREATE INDEX IF NOT EXISTS idx_assistant_messages_user ON assistant_messages (user_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_usage_user ON assistant_usage_events (user_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_tool_runs_user ON assistant_tool_runs (user_key, created_at DESC);
