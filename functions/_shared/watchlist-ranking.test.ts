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
});
