import { afterEach, describe, expect, test, vi } from "vitest";
import { canPersistImportedRankingReports, clearImportedRankingReports, loadImportedRankingReports, parseRankingReportJson, saveImportedRankingReports, upsertImportedRankingReports } from "./ranking-storage";
import { SCORE_ITEMS_20, validateReportPayload } from "./shared/report";

describe("ranking report storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("parses a single pasted report", () => {
    const report = sampleReport("贵州茅台", "600519", 88);

    expect(parseRankingReportJson(JSON.stringify(report))[0].company.name).toBe("贵州茅台");
  });

  test("parses report arrays wrapped in reports", () => {
    const reports = parseRankingReportJson(JSON.stringify({ reports: [sampleReport("美的集团", "000333", 80)] }));

    expect(reports).toHaveLength(1);
    expect(reports[0].company.ticker).toBe("000333");
  });

  test("rejects shallow imports without item-level scores", () => {
    expect(() =>
      parseRankingReportJson(
        JSON.stringify({
          company: { name: "浅报告", ticker: "000001", market: "深A" },
          cqs: 70,
          ias: 70,
          evidence: [],
          sections: { companyOverview: "概况" },
        }),
      ),
    ).toThrow("完整 20 项评分");
  });

  test("upserts imported reports by company identity", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const first = sampleReport("德才股份", "605287", 28);
    const second = sampleReport("德才股份", "605287", 34);

    upsertImportedRankingReports([first], "2026-05-13T00:00:00.000Z");
    upsertImportedRankingReports([second], "2026-05-13T01:00:00.000Z");

    const loaded = loadImportedRankingReports();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].report.ias).toBe(34);
    expect(loaded[0].importedAt).toBe("2026-05-13T01:00:00.000Z");
  });

  test("does not throw when imported ranking cache cannot be written or cleared", () => {
    vi.stubGlobal("localStorage", throwingStorage());

    expect(saveImportedRankingReports([])).toBe(false);
    expect(() => clearImportedRankingReports()).not.toThrow();
  });

  test("reports imported ranking cache as unavailable when the browser storage getter is blocked", () => {
    const blockedWindow = {};
    Object.defineProperty(blockedWindow, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("localStorage disabled", "SecurityError");
      },
    });

    expect(canPersistImportedRankingReports(blockedWindow as Window)).toBe(false);
  });
});

function sampleReport(name: string, ticker: string, ias: number) {
  return validateReportPayload({
    company: { name, ticker, market: ticker.startsWith("6") ? "沪A" : "深A" },
    conclusion: ias < 40 ? "回避" : "观察",
    oneSentence: "测试报告。",
    cqs: ias,
    ias,
    scoreItems20: SCORE_ITEMS_20.map((item) => ({
      ...item,
      score: ias,
      label: ias >= 70 ? "好" : ias >= 50 ? "一般" : "差",
      evidence: ["公开证据"],
      deductions: ["测试扣分点"],
      recentChange: "无明显变化；对分数影响：0",
      reason: "测试评分理由。",
    })),
    evidence: [
      { title: "财报", source: "公开财报", url: "https://example.com", retrievedAt: "2026-05-13T00:00:00.000Z", freshness: "latest-public", notes: "ok" },
      { title: "行情", source: "公开行情", url: "https://example.com/quote", retrievedAt: "2026-05-13T00:00:00.000Z", freshness: "latest-public", notes: "ok" },
    ],
    sections: { companyOverview: "概况" },
  });
}

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

function throwingStorage(): Storage {
  return {
    get length() {
      return 0;
    },
    clear: () => undefined,
    getItem: () => null,
    key: () => null,
    removeItem: () => {
      throw new DOMException("Blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    },
  };
}
