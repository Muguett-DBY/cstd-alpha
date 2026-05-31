import { describe, expect, test, vi } from "vitest";
import { applyEvidenceCoverageCaps, evidenceCoverageSummary, normalizeGeneratedRanking, rankingCacheReusable, requestWatchlistRankingScore, sanitizeRankingNarrative } from "./watchlist-ranking";
import type { EvidenceBundle } from "./providers";
import type { WatchlistRow } from "./user-research-db";

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
    expect(ranking.overallScore).toBe(62.6);
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
    expect(ranking.investmentAttractivenessScore).toBe(62);
    expect(ranking.overallScore).toBe(76.3);
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

    expect(ranking.companyQualityScore).toBe(80);
    expect(ranking.investmentAttractivenessScore).toBe(62);
    expect(ranking.overallScore).toBe(71.9);
  });

  test("caps extremely expensive stocks below ordinary high valuation names", () => {
    const ranking = normalizeGeneratedRanking({
      companyQualityScore: 90,
      investmentAttractivenessScore: 75,
      overallScore: 83,
      verdict: "优秀但极贵",
      summary: "公司财务质量优秀，但当前PE约102倍，PB约16.7倍，估值极高，安全边际不足。",
      keyPoints: ["经营现金流强劲", "资产负债率低"],
      riskFlags: ["PE约102倍", "估值极高"],
    });

    expect(ranking.companyQualityScore).toBe(90);
    expect(ranking.investmentAttractivenessScore).toBe(45);
    expect(ranking.overallScore).toBe(65);
  });

  test("does not turn missing numeric fields into zero scores", () => {
    const ranking = normalizeGeneratedRanking({
      verdict: "观察",
      summary: "模型返回缺少数值字段，需要保守复核。",
      keyPoints: [],
      riskFlags: [],
    });

    expect(ranking.companyQualityScore).toBe(50);
    expect(ranking.investmentAttractivenessScore).toBe(40);
    expect(ranking.overallScore).toBe(45.5);
  });

  test("parses nested score objects and short score field names", () => {
    const ranking = normalizeGeneratedRanking({
      scores: {
        quality: 81,
        attractiveness: 67,
        overall: 75,
      },
      result: {
        verdict: "观察",
        summary: "业务质量较高，估值一般。",
        keyPoints: ["现金流健康"],
        riskFlags: ["缺少前瞻指引"],
      },
    });

    expect(ranking.companyQualityScore).toBe(81);
    expect(ranking.investmentAttractivenessScore).toBe(67);
    expect(ranking.overallScore).toBe(74.7);
    expect(ranking.summary).toBe("业务质量较高，估值一般。");
  });

  test("keeps strong financial quality separate from high valuation risk", () => {
    const ranking = normalizeGeneratedRanking({
      companyQualityScore: 60,
      investmentAttractivenessScore: 45,
      overallScore: 53.3,
      verdict: "优秀但偏贵",
      summary: "财务数据极为强劲，自由现金流极高，资产负债率低，但当前估值偏高，安全边际有限。",
      keyPoints: ["自由现金流极高", "资产负债率低"],
      riskFlags: ["PE较高，安全边际有限"],
    });

    expect(ranking.companyQualityScore).toBe(78);
    expect(ranking.investmentAttractivenessScore).toBe(55);
    expect(ranking.overallScore).toBe(67.7);
  });

  test("recalculates inconsistent low overall scores from final component scores", () => {
    const ranking = normalizeGeneratedRanking({
      companyQualityScore: 78,
      investmentAttractivenessScore: 65,
      overallScore: 49,
      verdict: "周期行业，观察",
      summary: "财务数据强劲，负债率下降，但行业波动较大。",
      keyPoints: ["经营现金流强劲"],
      riskFlags: ["周期波动"],
    });

    expect(ranking.overallScore).toBe(72.2);
  });

  test("caps severe loss and operating cash flow turning negative", () => {
    const ranking = normalizeGeneratedRanking({
      companyQualityScore: 78,
      investmentAttractivenessScore: 50,
      overallScore: 60,
      verdict: "质量极差，价值陷阱",
      summary: "公司连续巨额亏损，经营现金流转负，建议回避。",
      keyPoints: [],
      riskFlags: ["巨额亏损", "经营现金流转负"],
    });

    expect(ranking.companyQualityScore).toBe(60);
    expect(ranking.investmentAttractivenessScore).toBe(45);
    expect(ranking.overallScore).toBe(49);
  });

  test("caps unprofitable growth companies even when balance sheet is acceptable", () => {
    const ranking = normalizeGeneratedRanking({
      companyQualityScore: 78,
      investmentAttractivenessScore: 55,
      overallScore: 67.7,
      verdict: "概念成长股",
      summary: "公司收入增长但尚未盈利，当前亏损7亿，估值已反映高增长预期。",
      keyPoints: ["资产负债率稳健"],
      riskFlags: ["尚未盈利", "亏损7亿"],
    });

    expect(ranking.companyQualityScore).toBe(60);
    expect(ranking.investmentAttractivenessScore).toBe(45);
    expect(ranking.overallScore).toBe(49);
  });

  test("removes model self-reported score text from ranking narratives", () => {
    expect(sanitizeRankingNarrative("基本面强劲。综合评定公司质量82分，投资吸引力70分，整体评分77。估值需要复核。")).toBe("基本面强劲。估值需要复核。");
    expect(sanitizeRankingNarrative("质量优秀但缺乏催化剂，估值合理。")).toBe("质量优秀但缺乏催化剂，估值合理。");
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
    expect(capped.companyQualityScore).toBe(72);
    expect(capped.investmentAttractivenessScore).toBe(55);
    expect(capped.overallScore).toBe(64.4);
  });

  test("falls through to the next route when an upstream response is not JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    companyQualityScore: 82,
                    investmentAttractivenessScore: 58,
                    overallScore: 72,
                    verdict: "观察",
                    summary: "财务质量较好，但估值吸引力一般。",
                    keyPoints: ["E1 财报可用"],
                    riskFlags: ["估值偏高"],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const watchlist: WatchlistRow = {
        id: "watch-1",
        user_key: "admin",
        company_name: "样本公司",
        ticker: "000001",
        market: "深A",
        exchange_name: "深圳证券交易所",
        listing_place: "深A",
        market_type: "AStock",
        source: "eastmoney",
        report_library_id: null,
        added_at: "2026-05-25T00:00:00.000Z",
      };
      const evidence: EvidenceBundle = {
        retrievedAt: "2026-05-25T00:00:00.000Z",
        company: { name: "样本公司", ticker: "000001", market: "深A" },
        facts: {},
        evidence: [
          {
            title: "000001 Eastmoney financial statements",
            source: "Eastmoney public financial statement endpoints",
            freshness: "latest-public",
            notes: "Normalized named financial metrics from Eastmoney statements.",
          },
        ],
      };

      const ranking = await requestWatchlistRankingScore({ OPENCODE_GO_API_KEY: "go-key" }, watchlist, evidence);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(ranking.companyQualityScore).toBeGreaterThan(0);
      expect(ranking.modelUsed).toBe("deepseek-v4-flash-free");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
