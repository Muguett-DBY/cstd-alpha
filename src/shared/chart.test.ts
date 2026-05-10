import { describe, expect, test } from "vitest";
import { buildDrawdownSeries, extractFinancialChartSeries, extractModuleScoreSeries, normalizeChartBundle } from "./chart";
import { MODULE_WEIGHTS, validateReportPayload } from "./report";

describe("chart helpers", () => {
  test("calculates drawdown from historical peak", () => {
    const result = buildDrawdownSeries([
      { date: "2024-01-01", close: 10, adjustedClose: 10, volume: 100 },
      { date: "2024-01-02", close: 8, adjustedClose: 8, volume: 120 },
      { date: "2024-01-03", close: 12, adjustedClose: 12, volume: 130 },
      { date: "2024-01-04", close: 9, adjustedClose: 9, volume: 140 },
    ]);

    expect(result.map((point) => point.drawdown)).toEqual([0, -20, 0, -25]);
    expect(result.at(-1)).toMatchObject({ date: "2024-01-04", peak: 12, price: 9 });
  });

  test("empty price series normalizes without crashing", () => {
    const result = normalizeChartBundle({
      company: { name: "No Data Co." },
      asOf: "2026-05-10T00:00:00.000Z",
      priceMode: "adjusted",
      priceSeries: [],
      drawdownSeries: [],
      marketSnapshot: {},
      evidence: [],
    });

    expect(result.priceSeries).toEqual([]);
    expect(result.drawdownSeries).toEqual([]);
    expect(result.marketSnapshot.maxDrawdown).toBeUndefined();
  });

  test("extracts financial chart series from report ten-year table", () => {
    const report = validateReportPayload({
      company: { name: "Example" },
      evidence: [],
      redFlags: [],
      financialTenYear: {
        rows: [
          { metric: "营业收入", values: { "2024": "100", "2025": "120" }, trend: "上升" },
          { metric: "归母净利润", values: { "2024": "-5", "2025": "8" }, trend: "改善" },
          { metric: "经营活动现金流量净额", values: { "2024": "12", "2025": "18" }, trend: "上升" },
          { metric: "资产负债率", values: { "2024": "72%", "2025": "68%" }, trend: "下降" },
        ],
      },
    });

    const series = extractFinancialChartSeries(report);

    expect(series.map((item) => item.label)).toEqual(["营业收入", "净利润", "经营现金流", "资产负债率"]);
    expect(series[0].points).toEqual([
      { label: "2024", value: 100 },
      { label: "2025", value: 120 },
    ]);
  });

  test("extracts ten module scores for visualization", () => {
    const report = validateReportPayload({
      company: { name: "Example" },
      evidence: [],
      redFlags: [],
      moduleScores: MODULE_WEIGHTS.map((module, index) => ({
        ...module,
        score: 10 + index,
        weightedScore: 1,
        label: "差",
        summary: "summary",
        evidence: [],
        concerns: [],
      })),
    });

    expect(extractModuleScoreSeries(report)).toHaveLength(10);
    expect(extractModuleScoreSeries(report)[0]).toMatchObject({ label: MODULE_WEIGHTS[0].name, value: 10 });
  });
});
