import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

function readMigration(name: string) {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

function tableColumns(db: DatabaseSync, table: string) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
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
});
