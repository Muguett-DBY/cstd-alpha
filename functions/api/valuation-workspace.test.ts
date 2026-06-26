import { describe, expect, test } from "vitest";
import { isAshareResearchItem, mergeUserAssumptions, onRequestGet } from "./valuation-workspace";
import type { QuantitativeDraft } from "../../src/shared/quantitative-valuation";

describe("valuation workspace API contract", () => {
  test("rejects unauthenticated workspace reads", async () => {
    const response = await onRequestGet({
      request: new Request("https://example.test/api/valuation-workspace?runId=run-1"),
      env: { AUTH_SECRET: "test-secret" },
    } as never);

    expect(response.status).toBe(401);
  });

  test("recognizes only six-digit A-share research items", () => {
    expect(isAshareResearchItem({ entityType: "company", entityId: "candidate-1", subtitle: "600519 / 沪A" })).toBe(true);
    expect(isAshareResearchItem({ entityType: "company", entityId: "watch-1", subtitle: "300750 / 创业板" })).toBe(true);
    expect(isAshareResearchItem({ entityType: "company", entityId: "AAPL", subtitle: "AAPL / NASDAQ" })).toBe(false);
    expect(isAshareResearchItem({ entityType: "industry", entityId: "bank", subtitle: "银行" })).toBe(false);
  });

  test("locks user assumption edits and synchronizes percent points into decimal calculation inputs", () => {
    const draft: QuantitativeDraft = {
      method: "dcf_3_statement",
      archetype: "operating",
      currency: "CNY",
      asOf: "2026-06-21",
      operating: {
        currency: "CNY", asOf: "2026-06-21", baseRevenue: 100, sharesOutstanding: 10, netDebt: 5,
        revenueGrowth: { low: 0.03, base: 0.07, high: 0.11 },
        ebitMargin: { low: 0.08, base: 0.13, high: 0.18 }, taxRate: 0.2, depreciationRate: 0.035,
        capexRate: { low: 0.04, base: 0.06, high: 0.08 }, workingCapitalRate: 0.015,
        discountRate: { low: 0.085, base: 0.1, high: 0.115 },
        terminalGrowthRate: { low: 0.015, base: 0.025, high: 0.035 },
      },
      assumptions: [{
        key: "revenueGrowth", label: "收入增速", base: 7, bear: 3, bull: 11, unit: "%",
        origin: "formula", locked: false, evidenceRefs: [], confidence: 0.5,
      }],
    };

    const merged = mergeUserAssumptions(draft, [{ key: "revenueGrowth", base: 12, bear: 5, bull: 18 }]);

    expect(merged.assumptions?.[0]).toMatchObject({ base: 12, bear: 5, bull: 18, origin: "user", locked: true });
    expect(merged.operating?.revenueGrowth).toEqual({ low: 0.05, base: 0.12, high: 0.18 });
  });

  test("synchronizes manually edited revenue base into operating inputs", () => {
    const draft: QuantitativeDraft = {
      method: "dcf_3_statement",
      archetype: "operating",
      currency: "CNY",
      asOf: "2026-06-21",
      operating: {
        currency: "CNY", asOf: "2026-06-21", baseRevenue: 100, sharesOutstanding: 10, netDebt: 5,
        revenueGrowth: { low: 0.03, base: 0.07, high: 0.11 },
        ebitMargin: { low: 0.08, base: 0.13, high: 0.18 }, taxRate: 0.2, depreciationRate: 0.035,
        capexRate: { low: 0.04, base: 0.06, high: 0.08 }, workingCapitalRate: 0.015,
        discountRate: { low: 0.085, base: 0.1, high: 0.115 },
        terminalGrowthRate: { low: 0.015, base: 0.025, high: 0.035 },
      },
      assumptions: [{
        key: "baseRevenue", label: "营业收入基数", value: 100, base: 100, unit: "亿元",
        origin: "ai", locked: false, evidenceRefs: [], confidence: 0.3,
      }],
    };

    const merged = mergeUserAssumptions(draft, [{ key: "baseRevenue", value: 1800, base: 1800 }]);

    expect(merged.assumptions?.[0]).toMatchObject({ value: 1800, base: 1800, origin: "user", locked: true });
    expect(merged.operating?.baseRevenue).toBe(1800);
  });

  test("persists advanced yearly assumption edits into operating forecast overrides", () => {
    const draft: QuantitativeDraft = {
      method: "dcf_3_statement",
      archetype: "operating",
      currency: "CNY",
      asOf: "2026-06-21",
      operating: {
        currency: "CNY", asOf: "2026-06-21", baseRevenue: 100, sharesOutstanding: 10, netDebt: 5,
        revenueGrowth: { low: 0.03, base: 0.07, high: 0.11 },
        ebitMargin: { low: 0.08, base: 0.13, high: 0.18 }, taxRate: 0.2, depreciationRate: 0.035,
        capexRate: { low: 0.04, base: 0.06, high: 0.08 }, workingCapitalRate: 0.015,
        discountRate: { low: 0.085, base: 0.1, high: 0.115 },
        terminalGrowthRate: { low: 0.015, base: 0.025, high: 0.035 },
      },
      assumptions: [{
        key: "ebitMargin", label: "EBIT率", base: 13, bear: 8, bull: 18, unit: "%",
        origin: "formula", locked: false, evidenceRefs: [], confidence: 0.5,
      }],
    };

    const merged = mergeUserAssumptions(draft, [{ key: "ebitMargin", forecastYear: 2, base: 20 }]);

    expect(merged.assumptions).toContainEqual(expect.objectContaining({
      key: "ebitMargin",
      forecastYear: 2,
      base: 20,
      origin: "user",
      locked: true,
    }));
    expect(merged.operating?.forecastOverrides).toContainEqual({ year: 2, ebitMargin: 0.2 });
  });

  test("maps conservative WACC to the high discount rate and optimistic WACC to the low rate", () => {
    const draft: QuantitativeDraft = {
      method: "dcf_3_statement", archetype: "operating", currency: "CNY", asOf: "2026-06-21",
      assumptions: [{ key: "discountRate", label: "WACC", bear: 11.5, base: 10, bull: 8.5, unit: "%", origin: "formula", locked: false }],
      operating: {
        currency: "CNY", asOf: "2026-06-21", baseRevenue: 100, sharesOutstanding: 10, netDebt: 5,
        revenueGrowth: { low: 0.03, base: 0.07, high: 0.11 }, ebitMargin: { low: 0.08, base: 0.13, high: 0.18 },
        taxRate: 0.2, depreciationRate: 0.035, capexRate: { low: 0.04, base: 0.06, high: 0.08 }, workingCapitalRate: 0.015,
        discountRate: { low: 0.085, base: 0.1, high: 0.115 }, terminalGrowthRate: { low: 0.015, base: 0.025, high: 0.035 },
      },
    };

    const merged = mergeUserAssumptions(draft, [{ key: "discountRate", bear: 12, base: 10, bull: 8 }]);

    expect(merged.operating?.discountRate).toEqual({ low: 0.08, base: 0.1, high: 0.12 });
  });

  test("keeps sanitized user valuation presets in the saved draft", () => {
    const draft: QuantitativeDraft = {
      method: "dcf_3_statement", archetype: "operating", currency: "CNY", asOf: "2026-06-21",
      assumptions: [{ key: "revenueGrowth", label: "收入增速", bear: 3, base: 7, bull: 11, unit: "%", origin: "formula", locked: false }],
      operating: {
        currency: "CNY", asOf: "2026-06-21", baseRevenue: 100, sharesOutstanding: 10, netDebt: 5,
        revenueGrowth: { low: 0.03, base: 0.07, high: 0.11 }, ebitMargin: { low: 0.08, base: 0.13, high: 0.18 },
        taxRate: 0.2, depreciationRate: 0.035, capexRate: { low: 0.04, base: 0.06, high: 0.08 }, workingCapitalRate: 0.015,
        discountRate: { low: 0.085, base: 0.1, high: 0.115 }, terminalGrowthRate: { low: 0.015, base: 0.025, high: 0.035 },
      },
    };

    const merged = mergeUserAssumptions(draft, [], {
      presets: [{
        id: "preset-1",
        name: "  压力测试  ",
        createdAt: "2026-06-26T00:00:00.000Z",
        assumptions: [{ key: "revenueGrowth", label: "收入增速", bear: 0, base: 2, bull: 5, unit: "%", origin: "user", locked: true }],
      }],
    });

    expect(merged.presets).toEqual([{
      id: "preset-1",
      name: "压力测试",
      createdAt: "2026-06-26T00:00:00.000Z",
      assumptions: [{ key: "revenueGrowth", label: "收入增速", bear: 0, base: 2, bull: 5, unit: "%", origin: "user", locked: true }],
    }]);
  });
});
