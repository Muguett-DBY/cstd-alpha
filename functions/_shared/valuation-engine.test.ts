import { describe, expect, test } from "vitest";
import { computeCyclicalMidCycle, computeFinancialDdm, computeOperatingDcf, routeValuationMethod } from "./valuation-engine";

describe("valuation engine", () => {
  test("routes banks and insurers to DDM/residual income, cyclicals to mid-cycle NAV, others to DCF", () => {
    expect(routeValuationMethod({ industry: "银行" })).toEqual({ archetype: "bank", method: "ddm_residual_income" });
    expect(routeValuationMethod({ industry: "保险" })).toEqual({ archetype: "insurance", method: "ddm_residual_income" });
    expect(routeValuationMethod({ industry: "煤炭资源" })).toEqual({ archetype: "cyclical", method: "mid_cycle_nav" });
    expect(routeValuationMethod({ industry: "半导体设备" })).toEqual({ archetype: "operating", method: "dcf_3_statement" });
  });

  test("computes a full operating-company DCF with forecast rows and sensitivity", () => {
    const result = computeOperatingDcf({
      currency: "CNY",
      asOf: "2026-06-05",
      baseRevenue: 1000,
      sharesOutstanding: 100,
      netDebt: 120,
      revenueGrowth: { low: 0.04, base: 0.08, high: 0.12 },
      ebitMargin: { low: 0.14, base: 0.18, high: 0.22 },
      taxRate: 0.2,
      depreciationRate: 0.04,
      capexRate: { low: 0.05, base: 0.07, high: 0.09 },
      workingCapitalRate: 0.02,
      discountRate: { low: 0.085, base: 0.1, high: 0.115 },
      terminalGrowthRate: { low: 0.02, base: 0.025, high: 0.03 },
      peerEvEbitda: { low: 10, base: 14, high: 18 },
    });

    expect(result.method).toBe("dcf_3_statement");
    expect(result.forecastRows).toHaveLength(5);
    expect(result.scenarios.map((scenario) => scenario.scenario)).toEqual(["bear", "base", "bull"]);
    expect(result.scenarios[2].perShareValue).toBeGreaterThan(result.scenarios[0].perShareValue);
    expect(result.sensitivity).toHaveLength(9);
    expect(result.peerRange?.metric).toBe("EV/EBITDA");
  });

  test("computes DDM/residual income values for financial companies", () => {
    const result = computeFinancialDdm({
      currency: "CNY",
      asOf: "2026-06-05",
      bookValue: 5000,
      sharesOutstanding: 1000,
      roe: { low: 0.08, base: 0.11, high: 0.14 },
      payoutRatio: { low: 0.25, base: 0.35, high: 0.45 },
      costOfEquity: { low: 0.08, base: 0.095, high: 0.11 },
      terminalGrowthRate: { low: 0.01, base: 0.02, high: 0.03 },
    }, "bank");

    expect(result.method).toBe("ddm_residual_income");
    expect(result.archetype).toBe("bank");
    expect(result.scenarios[1].perShareValue).toBeGreaterThan(0);
  });

  test("computes mid-cycle valuation for cyclical companies", () => {
    const result = computeCyclicalMidCycle({
      currency: "CNY",
      asOf: "2026-06-05",
      midCycleEbitda: { low: 600, base: 900, high: 1200 },
      normalizedNetCash: -100,
      sharesOutstanding: 200,
      replacementAssetValue: { low: 2600, base: 3200, high: 3800 },
      evEbitdaMultiple: { low: 4, base: 6, high: 8 },
    });

    expect(result.method).toBe("mid_cycle_nav");
    expect(result.scenarios[2].perShareValue).toBeGreaterThan(result.scenarios[0].perShareValue);
    expect(result.peerRange?.metric).toBe("Mid-cycle EV/EBITDA");
  });
});
