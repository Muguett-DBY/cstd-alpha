import { describe, expect, test } from "vitest";
import { applyEvidenceCoverageCaps, evidenceCoverageSummary, normalizeGeneratedRanking, rankingCacheReusable } from "./watchlist-ranking";
import type { EvidenceBundle } from "./providers";

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

  test("caps investment attractiveness when the model admits high valuation or limited margin of safety", () => {
    const ranking = normalizeGeneratedRanking({
      companyQualityScore: 88,
      investmentAttractivenessScore: 82,
      overallScore: 85,
      verdict: "高质量龙头",
      summary: "公司增长强劲，但当前估值较高，市场预期已较充分，安全边际有限。",
      keyPoints: ["财务质量强"],
      riskFlags: ["估值较高，安全边际有限"],
    });

    expect(ranking.companyQualityScore).toBe(88);
    expect(ranking.investmentAttractivenessScore).toBe(70);
    expect(ranking.overallScore).toBe(79.9);
  });

  test("caps scores when the generated rationale says the evidence package is incomplete", () => {
    const ranking = normalizeGeneratedRanking({
      companyQualityScore: 90,
      investmentAttractivenessScore: 80,
      overallScore: 86,
      verdict: "优秀公司",
      summary: "证据未包含业务分项数据，无法评估各板块竞争力。",
      keyPoints: ["自由现金流强"],
      riskFlags: ["证据缺乏管理层展望和竞争格局"],
    });

    expect(ranking.companyQualityScore).toBe(82);
    expect(ranking.investmentAttractivenessScore).toBe(72);
    expect(ranking.overallScore).toBe(77.5);
  });

  test("ignores placeholder evidence and caps sparse company packages", () => {
    const evidence = {
      retrievedAt: "2026-05-25T00:00:00.000Z",
      company: { name: "样本公司", ticker: "000001", market: "深A" },
      facts: {},
      evidence: [
        {
          title: "000001 Eastmoney financial statements",
          source: "Eastmoney public financial statement endpoints",
          freshness: "latest-public",
          notes: "Normalized 10 named financial metrics from Eastmoney statements.",
        },
        {
          title: "000001 quote snapshot",
          source: "Eastmoney public quote endpoint",
          freshness: "latest-public",
          notes: "Latest public market price, volume, market cap and valuation snapshot.",
        },
        {
          title: "000001 symbol search",
          source: "Eastmoney public suggest endpoint",
          freshness: "latest-public",
          notes: "Public company identity, exchange, sector and industry match.",
        },
        {
          title: "000001 Stooq quote fallback",
          source: "Stooq public quote CSV endpoint",
          freshness: "latest-public",
          notes: "Stooq quote fallback returned no data.",
        },
      ],
    } satisfies EvidenceBundle;

    const coverage = evidenceCoverageSummary(evidence);
    const capped = applyEvidenceCoverageCaps(
      {
        companyQualityScore: 90,
        investmentAttractivenessScore: 82,
        overallScore: 86,
        verdict: "优秀公司",
        summary: "财务表现强劲。",
        keyPoints: ["E1 财务"],
        riskFlags: [],
      },
      coverage,
    );

    expect(coverage.usableEvidenceCount).toBe(2);
    expect(coverage.ignoredPlaceholderCount).toBe(2);
    expect(capped.companyQualityScore).toBe(78);
    expect(capped.investmentAttractivenessScore).toBe(65);
    expect(capped.overallScore).toBe(72.2);
  });
});
