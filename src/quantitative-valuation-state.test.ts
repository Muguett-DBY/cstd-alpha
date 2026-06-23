import { describe, expect, test } from "vitest";
import { applyDraftEdit, draftWarnings, findAssumption, userLockedAssumptions } from "./quantitative-valuation-state";
import type { QuantitativeDraft } from "./shared/quantitative-valuation";

describe("quantitative valuation editor state", () => {
  test("parses percentage input and creates a user lock", () => {
    const next = applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" });

    expect(findAssumption(next, "revenueGrowth")).toMatchObject({ base: 12.5, origin: "user", locked: true });
    expect(next.operating?.revenueGrowth.base).toBe(0.125);
  });

  test("returns an error when terminal growth is not below WACC", () => {
    const next = applyDraftEdit(baseDraft(), { key: "terminalGrowthRate", scenario: "base", rawValue: "10" });

    expect(draftWarnings(next)).toContainEqual(expect.objectContaining({ level: "error", message: "WACC 必须高于永续增长率。" }));
  });

  test("stores an advanced yearly override and applies it to calculation input", () => {
    const next = applyDraftEdit(baseDraft(), { key: "ebitMargin", scenario: "base", forecastYear: 2, rawValue: "20" });

    expect(findAssumption(next, "ebitMargin", 2)).toMatchObject({ base: 20, forecastYear: 2, origin: "user", locked: true });
    expect(next.operating?.forecastOverrides).toContainEqual(expect.objectContaining({ year: 2, ebitMargin: 0.2 }));
  });

  test("sends only assumptions explicitly edited by the user", () => {
    const next = applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" });

    expect(userLockedAssumptions(next).map((item) => item.key)).toEqual(["revenueGrowth"]);
  });

  test("edits revenue base as a direct operating amount", () => {
    const next = applyDraftEdit(baseDraft(), { key: "baseRevenue", scenario: "base", rawValue: "1800" });

    expect(findAssumption(next, "baseRevenue")).toMatchObject({ base: 1800, origin: "user", locked: true });
    expect(next.operating?.baseRevenue).toBe(1800);
  });
});

function baseDraft(): QuantitativeDraft {
  return {
    method: "dcf_3_statement",
    archetype: "operating",
    currency: "CNY",
    asOf: "2026-06-21",
    scenarios: {
      bear: { discountRate: 0.115, terminalGrowthRate: 0.015 },
      base: { discountRate: 0.1, terminalGrowthRate: 0.025 },
      bull: { discountRate: 0.085, terminalGrowthRate: 0.035 },
    },
    assumptions: [
      { key: "revenueGrowth", label: "收入增速", bear: 3, base: 7, bull: 11, unit: "%", origin: "formula", locked: false },
      { key: "baseRevenue", label: "营业收入基数", value: 100, base: 100, unit: "亿元", origin: "formula", locked: false },
      { key: "ebitMargin", label: "EBIT 利润率", bear: 8, base: 13, bull: 18, unit: "%", origin: "formula", locked: false },
      { key: "discountRate", label: "WACC", bear: 11.5, base: 10, bull: 8.5, unit: "%", origin: "formula", locked: false },
      { key: "terminalGrowthRate", label: "永续增长率", bear: 1.5, base: 2.5, bull: 3.5, unit: "%", origin: "formula", locked: false },
    ],
    operating: {
      currency: "CNY", asOf: "2026-06-21", baseRevenue: 100, sharesOutstanding: 10, netDebt: 5,
      revenueGrowth: { low: 0.03, base: 0.07, high: 0.11 },
      ebitMargin: { low: 0.08, base: 0.13, high: 0.18 }, taxRate: 0.2, depreciationRate: 0.035,
      capexRate: { low: 0.04, base: 0.06, high: 0.08 }, workingCapitalRate: 0.015,
      discountRate: { low: 0.085, base: 0.1, high: 0.115 },
      terminalGrowthRate: { low: 0.015, base: 0.025, high: 0.035 },
    },
  };
}
