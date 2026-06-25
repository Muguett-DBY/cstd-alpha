import { describe, expect, test } from "vitest";
import {
  createOrReadValuationSourceSnapshot,
  createQuantitativeVersion,
  listQuantitativeVersions,
  readQuantitativeWorkspace,
} from "./research-workbench-db";
import type { QuantitativeDraft } from "../../src/shared/quantitative-valuation";
import type { ValuationResult } from "../../src/shared/valuation";

const draft: QuantitativeDraft & { assumptions: Array<Record<string, unknown>> } = {
  method: "dcf_3_statement",
  archetype: "operating",
  currency: "CNY",
  asOf: "2026-06-21",
  scenarios: {
    base: { discountRate: 0.1, terminalGrowthRate: 0.025 },
  },
  operating: {
    currency: "CNY",
    asOf: "2026-06-21",
    baseRevenue: 100,
    sharesOutstanding: 10,
    netDebt: 5,
    revenueGrowth: { low: 0.03, base: 0.07, high: 0.11 },
    ebitMargin: { low: 0.08, base: 0.13, high: 0.18 },
    taxRate: 0.2,
    depreciationRate: 0.035,
    capexRate: { low: 0.04, base: 0.06, high: 0.08 },
    workingCapitalRate: 0.015,
    discountRate: { low: 0.085, base: 0.1, high: 0.115 },
    terminalGrowthRate: { low: 0.015, base: 0.025, high: 0.035 },
  },
  assumptions: [
    { key: "revenueGrowth", label: "收入增速", bear: 3, base: 7, bull: 11, unit: "%", origin: "formula", locked: false, confidence: 0.7, evidenceRefs: ["E1"] },
  ],
};

const result: ValuationResult = {
  method: "dcf_3_statement",
  archetype: "operating",
  currency: "CNY",
  asOf: "2026-06-21",
  assumptions: [],
  scenarios: [{ scenario: "base", equityValue: 1000, perShareValue: 100, summary: "基准" }],
};

describe("quantitative valuation persistence", () => {
  test("creates a source snapshot once and returns its normalized summary", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = fakeDb(statements, (sql) => sql.includes("FROM valuation_source_snapshots") ? {
      id: "snapshot-1", user_key: "user-a", research_item_id: "research-1", market: "A股",
      as_of: "2026-06-21", payload_json: '{"company":"样本"}', evidence_hash: "evidence-1",
      content_hash: "content-1", created_at: "2026-06-21T00:00:00.000Z",
    } : null);

    const snapshot = await createOrReadValuationSourceSnapshot(db, {
      userKey: "user-a", researchItemId: "research-1", market: "A股", asOf: "2026-06-21",
      payload: { company: "样本" }, evidenceHash: "evidence-1", contentHash: "content-1",
    });

    expect(snapshot).toMatchObject({ id: "snapshot-1", userKey: "user-a", contentHash: "content-1" });
    expect(statements.some(({ sql }) => sql.includes("INSERT OR IGNORE INTO valuation_source_snapshots"))).toBe(true);
  });

  test("creates a successor version and inserts normalized assumptions and model output in one batch", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const batchSizes: number[] = [];
    const db = fakeDb(statements, (sql) => sql.includes("MAX(version)") ? { next_version: 2 } : null, batchSizes);

    const version = await createQuantitativeVersion(db, {
      userKey: "user-a", runId: "run-1", snapshotId: "snapshot-1", draft, result,
      parentVersionId: "version-1", createdBy: "user", decisionNote: "上调收入增速，跟踪订单兑现。",
    });

    expect(version).toMatchObject({ runId: "run-1", version: 2, parentVersionId: "version-1", createdBy: "user", decisionNote: "上调收入增速，跟踪订单兑现。" });
    expect(batchSizes).toEqual([expect.any(Number)]);
    const versionInsert = statements.find(({ sql }) => sql.includes("INSERT INTO valuation_forecast_versions"));
    expect(versionInsert?.sql).toContain("decision_note");
    expect(versionInsert?.bindings).toContain("上调收入增速，跟踪订单兑现。");
    expect(statements.some(({ sql }) => sql.includes("INSERT INTO valuation_assumption_values"))).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("INSERT INTO valuation_model_results"))).toBe(true);
  });

  test("lists versions only through a user-scoped query", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = fakeDb(statements, () => null, undefined, (sql) => sql.includes("FROM valuation_forecast_versions") ? [{
      id: "version-2", user_key: "user-a", valuation_run_id: "run-1", source_snapshot_id: "snapshot-1",
      version: 2, status: "saved", parent_version_id: "version-1", archetype: "operating",
      method: "dcf_3_statement", horizon_years: 5, created_by: "user", created_at: "2026-06-22T00:00:00.000Z",
      decision_note: "保留谨慎假设，等待半年报验证。",
      draft_json: JSON.stringify(draft),
    }] : []);

    const versions = await listQuantitativeVersions(db, "user-a", "run-1");

    expect(versions.map((item) => item.version)).toEqual([2]);
    expect(versions[0]?.decisionNote).toBe("保留谨慎假设，等待半年报验证。");
    const query = statements.find(({ sql }) => sql.includes("FROM valuation_forecast_versions"));
    expect(query?.sql).toContain("user_key = ?1");
    expect(query?.bindings).toEqual(["user-a", "run-1"]);
  });

  test("returns null when the run is not owned by the current user", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = fakeDb(statements, () => null);

    await expect(readQuantitativeWorkspace(db, "other-user", "run-1")).resolves.toBeNull();
    expect(statements.find(({ sql }) => sql.includes("FROM valuation_runs"))?.bindings).toEqual(["other-user", "run-1"]);
  });
});

function fakeDb(
  statements: Array<{ sql: string; bindings: unknown[] }>,
  firstResult: (sql: string) => unknown,
  batchSizes?: number[],
  allResult: (sql: string) => unknown[] = () => [],
) {
  return {
    async batch(items: unknown[]) {
      batchSizes?.push(items.length);
      return [];
    },
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          statements.push({ sql, bindings });
          return {
            async first() { return firstResult(sql); },
            async all() { return { results: allResult(sql) }; },
            async run() { return { meta: { changes: 1 } }; },
          };
        },
      };
    },
  } as unknown as D1Database;
}
