CREATE TABLE IF NOT EXISTS assistant_deep_research_jobs (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  query TEXT NOT NULL,
  mode TEXT NOT NULL,
  research_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress_title TEXT NOT NULL DEFAULT '正在排队...',
  progress_stage TEXT NOT NULL DEFAULT 'queued',
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 4,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  evidence_object_key TEXT,
  result_message_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assistant_deep_research_user ON assistant_deep_research_jobs (user_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_deep_research_thread ON assistant_deep_research_jobs (thread_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_deep_research_status ON assistant_deep_research_jobs (status, updated_at ASC);

CREATE TABLE IF NOT EXISTS assistant_deep_research_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  stage TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  tool_name TEXT,
  summary TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_deep_research_steps_job ON assistant_deep_research_steps (job_id, created_at ASC);
