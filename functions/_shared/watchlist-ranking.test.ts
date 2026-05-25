import { describe, expect, test } from "vitest";
import { normalizeGeneratedRanking, rankingCacheReusable } from "./watchlist-ranking";

describe("watchlist ranking score helpers", () => {
  test("normalizes independent model scores and derives overall score when omitted", () => {
    const ranking = normalizeGeneratedRanking({
      companyQualityScore: 82.26,
      investmentAttractivenessScore: 61.24,
      verdict: "观察",
      summary: "质量较好但估值吸引力一般。",
      keyPoints: ["E1 财务质量较好"],
      riskFlags: ["估值偏贵"],
    });

    expect(ranking.companyQualityScore).toBe(82.3);
    expect(ranking.investmentAttractivenessScore).toBe(61.2);
    expect(ranking.overallScore).toBe(72.8);
    expect(ranking.keyPoints).toEqual(["E1 财务质量较好"]);
  });

  test("requires completed score and matching evidence hash for cache reuse", () => {
    expect(rankingCacheReusable({ status: "completed", evidence_hash: "hash-a" }, "hash-a", false)).toBe(true);
    expect(rankingCacheReusable({ status: "completed", evidence_hash: "hash-a" }, "hash-b", false)).toBe(false);
    expect(rankingCacheReusable({ status: "running", evidence_hash: "hash-a" }, "hash-a", false)).toBe(false);
    expect(rankingCacheReusable({ status: "completed", evidence_hash: "hash-a" }, "hash-a", true)).toBe(false);
  });

  test("normalizes Chinese model field names instead of writing zero scores", () => {
    const ranking = normalizeGeneratedRanking({
      公司质量分: "66",
      投资吸引力分: 58.4,
      综合评分: 62,
      结论: "周期资源，观察",
      摘要: "盈利弹性来自铝价，但周期性和估值风险需要复核。",
      主要得分点: ["E1 财报利润改善", "E2 行情估值可用"],
      风险点: ["商品价格波动"],
    });

    expect(ranking.companyQualityScore).toBe(66);
    expect(ranking.investmentAttractivenessScore).toBe(58.4);
    expect(ranking.overallScore).toBe(62);
    expect(ranking.verdict).toBe("周期资源，观察");
    expect(ranking.keyPoints).toHaveLength(2);
  });
});
