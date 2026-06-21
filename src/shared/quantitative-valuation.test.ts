import { describe, expect, test } from "vitest";
import {
  calculateActualReview,
  calculateOperatingValuation,
  validateQuantitativeDraft,
  withUserOverride,
  type EditableAssumption,
  type QuantitativeDraft,
} from "./quantitative-valuation";

function triple(low: number, base: number, high: number) {
  return { low, base, high };
}

function operatingFixture(overrides: Partial<Parameters<typeof calculateOperatingValuation>[0]> = {}) {
  return {
    currency: "CNY",
    asOf: "2026-06-22",
    baseRevenue: 1_000,
    sharesOutstanding: 100,
    netDebt: 100,
    revenueGrowth: triple(0.03, 0.07, 0.11),
    ebitMargin: triple(0.1, 0.15, 0.2),
    taxRate: 0.2,
    depreciationRate: 0.03,
    capexRate: triple(0.04, 0.06, 0.08),
    workingCapitalRate: 0.01,
    discountRate: triple(0.085, 0.1, 0.115),
    terminalGrowthRate: triple(0.015, 0.025, 0.035),
    ...overrides,
  };
}

function draftFixture(overrides: Partial<QuantitativeDraft> = {}): QuantitativeDraft {
  return {
    method: "dcf_3_statement",
    archetype: "operating",
    currency: "CNY",
    asOf: "2026-06-22",
    scenarios: {
      base: {
        discountRate: 0.1,
        costOfEquity: 0.11,
        terminalGrowthRate: 0.03,
      },
    },
    ...overrides,
  };
}

describe("quantitative valuation shared contract", () => {
  test("user overrides lock an auto-filled value", () => {
    const autoFilled: EditableAssumption<number> = {
      key: "discountRate",
      label: "WACC",
      value: 0.1,
      origin: "ai",
      locked: false,
    };

    expect(withUserOverride(autoFilled, 0.092)).toEqual({
      key: "discountRate",
      label: "WACC",
      value: 0.092,
      origin: "user",
      locked: true,
    });
  });

  test("terminal growth at or above WACC is rejected", () => {
    const draft = draftFixture({
      scenarios: {
        base: {
          discountRate: 0.03,
          terminalGrowthRate: 0.03,
        },
      },
    });

    expect(() => validateQuantitativeDraft(draft)).toThrow("WACC 必须高于永续增长率。");
  });

  test("operating valuation calculates exactly five forecast rows and finite positive base per-share value", () => {
    const result = calculateOperatingValuation(operatingFixture());
    const base = result.scenarios.find((scenario) => scenario.scenario === "base");

    expect(result.forecastRows).toHaveLength(5);
    expect(base?.perShareValue).toBeGreaterThan(0);
    expect(Number.isFinite(base?.perShareValue)).toBe(true);
  });

  test("calculateActualReview returns correct absolute and percentage errors", () => {
    expect(calculateActualReview([
      { metricKey: "revenue", forecastYear: 2026, forecastValue: 100, actualValue: 112 },
      { metricKey: "fcf", forecastYear: 2026, forecastValue: 0, actualValue: 5 },
    ])).toEqual([
      {
        metricKey: "revenue",
        forecastYear: 2026,
        forecastValue: 100,
        actualValue: 112,
        absoluteError: 12,
        percentageError: 0.12,
      },
      {
        metricKey: "fcf",
        forecastYear: 2026,
        forecastValue: 0,
        actualValue: 5,
        absoluteError: 5,
        percentageError: undefined,
      },
    ]);
  });
});
