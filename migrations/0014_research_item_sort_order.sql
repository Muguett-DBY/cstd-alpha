-- Add sort_order column to research_items for drag-and-drop reordering
ALTER TABLE research_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Index for ordering within stages
CREATE INDEX IF NOT EXISTS idx_research_items_user_stage_order ON research_items (user_key, stage, sort_order ASC, updated_at DESC);
