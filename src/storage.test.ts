import { afterEach, describe, expect, test, vi } from "vitest";
import { buildChartCacheKey, buildReportCacheKey, loadCachedChart, loadCachedReport, loadLastReport, saveCachedChart, saveCachedReport, saveLastReport } from "./storage";
import { emptyReport, validateReportPayload } from "./shared/report";
import type { ChartBundle } from "./shared/chart";

describe("report storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("does not restore legacy DeepSeek empty-response fallback reports", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem("cstd-alpha:last-report", JSON.stringify(emptyReport("贵州茅台", "DeepSeek returned an empty final response. finish_reason=length")));

    expect(loadLastReport()).toBeNull();
  });

  test("restores validated real reports", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const report = validateReportPayload({
      company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "观察",
      oneSentence: "真实报告",
      scoreItems20: [],
      evidence: [],
      sections: { companyOverview: "概况" },
      disclaimer: "仅供研究。",
    });

    saveLastReport(report);

    expect(loadLastReport()?.company).toMatchObject({ name: "贵州茅台", ticker: "600519" });
  });

  test("loads a cached report for the same company within the TTL", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const company = {
      id: "eastmoney:1.600519",
      name: "贵州茅台",
      code: "600519",
      exchange: "上海证券交易所",
      listingPlace: "沪A",
      marketType: "AStock",
      source: "eastmoney" as const,
    };
    const report = validateReportPayload({
      company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "观察",
      oneSentence: "缓存报告",
      scoreItems20: [],
      evidence: [],
      sections: { companyOverview: "概况" },
    });

    saveCachedReport(company, report, 1000);

    expect(buildReportCacheKey(company)).toContain("沪A:600519");
    expect(loadCachedReport(company, 1000 + 60_000)?.report.company.name).toBe("贵州茅台");
    expect(loadCachedReport(company, 1000 + 29 * 24 * 60 * 60 * 1000)?.report.company.name).toBe("贵州茅台");
    expect(loadCachedReport(company, 1000 + 31 * 24 * 60 * 60 * 1000)).toBeNull();
  });

  test("uses a canonical local report cache key across equivalent candidates", () => {
    const base = {
      id: "eastmoney:1.600519",
      name: "贵州茅台",
      code: "600519",
      exchange: "上海证券交易所",
      listingPlace: "沪A",
      marketType: "AStock",
      source: "eastmoney" as const,
    };
    const equivalent = {
      ...base,
      id: "alternate-provider:SH600519",
      name: "贵州茅台股份有限公司",
      exchange: "SSE",
    };

    expect(buildReportCacheKey(base)).toBe(buildReportCacheKey(equivalent));
  });

  test("loads reports from the legacy local cache key after canonical key migration", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const company = {
      id: "eastmoney:1.600519",
      name: "贵州茅台",
      code: "600519",
      exchange: "上海证券交易所",
      listingPlace: "沪A",
      marketType: "AStock",
      source: "eastmoney" as const,
    };
    const report = validateReportPayload({
      company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
      oneSentence: "旧本地缓存报告",
      scoreItems20: [],
      evidence: [],
      sections: { companyOverview: "概况" },
    });
    const legacyKey = "cstd-alpha:report-cache:v5-report-cleanup:eastmoney:1.600519:600519:沪A";
    storage.setItem(
      legacyKey,
      JSON.stringify({
        report,
        cachedAt: 1000,
        expiresAt: 1000 + 30 * 24 * 60 * 60 * 1000,
      }),
    );

    expect(loadCachedReport(company, 2000)?.report.oneSentence).toBe("旧本地缓存报告");
  });

  test("preserves generation metrics with cached reports", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const company = {
      id: "eastmoney:105.MSFT",
      name: "微软",
      code: "MSFT",
      exchange: "美国市场",
      listingPlace: "美股",
      marketType: "UsStock",
      source: "eastmoney" as const,
    };
    const report = validateReportPayload({
      company: { name: "微软", ticker: "MSFT", market: "美股" },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "观察",
      oneSentence: "缓存报告",
      scoreItems20: [],
      evidence: [],
      sections: { companyOverview: "概况" },
    });

    saveCachedReport(company, report, 1000, {
      startedAt: "2026-05-10T00:00:00.000Z",
      completedAt: "2026-05-10T00:05:00.000Z",
      elapsedMs: 300000,
      modelCalls: 9,
      cacheMode: "refresh",
    });

    expect(loadCachedReport(company, 2000)?.metrics).toMatchObject({ elapsedMs: 300000, modelCalls: 9 });
  });

  test("loads cached chart data by company and price mode within the TTL", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const company = {
      id: "eastmoney:1.600519",
      name: "贵州茅台",
      code: "600519",
      exchange: "上海证券交易所",
      listingPlace: "沪A",
      marketType: "AStock",
      source: "eastmoney" as const,
    };
    const chart: ChartBundle = {
      company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
      asOf: "2026-05-10T00:00:00.000Z",
      priceMode: "adjusted",
      priceSeries: [{ date: "2026-05-08", close: 1372.99, adjustedClose: 1372.99, volume: 100 }],
      drawdownSeries: [{ date: "2026-05-08", price: 1372.99, peak: 1372.99, drawdown: 0 }],
      marketSnapshot: { currentPrice: 1372.99 },
      evidence: [],
    };

    saveCachedChart(company, "adjusted", chart, 1000);

    expect(buildChartCacheKey(company, "adjusted")).toContain("adjusted");
    expect(loadCachedChart(company, "adjusted", 2000)?.chart.marketSnapshot.currentPrice).toBe(1372.99);
    expect(loadCachedChart(company, "raw", 2000)).toBeNull();
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
