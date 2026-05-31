CREATE INDEX IF NOT EXISTS idx_template_analysis_watchlist
ON template_analysis (watchlist_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash
ON auth_sessions (token_hash);

CREATE INDEX IF NOT EXISTS idx_securities_company
ON securities (company_id);

CREATE INDEX IF NOT EXISTS idx_evidence_company_published
ON evidence_items (related_company_id, published_at);

CREATE INDEX IF NOT EXISTS idx_evidence_theme_published
ON evidence_items (related_theme_id, published_at);

CREATE INDEX IF NOT EXISTS idx_watchlist_items_entity
ON watchlist_items (entity_type, entity_id);
