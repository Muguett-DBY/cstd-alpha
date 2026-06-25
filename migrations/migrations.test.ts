import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

function readMigration(name: string) {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

function tableColumns(db: DatabaseSync, table: string) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
}

function indexNames(db: DatabaseSync, table: string) {
  return new Set(db.prepare(`PRAGMA index_list(${table})`).all().map((row) => String(row.name)));
}

function addRuntimeResearchColumns(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE user_watchlist ADD COLUMN user_id TEXT;
    ALTER TABLE template_analysis ADD COLUMN user_id TEXT;
    ALTER TABLE template_analysis ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
    ALTER TABLE template_analysis ADD COLUMN object_key TEXT;
    ALTER TABLE template_analysis ADD COLUMN started_at TEXT;
    ALTER TABLE template_analysis ADD COLUMN completed_at TEXT;
    ALTER TABLE template_analysis ADD COLUMN error_message TEXT;
  `);
}

describe("D1 migrations", () => {
  test("fixed account migration is safe after runtime schema backfill", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readMigration("0002_user_research.sql"));
    addRuntimeResearchColumns(db);

    expect(() => db.exec(readMigration("0003_fixed_accounts_and_template_tasks.sql"))).not.toThrow();
    expect(tableColumns(db, "user_watchlist")).toContain("user_id");
    expect(tableColumns(db, "template_analysis")).toContain("status");
    expect(tableColumns(db, "template_analysis")).toContain("error_message");
  });

  test("radar entity migration creates normalized industry and scoring tables", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => db.exec(readMigration("0005_radar_entities.sql"))).not.toThrow();

    const industries = tableColumns(db, "industries");
    const evidenceItems = tableColumns(db, "evidence_items");
    const indicatorValues = tableColumns(db, "indicator_values");
    const radarItems = tableColumns(db, "radar_items");
    for (const column of ["id", "name", "parent_id", "level"]) expect(industries).toContain(column);
    for (const column of ["source_type", "published_at", "related_industry_id", "related_theme_id", "confidence"]) expect(evidenceItems).toContain(column);
    for (const column of ["entity_type", "entity_id", "indicator_name", "value", "period"]) expect(indicatorValues).toContain(column);
    for (const column of ["growth_score", "momentum_score", "evidence_score", "bubble_risk", "decline_risk"]) expect(radarItems).toContain(column);
  });

  test("company evidence package migration stores latest evidence pointers and hashes", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => db.exec(readMigration("0006_company_evidence_packages.sql"))).not.toThrow();

    const columns = tableColumns(db, "company_evidence_packages");
    for (const column of ["user_key", "watchlist_id", "evidence_hash", "material_hash", "stable_hash", "fresh_hash", "object_key", "status", "fetched_at"]) expect(columns).toContain(column);
  });

  test("research template migrations create editable templates and section requirements", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => db.exec(readMigration("0004_user_research_templates.sql"))).not.toThrow();
    expect(() => db.exec(readMigration("0007_template_section_requirements.sql"))).not.toThrow();

    const columns = tableColumns(db, "user_research_templates");
    for (const column of ["title", "full_prompt", "default_full_prompt", "section_requirements_json", "default_section_requirements_json"]) expect(columns).toContain(column);
  });

  test("watchlist ranking score migration adds both ranking dimensions", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => db.exec(readMigration("0008_watchlist_ranking_score.sql"))).not.toThrow();

    const columns = tableColumns(db, "watchlist_ranking_score");
    for (const column of ["company_quality_score", "investment_attractiveness_score", "overall_score", "model", "updated_at"]) expect(columns).toContain(column);
  });

  test("assistant migration stores chat, memory, tools, and usage history", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => db.exec(readMigration("0008_assistant.sql"))).not.toThrow();

    for (const table of ["assistant_threads", "assistant_messages", "assistant_memories", "assistant_memory_candidates", "assistant_tool_runs", "assistant_usage_events"]) {
      expect(tableColumns(db, table).size).toBeGreaterThan(0);
    }
    const usageColumns = tableColumns(db, "assistant_usage_events");
    expect(usageColumns).toContain("prompt_cache_hit_tokens");
    expect(usageColumns).toContain("prompt_cache_miss_tokens");
    expect(usageColumns).toContain("reasoning_effort");
  });

  test("assistant index migration adds user-key lookup indexes", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readMigration("0008_assistant.sql"));
    expect(() => db.exec(readMigration("0009_assistant_indexes.sql"))).not.toThrow();

    expect(indexNames(db, "assistant_messages")).toContain("idx_assistant_messages_user");
    expect(indexNames(db, "assistant_usage_events")).toContain("idx_assistant_usage_user");
    expect(indexNames(db, "assistant_tool_runs")).toContain("idx_assistant_tool_runs_user");
  });

  test("assistant deep research migration stores queued jobs and progress history", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => db.exec(readMigration("0012_assistant_deep_research.sql"))).not.toThrow();

    const jobs = tableColumns(db, "assistant_deep_research_jobs");
    for (const column of ["user_key", "thread_id", "research_kind", "status", "progress_stage", "stop_requested", "evidence_object_key", "result_message_id"]) {
      expect(jobs).toContain(column);
    }
    expect(indexNames(db, "assistant_deep_research_jobs")).toContain("idx_assistant_deep_research_status");
    expect(indexNames(db, "assistant_deep_research_steps")).toContain("idx_assistant_deep_research_steps_job");
  });

  test("research workbench migration stores research objects, thesis versions, notifications, and valuation runs", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => db.exec(readMigration("0013_research_workbench.sql"))).not.toThrow();

    const researchItems = tableColumns(db, "research_items");
    for (const column of ["user_key", "entity_type", "entity_id", "stage", "current_thesis_version_id", "evidence_hash"]) {
      expect(researchItems).toContain(column);
    }
    const thesis = tableColumns(db, "research_thesis_versions");
    for (const column of ["item_id", "version", "thesis_markdown", "core_citations_json", "counter_evidence_json"]) {
      expect(thesis).toContain(column);
    }
    const valuationRuns = tableColumns(db, "valuation_runs");
    for (const column of ["research_item_id", "archetype", "method", "assumptions_json", "result_json", "object_key"]) {
      expect(valuationRuns).toContain(column);
    }
    expect(indexNames(db, "research_items")).toContain("idx_research_items_user_stage");
    expect(indexNames(db, "research_notifications")).toContain("idx_research_notifications_user");
    expect(indexNames(db, "valuation_runs")).toContain("idx_valuation_runs_entity");
  });

  test("quantitative valuation migration creates audit tables", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => db.exec(readMigration("0016_quantitative_valuations.sql"))).not.toThrow();
    expect(() => db.exec(readMigration("0017_quantitative_version_notes.sql"))).not.toThrow();
    for (const table of [
      "valuation_source_snapshots",
      "valuation_forecast_versions",
      "valuation_assumption_values",
      "valuation_model_results",
      "valuation_actual_reviews",
    ]) expect(tableColumns(db, table).size).toBeGreaterThan(0);
    expect(tableColumns(db, "valuation_forecast_versions")).toContain("parent_version_id");
    expect(tableColumns(db, "valuation_forecast_versions")).toContain("draft_json");
    expect(tableColumns(db, "valuation_forecast_versions")).toContain("decision_note");
    expect(indexNames(db, "valuation_forecast_versions")).toContain("idx_valuation_forecast_versions_run");
  });

  test("lookup index migration adds hot-path query indexes without changing schema", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readMigration("0002_user_research.sql"));
    db.exec(readMigration("0003_fixed_accounts_and_template_tasks.sql"));
    db.exec(readMigration("0005_radar_entities.sql"));

    expect(() => db.exec(readMigration("0010_lookup_indexes.sql"))).not.toThrow();

    expect(indexNames(db, "template_analysis")).toContain("idx_template_analysis_watchlist");
    expect(indexNames(db, "auth_sessions")).toContain("idx_auth_sessions_token_hash");
    expect(indexNames(db, "securities")).toContain("idx_securities_company");
    expect(indexNames(db, "evidence_items")).toContain("idx_evidence_company_published");
    expect(indexNames(db, "evidence_items")).toContain("idx_evidence_theme_published");
    expect(indexNames(db, "watchlist_items")).toContain("idx_watchlist_items_entity");
  });

  test("retention and history index migration adds cleanup and lookup indexes", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readMigration("0001_report_library.sql"));
    db.exec(readMigration("0003_fixed_accounts_and_template_tasks.sql"));
    db.exec(readMigration("0005_radar_entities.sql"));

    expect(() => db.exec(readMigration("0011_retention_and_history_indexes.sql"))).not.toThrow();

    expect(indexNames(db, "auth_sessions")).toContain("idx_auth_sessions_expires");
    expect(indexNames(db, "radar_runs")).toContain("idx_radar_runs_time");
    expect(indexNames(db, "radar_runs")).toContain("idx_radar_runs_status_time");
    expect(indexNames(db, "report_library")).toContain("idx_report_library_ticker");
  });
});
