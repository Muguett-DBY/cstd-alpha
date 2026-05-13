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
});
