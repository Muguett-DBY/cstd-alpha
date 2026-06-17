import { describe, expect, test } from "vitest";
import type { ValuationRunSummary } from "./shared/valuation";
import { filterValuationRunsForDisplay, hasActiveValuationRuns, mergeValuationRuns, valuationAssumptionsForDisplay } from "./valuation-state";

describe("valuation state", () => {
  test("polls only while at least one valuation is queued or running", () => {
    expect(hasActiveValuationRuns([valuationRun("queued")])).toBe(true);
    expect(hasActiveValuationRuns([valuationRun("running")])).toBe(true);
    expect(hasActiveValuationRuns([valuationRun("completed"), valuationRun("failed")])).toBe(false);
  });

  test("replaces stale queued runs with the latest server status", () => {
    const current = [
      valuationRun("queued", "run-1", "2026-06-15T17:34:49.769Z"),
      valuationRun("completed", "run-0", "2026-06-14T14:39:44.133Z"),
    ];
    const latest = [
      valuationRun("failed", "run-1", "2026-06-15T17:36:39.773Z"),
      valuationRun("completed", "run-0", "2026-06-14T14:39:44.133Z"),
    ];

    expect(mergeValuationRuns(current, latest)).toEqual(latest);
  });

  test("hides completed legacy valuations that predate grounded methodology metadata", () => {
    const legacy = valuationRun("completed", "legacy");
    legacy.result = {
      method: "dcf_3_statement",
      archetype: "operating",
      currency: "CNY",
      asOf: "2026-06-01",
      assumptions: [],
      scenarios: [],
    };
    const grounded = valuationRun("completed", "grounded");
    grounded.result = {
      ...legacy.result,
      methodologyVersion: 2,
    };
    const failed = valuationRun("failed", "failed");

    expect(filterValuationRunsForDisplay([legacy, grounded, failed])).toEqual([grounded, failed]);
  });

  test("formats key valuation assumptions for card display", () => {
    const run = valuationRun("completed", "assumptions");
    run.result = {
      method: "dcf_3_statement",
      archetype: "operating",
      currency: "CNY",
      asOf: "2026-06-18",
      assumptions: [
        { key: "terminalGrowthRate", label: "永续增长率", low: 1, base: 2.5, high: 3, unit: "%", origin: "ai", evidenceRefs: ["E1"], confidence: 0.62, locked: false },
        { key: "revenueGrowth", label: "收入增速", low: 3, base: 7, high: 11, unit: "%", origin: "ai", evidenceRefs: ["E2", "E3"], confidence: 0.71, locked: false },
        { key: "discountRate", label: "WACC", low: 8.5, base: 10, high: 11.5, unit: "%", origin: "ai", evidenceRefs: [], confidence: 0.55, locked: false },
        { key: "peerEvEbitda", label: "同业倍数", low: 8, base: 11.5, high: 14, unit: "x", origin: "formula", evidenceRefs: ["P1"], confidence: 0.48, locked: true },
      ],
      scenarios: [],
      methodologyVersion: 2,
    };

    expect(valuationAssumptionsForDisplay(run)).toEqual([
      { key: "revenueGrowth", label: "收入增速", value: "7.0%", meta: "置信 71% / 证据 2" },
      { key: "discountRate", label: "WACC", value: "10.0%", meta: "置信 55% / 证据 0" },
      { key: "terminalGrowthRate", label: "永续增长率", value: "2.5%", meta: "置信 62% / 证据 1" },
      { key: "peerEvEbitda", label: "同业倍数", value: "11.5x", meta: "锁定 / 置信 48% / 证据 1" },
    ]);
  });
});

function valuationRun(
  status: ValuationRunSummary["status"],
  id = `run-${status}`,
  updatedAt = "2026-06-15T00:00:00.000Z",
): ValuationRunSummary {
  return {
    id,
    entityType: "company",
    entityId: "company-1",
    title: "贵州茅台",
    status,
    archetype: "operating",
    method: "three_statement_dcf",
    currency: "CNY",
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt,
  };
}
