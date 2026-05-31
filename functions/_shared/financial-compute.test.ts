import { describe, expect, test } from "vitest";
import { executeFinancialCompute } from "./financial-compute";

describe("financial compute", () => {
  test("uses a 10 percent DCF discount rate by default", () => {
    const result = executeFinancialCompute({
      operation: "dcf",
      params: {
        cashFlows: [100, 100, 100],
        terminalCashFlow: 100,
      },
    });

    expect(result.summary).toContain("企业价值 1000");
    expect(result.summary).not.toContain("Infinity");
  });

  test("accepts percentage and decimal ratio DCF inputs consistently", () => {
    const percentage = executeFinancialCompute({
      operation: "dcf",
      params: {
        cashFlows: [100, 110, 120],
        terminalCashFlow: 120,
        discountRate: 10,
        terminalGrowthRate: 2,
      },
    });
    const ratio = executeFinancialCompute({
      operation: "dcf",
      params: {
        cashFlows: [100, 110, 120],
        terminalCashFlow: 120,
        discountRate: 0.1,
        terminalGrowthRate: 0.02,
      },
    });

    expect(ratio.summary).toBe(percentage.summary);
  });

  test("rejects DCF terminal growth that is not below the discount rate", () => {
    const result = executeFinancialCompute({
      operation: "dcf",
      params: {
        cashFlows: [100, 110, 120],
        terminalCashFlow: 120,
        discountRate: 5,
        terminalGrowthRate: 5,
      },
    });

    expect(result.summary).toContain("贴现率必须高于永续增长率");
    expect(result.rows).toEqual([]);
  });

  test("rejects CAGR calculations with a zero starting value", () => {
    const result = executeFinancialCompute({
      operation: "cagr",
      params: { values: [0, 100] },
    });

    expect(result.summary).toContain("起始值必须大于 0");
  });
});
