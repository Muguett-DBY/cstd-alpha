import { describe, expect, test, vi } from "vitest";
import { buildAnySearchRequestBody, fetchAnySearchEvidence, fetchSearxngEvidence, normalizeAnySearchResults } from "./anysearch";

describe("AnySearch helper", () => {
  test("builds finance-oriented requests with freshness and vertical filters", () => {
    const body = buildAnySearchRequestBody({
      query: "贵州茅台 财报 风险 行业 2026",
      maxResults: 4,
      domains: ["finance", "business"],
      tags: ["finance.market", "business.company"],
      contentTypes: ["news", "web", "data"],
      freshness: "month",
    });

    expect(body).toEqual({
      query: "贵州茅台 财报 风险 行业 2026",
      max_results: 4,
      domains: ["finance", "business"],
      tags: ["finance.market", "business.company"],
      content_types: ["news", "web", "data"],
      zone: "cn",
      language: "zh-CN",
      constraint: { freshness: "month" },
    });
  });

  test("normalizes results as supplemental evidence with quality metadata", () => {
    const items = normalizeAnySearchResults(
      {
        results: [
          {
            title: "贵州茅台 业绩说明会披露渠道库存",
            url: "https://example.com/maotai",
            description: "渠道库存和批价变化。",
            content: "公司说明渠道库存下降，批价仍需观察。",
            source: "news",
            quality_score: 0.92,
            published_at: "2026-05-18T00:00:00Z",
          },
        ],
        metadata: { request_id: "req_123", cached: true },
      },
      { query: "贵州茅台 渠道库存", topic: "白酒", sourceType: "official" },
    );

    expect(items).toEqual([
      expect.objectContaining({
        source: "AnySearch",
        sourceType: "official",
        signalType: "external_search",
        qualityScore: 0.92,
        anysearchRequestId: "req_123",
        cached: true,
        topic: "白酒",
      }),
    ]);
    expect(items[0].summary).toContain("渠道库存");
  });

  test("normalizes the wrapped API response shape returned by production", () => {
    const items = normalizeAnySearchResults(
      {
        code: 0,
        message: "success",
        data: {
          results: [
            {
              title: "半导体行业双周报",
              url: "https://example.com/semiconductor.pdf",
              content: "CSP 资本开支上调，存储链条继续受益。",
              source: "doc",
              quality_score: 0.81,
            },
          ],
          metadata: { request_id: "req_wrapped", cached: false },
        },
      },
      { query: "半导体 AI算力", topic: "半导体/AI算力" },
    );

    expect(items).toEqual([
      expect.objectContaining({
        title: "半导体行业双周报",
        sourceType: "official",
        anysearchRequestId: "req_wrapped",
        cached: false,
      }),
    ]);
  });

  test("returns an empty list on quota or service failures without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate limit" });

    await expect(
      fetchAnySearchEvidence({
        queries: [{ query: "光伏 硅料 价格", topic: "光伏产业链", sourceType: "news" }],
        apiKey: "key",
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anysearch.com/v1/search",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer key" }) }),
    );
  });

  test("normalizes SearXNG results as low-weight supplemental search evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: "英伟达 最新财报",
            url: "https://www.sec.gov/Archives/nvda",
            content: "SEC filings and company results.",
            engine: "google",
            score: 0.7,
          },
        ],
      }),
    });

    const items = await fetchSearxngEvidence({
      endpoints: "https://search.example.com",
      queries: [{ query: "NVDA 财报 风险", topic: "英伟达", sourceType: "news" }],
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("https://search.example.com/search?"), expect.any(Object));
    expect(items).toEqual([
      expect.objectContaining({
        source: "SearXNG",
        sourceType: "official",
        signalType: "external_search",
        topic: "英伟达",
      }),
    ]);
  });
});
