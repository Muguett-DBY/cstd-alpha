import { describe, expect, test } from "vitest";
import { buildResearchThesisMessages, buildResearchThesisRequest, normalizeResearchThesis } from "./research-thesis";
import { companyPackageToResearchEvidence, industryRowsToResearchEvidence } from "./research-thesis-evidence";

describe("research thesis generation", () => {
  test("builds a max-reasoning request grounded in the supplied evidence", () => {
    const messages = buildResearchThesisMessages({
      item: {
        id: "research-1",
        userKey: "admin",
        entityType: "company",
        entityId: "watchlist-1",
        title: "贵州茅台",
        subtitle: "600519 / SH-A",
        stage: "deepResearch",
        status: "active",
        source: "watchlist",
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z",
      },
      evidence: {
        evidenceHash: "evidence-hash",
        asOf: "2026-06-15T00:00:00.000Z",
        summary: "最新财报显示收入增长放缓，但现金流与品牌定价权仍较强。",
        citations: [
          { id: "E1", title: "2026Q1 财报", sourceType: "financial", summary: "收入同比增长 3%。" },
          { id: "E2", title: "最新行情", sourceType: "quote", summary: "估值处于近五年偏低区间。" },
        ],
      },
    });
    const request = buildResearchThesisRequest(
      { model: "deepseek-v4-flash", apiKey: "go-key", isFree: false, provider: "opencode-go", url: "https://example.com" },
      messages,
      new AbortController().signal,
    );
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning_effort: "max",
      thinking: { type: "enabled" },
      response_format: { type: "json_object" },
      stream: false,
    });
    expect(JSON.stringify(body.messages)).toContain("2026Q1 财报");
    expect(JSON.stringify(body.messages)).toContain("E1");
    expect(JSON.stringify(body.messages)).toContain("反证");
  });

  test("normalizes a complete thesis result", () => {
    expect(
      normalizeResearchThesis({
        thesisMarkdown: "# 主判断\n中性观察。\n\n## 核心逻辑\n现金流仍稳健。[E1]",
        coreCitations: ["E1", "E2", "E1"],
        counterEvidence: ["若核心产品价格继续下滑，则论点失效。"],
      }),
    ).toEqual({
      thesisMarkdown: "# 主判断\n中性观察。\n\n## 核心逻辑\n现金流仍稳健。[E1]",
      coreCitations: ["E1", "E2"],
      counterEvidence: ["若核心产品价格继续下滑，则论点失效。"],
    });
  });
});

describe("research thesis evidence adapters", () => {
  test("preserves company evidence facts and turns source items into stable citations", () => {
    const evidence = companyPackageToResearchEvidence({
      version: 1,
      userId: "admin",
      watchlistId: "watchlist-1",
      companyKey: "A:600519",
      evidenceHash: "full-hash",
      materialHash: "material-hash",
      stableHash: "stable-hash",
      freshHash: "fresh-hash",
      fetchedAt: "2026-06-15T00:00:00.000Z",
      stableFacts: { revenue: "100bn", netIncome: "50bn" },
      freshSignals: { price: 1500 },
      evidence: {
        company: { name: "贵州茅台", ticker: "600519", market: "A股" },
        retrievedAt: "2026-06-15T00:00:00.000Z",
        facts: {},
        evidence: [
          {
            id: "source-1",
            evidenceType: "financial",
            title: "2026Q1 财报",
            source: "东方财富财务报表",
            url: "https://example.com/financial",
            retrievedAt: "2026-06-15T00:00:00.000Z",
            freshness: "latest-public",
            notes: "收入和利润均有披露。",
          },
        ],
      },
    });

    expect(evidence.evidenceHash).toBe("material-hash");
    expect(evidence.summary).toContain("100bn");
    expect(evidence.citations).toEqual([
      expect.objectContaining({ id: "E1", title: "2026Q1 财报", sourceType: "financial" }),
    ]);
  });

  test("combines an industry radar packet with source and indicator evidence", () => {
    const evidence = industryRowsToResearchEvidence({
      title: "存储芯片",
      packet: {
        stage: "扎实增长",
        conclusion: "价格与利润同步改善。",
        confidence: 82,
        risk: 45,
        growth_score: 86,
        momentum_score: 80,
        evidence_score: 88,
        evidence_count: 16,
        run_time: "2026-06-15T00:00:00.000Z",
      },
      sourceRows: [
        {
          title: "存储价格月报",
          source_type: "hard_data",
          content: "DRAM 合约价环比上涨。",
          url: "https://example.com/dram",
          published_at: "2026-06-14",
          confidence: 0.9,
        },
      ],
      indicatorRows: [
        { indicator_name: "growth", value: 86, period: "2026-06", source: "radar_scoring" },
      ],
    });

    expect(evidence.summary).toContain("扎实增长");
    expect(evidence.citations.map((item) => item.sourceType)).toEqual(["hard_data", "indicator"]);
  });
});
