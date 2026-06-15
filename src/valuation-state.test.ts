import { describe, expect, test } from "vitest";
import type { ValuationRunSummary } from "./shared/valuation";
import { filterValuationRunsForDisplay, hasActiveValuationRuns, mergeValuationRuns } from "./valuation-state";

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
