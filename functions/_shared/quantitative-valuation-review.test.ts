import { describe, expect, test } from "vitest";
import { buildActualReviews } from "./quantitative-valuation-review";
import type { CompanyEvidencePackage } from "./company-evidence";
import type { QuantitativeDraft } from "../../src/shared/quantitative-valuation";
import type { ValuationResult } from "../../src/shared/valuation";

describe("quantitative valuation actual review", () => {
  test("records revenue error for a matching reported fiscal year", () => {
    const draft = { method: "dcf_3_statement", archetype: "operating", currency: "CNY", asOf: "2025-12-31" } as QuantitativeDraft;
    const result = {
      method: "dcf_3_statement", archetype: "operating", currency: "CNY", asOf: "2025-12-31", assumptions: [], scenarios: [],
      forecastRows: [{ year: 1, revenue: 120, ebit: 24, tax: 4, nopat: 20, depreciationAmortization: 5, capex: 8, workingCapitalChange: 2, freeCashFlow: 15 }],
    } satisfies ValuationResult;
    const evidence = evidenceWithRows([
      { metric: "营业收入", values: { "2026": "100亿元" } },
      { metric: "EBIT", values: { "2026": "20亿元" } },
      { metric: "自由现金流", values: { "2026": "12亿元" } },
    ]);

    const reviews = buildActualReviews(draft, result, evidence);

    expect(reviews).toContainEqual(expect.objectContaining({
      metricKey: "revenue", forecastYear: 2026, forecastValue: 120, actualValue: 100,
      absoluteError: 20, percentageError: 20 / 120,
    }));
    expect(reviews.map((review) => review.metricKey)).toEqual(["revenue", "ebit", "freeCashFlow"]);
  });

  test("does not map TTM or mismatched fiscal years onto the forecast", () => {
    const draft = { method: "dcf_3_statement", archetype: "operating", currency: "CNY", asOf: "2025-12-31" } as QuantitativeDraft;
    const result = {
      method: "dcf_3_statement", archetype: "operating", currency: "CNY", asOf: "2025-12-31", assumptions: [], scenarios: [],
      forecastRows: [{ year: 1, revenue: 120, ebit: 24, tax: 4, nopat: 20, depreciationAmortization: 5, capex: 8, workingCapitalChange: 2, freeCashFlow: 15 }],
    } satisfies ValuationResult;
    const evidence = evidenceWithRows([{ metric: "营业收入", values: { TTM: "110亿元", "2025": "100亿元" } }]);

    expect(buildActualReviews(draft, result, evidence)).toEqual([]);
  });
});

function evidenceWithRows(rows: Array<{ metric: string; values: Record<string, string> }>): CompanyEvidencePackage {
  return {
    version: 1, userId: "user-1", watchlistId: "watch-1", companyKey: "A股:600519",
    evidenceHash: "e1", materialHash: "m1", stableHash: "s1", freshHash: "f1",
    fetchedAt: "2026-06-21T00:00:00.000Z",
    stableFacts: { financialTenYear: { rows } }, freshSignals: {},
    evidence: { company: { name: "样本", ticker: "600519", market: "A股" }, retrievedAt: "2026-06-21T00:00:00.000Z", evidence: [], facts: {} },
  };
}
