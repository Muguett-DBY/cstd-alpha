import { describe, expect, test } from "vitest";
import { buildRankingEntries, companyCandidateFromRanking, A_SHARE_RANKING_SEEDS } from "./ranking";
import { validateReportPayload } from "./report";

describe("ranking entries", () => {
  test("ships exactly 100 A-share seed companies", () => {
    expect(A_SHARE_RANKING_SEEDS).toHaveLength(100);
    expect(new Set(A_SHARE_RANKING_SEEDS.map((seed) => `${seed.listingPlace}:${seed.code}`)).size).toBe(100);
  });

  test("keeps seed companies as unscored watchlist rows", () => {
    const entries = buildRankingEntries();

    expect(entries).toHaveLength(100);
    expect(entries[0]).toMatchObject({ code: "600519", source: "seed", cqs: 0, ias: 0, conclusion: "待导入" });
  });

  test("can build a market ranking without A-share seed rows", () => {
    const entries = buildRankingEntries(
      [],
      [
        {
          id: "apple",
          companyName: "Apple",
          ticker: "AAPL",
          market: "美股",
          industry: "Consumer Electronics",
          cqs: 82,
          ias: 76,
          conclusion: "持有",
          qualitativeBand: "优质",
          positionAdvice: "小仓 3-8%",
          valuationView: "合理",
          asOf: "2026-05-14T00:00:00.000Z",
          importedAt: "2026-05-14T00:00:00.000Z",
          evidenceCount: 3,
          scoreItemCount: 20,
        },
      ],
      [],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ code: "AAPL", name: "苹果", source: "deep-report", listingPlace: "美股", sector: "电子 / 消费电子" });
  });

  test("localizes Hong Kong ranking names and industries", () => {
    const entries = buildRankingEntries(
      [],
      [
        {
          id: "hkex",
          companyName: "Hong Kong Exchanges and Clearing Limited",
          ticker: "00388",
          market: "港股",
          industry: "Diversified",
          sector: "Finance",
          cqs: 76,
          ias: 74,
          conclusion: "持有",
          qualitativeBand: "优质",
          positionAdvice: "小仓 3-8%",
          valuationView: "合理",
          asOf: "2026-05-14T00:00:00.000Z",
          importedAt: "2026-05-14T00:00:00.000Z",
          evidenceCount: 3,
          scoreItemCount: 20,
        },
      ],
      [],
    );

    expect(entries[0]).toMatchObject({ code: "00388", name: "香港交易所", sector: "非银金融 / 证券", industryGroup: "非银金融" });
  });

  test("keeps unknown overseas names while normalizing broad industry labels", () => {
    const entries = buildRankingEntries(
      [],
      [
        {
          id: "unknown-us",
          companyName: "Example Software Inc.",
          ticker: "EXSW",
          market: "美股",
          industry: "Technology",
          cqs: 61,
          ias: 59,
          conclusion: "观察",
          qualitativeBand: "中规中矩",
          positionAdvice: "观察仓",
          valuationView: "合理",
          asOf: "2026-05-14T00:00:00.000Z",
          importedAt: "2026-05-14T00:00:00.000Z",
          evidenceCount: 3,
          scoreItemCount: 20,
        },
      ],
      [],
    );

    expect(entries[0]).toMatchObject({ code: "EXSW", name: "Example Software Inc.", sector: "计算机", industryGroup: "计算机" });
  });

  test("deduplicates overseas share classes for the same company", () => {
    const entries = buildRankingEntries(
      [],
      [
        {
          id: "alphabet-class-a",
          companyName: "Alphabet Inc.",
          ticker: "GOOGL",
          market: "美股",
          cqs: 79.6,
          ias: 78.15,
          conclusion: "观察",
          qualitativeBand: "优质",
          positionAdvice: "观察仓",
          valuationView: "合理",
          asOf: "2026-05-14T00:00:00.000Z",
          importedAt: "2026-05-14T00:00:00.000Z",
          evidenceCount: 3,
          scoreItemCount: 20,
        },
        {
          id: "alphabet-class-c",
          companyName: "Alphabet Inc.",
          ticker: "GOOG",
          market: "美股",
          cqs: 81.14,
          ias: 79.2,
          conclusion: "观察",
          qualitativeBand: "优质",
          positionAdvice: "观察仓",
          valuationView: "合理",
          asOf: "2026-05-14T00:00:00.000Z",
          importedAt: "2026-05-14T00:00:00.000Z",
          evidenceCount: 3,
          scoreItemCount: 20,
        },
      ],
      [],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ code: "GOOG", name: "谷歌", ias: 79.2 });
  });

  test("overrides a seed row with an imported deep report", () => {
    const report = validateReportPayload({
      company: { name: "德才股份", ticker: "605287", market: "沪A", industry: "建筑装饰" },
      conclusion: "回避",
      oneSentence: "高风险。",
      evidence: [
        { title: "财报", source: "公开财报", url: "https://example.com", retrievedAt: "2026-05-13T00:00:00.000Z", freshness: "latest-public", notes: "ok" },
        { title: "行情", source: "公开行情", url: "https://example.com/quote", retrievedAt: "2026-05-13T00:00:00.000Z", freshness: "latest-public", notes: "ok" },
      ],
      cqs: 28,
      ias: 24,
      summaryDashboard: { valuationView: "偏高", positionAdvice: "0%", investmentHorizon: "回避", keyReasons: [], keyRisks: [], trackingMetrics: [] },
      sections: { companyOverview: "概况" },
    });

    const entries = buildRankingEntries([report]);
    const decai = entries.find((entry) => entry.code === "605287");

    expect(decai).toMatchObject({ source: "deep-report", hasReport: true, conclusion: "回避", ias: 24 });
    expect(companyCandidateFromRanking(decai!).code).toBe("605287");
  });

  test("matches seed rows to report library rows by A-share stock code across market aliases", () => {
    const entries = buildRankingEntries([], [
      {
        id: "kweichow-moutai",
        companyName: "贵州茅台",
        ticker: "600519",
        market: "SH-A",
        industry: "白酒Ⅱ",
        cqs: 80,
        ias: 81,
        conclusion: "观察",
        qualitativeBand: "优质",
        positionAdvice: "观察仓",
        valuationView: "合理",
        asOf: "2026-05-14T00:00:00.000Z",
        importedAt: "2026-05-14T00:00:00.000Z",
        evidenceCount: 3,
        scoreItemCount: 20,
      },
    ]);

    const moutaiRows = entries.filter((entry) => entry.code === "600519");
    expect(moutaiRows).toHaveLength(1);
    expect(moutaiRows[0]).toMatchObject({ source: "deep-report", listingPlace: "沪A", ias: 81 });
  });

  test("does not show market type as the ranking industry", () => {
    const report = validateReportPayload({
      company: { name: "测试公司", ticker: "123456", market: "SH-A", sector: "AStock" },
      conclusion: "观察",
      oneSentence: "测试报告。",
      evidence: [
        { title: "财报", source: "公开财报", url: "https://example.com", retrievedAt: "2026-05-13T00:00:00.000Z", freshness: "latest-public", notes: "ok" },
        { title: "行情", source: "公开行情", url: "https://example.com/quote", retrievedAt: "2026-05-13T00:00:00.000Z", freshness: "latest-public", notes: "ok" },
      ],
      cqs: 65,
      ias: 66,
      summaryDashboard: { valuationView: "合理", positionAdvice: "观察仓", investmentHorizon: "中长期", keyReasons: [], keyRisks: [], trackingMetrics: [] },
      sections: { companyOverview: "概况" },
    });

    const entries = buildRankingEntries([report]);
    const entry = entries.find((item) => item.code === "123456");

    expect(entry?.sector).toBe("未分类");
    expect(entry?.industryGroup).toBe("未分类");
  });

  test("normalizes provider industry levels for display", () => {
    const entries = buildRankingEntries([], [
      {
        id: "bank",
        companyName: "测试银行",
        ticker: "600000",
        market: "SH-A",
        industry: "银行Ⅱ",
        cqs: 60,
        ias: 61,
        conclusion: "观察",
        qualitativeBand: "中规中矩",
        positionAdvice: "观察仓",
        valuationView: "合理",
        asOf: "2026-05-14T00:00:00.000Z",
        importedAt: "2026-05-14T00:00:00.000Z",
        evidenceCount: 3,
        scoreItemCount: 20,
      },
      {
        id: "unknown",
        companyName: "未知行业",
        ticker: "300000",
        market: "SZ-A",
        industry: "-",
        cqs: 55,
        ias: 56,
        conclusion: "观察",
        qualitativeBand: "中规中矩",
        positionAdvice: "观察仓",
        valuationView: "合理",
        asOf: "2026-05-14T00:00:00.000Z",
        importedAt: "2026-05-14T00:00:00.000Z",
        evidenceCount: 3,
        scoreItemCount: 20,
      },
    ]);

    expect(entries.find((entry) => entry.name === "测试银行")?.sector).toBe("银行");
    expect(entries.find((entry) => entry.name === "测试银行")?.industryGroup).toBe("银行");
    expect(entries.find((entry) => entry.name === "未知行业")?.sector).toBe("未分类");
    expect(entries.find((entry) => entry.name === "未知行业")?.industryGroup).toBe("未分类");
  });

  test("uses first-level industry groups for filtering while keeping detailed labels", () => {
    const entries = buildRankingEntries([], [
      {
        id: "baijiu",
        companyName: "测试白酒",
        ticker: "600519",
        market: "SH-A",
        industry: "白酒Ⅱ",
        cqs: 88,
        ias: 87,
        conclusion: "持有",
        qualitativeBand: "优质",
        positionAdvice: "小仓 3-8%",
        valuationView: "合理",
        asOf: "2026-05-14T00:00:00.000Z",
        importedAt: "2026-05-14T00:00:00.000Z",
        evidenceCount: 3,
        scoreItemCount: 20,
      },
    ]);

    const entry = entries.find((item) => item.name === "测试白酒");
    expect(entry?.industryGroup).toBe("食品饮料");
    expect(entry?.sector).toBe("食品饮料 / 白酒");
  });
});
