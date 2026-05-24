import { describe, expect, test, vi } from "vitest";
import {
  buildAnySearchRequestBody,
  buildArxivSearchUrl,
  buildExaSearchRequestBody,
  buildGdeltSearchUrl,
  buildSemanticScholarSearchUrl,
  fetchAnySearchEvidence,
  fetchArxivEvidence,
  fetchExaEvidence,
  fetchGdeltEvidence,
  fetchSearxngEvidence,
  fetchSemanticScholarEvidence,
  normalizeAnySearchResults,
  normalizeArxivResults,
  normalizeExaResults,
  normalizeGdeltResults,
  normalizeSemanticScholarResults,
} from "./anysearch";

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

  test("builds Exa requests with highlights and capped result count", () => {
    expect(buildExaSearchRequestBody({ query: "宁德时代 overseas risk", maxResults: 50, contentTypes: ["news", "web"] })).toEqual({
      query: "宁德时代 overseas risk",
      type: "auto",
      numResults: 10,
      contents: { highlights: true },
      category: "news",
    });
  });

  test("normalizes Exa highlights as supplemental evidence", () => {
    const items = normalizeExaResults(
      {
        requestId: "exa_req_1",
        searchType: "auto",
        results: [
          {
            title: "Nvidia annual report",
            url: "https://www.sec.gov/Archives/nvda",
            publishedDate: "2026-05-01",
            highlights: ["Revenue growth and data center risks."],
            highlightScores: [0.91],
          },
        ],
        costDollars: { total: 0.001 },
      },
      { query: "NVDA annual report risk", topic: "英伟达" },
    );

    expect(items).toEqual([
      expect.objectContaining({
        source: "Exa",
        sourceType: "official",
        signalType: "external_search",
        exaRequestId: "exa_req_1",
        exaSearchType: "auto",
        exaCostDollars: 0.001,
        topic: "英伟达",
      }),
    ]);
    expect(items[0].summary).toContain("Revenue growth");
  });

  test("fetches Exa with x-api-key and fails closed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ requestId: "exa_req_2", results: [{ title: "白酒库存", url: "https://example.com/baijiu", highlights: ["批价和库存变化。"] }] }),
    });

    const items = await fetchExaEvidence({
      apiKey: "exa-key",
      queries: [{ query: "白酒 批价 库存", maxResults: 10 }],
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.exa.ai/search",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "exa-key" }) }),
    );
    expect(items[0]).toEqual(expect.objectContaining({ source: "Exa", title: "白酒库存" }));
    await expect(fetchExaEvidence({ queries: [{ query: "no key" }], fetchImpl: fetchMock })).resolves.toEqual([]);
  });

  test("builds GDELT requests as keyless global news search with capped records", () => {
    const url = new URL(buildGdeltSearchUrl({ query: "CATL overseas policy risk", maxResults: 50, freshness: "week" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.gdeltproject.org/api/v2/doc/doc");
    expect(url.searchParams.get("query")).toBe("CATL overseas policy risk");
    expect(url.searchParams.get("mode")).toBe("artlist");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("maxrecords")).toBe("10");
    expect(url.searchParams.get("timespan")).toBe("1week");
  });

  test("adds English aliases for Chinese GDELT queries", () => {
    const url = new URL(buildGdeltSearchUrl({ query: "宁德时代 海外政策风险", maxResults: 5 }));
    expect(url.searchParams.get("query")).toContain("CATL");
    expect(url.searchParams.get("query")).toContain("overseas policy risk");
  });

  test("normalizes GDELT article lists as low-weight search evidence", async () => {
    const items = normalizeGdeltResults(
      {
        articles: [
          {
            title: "Global EV battery policy risk",
            url: "https://example.com/catl-risk",
            seendate: "20260524T120000Z",
            domain: "example.com",
            sourceCountry: "US",
            language: "English",
          },
        ],
      },
      { query: "CATL overseas policy risk", topic: "宁德时代", sourceType: "official" },
    );

    expect(items).toEqual([
      expect.objectContaining({
        source: "GDELT",
        sourceType: "news",
        signalType: "external_search",
        weight: 1,
        topic: "宁德时代",
        anysearchSource: "example.com",
      }),
    ]);
    expect(items[0].summary).toContain("Global news mention");

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, text: async () => "bad gateway" });
    await expect(fetchGdeltEvidence({ queries: [{ query: "fail closed" }], fetchImpl: fetchMock })).resolves.toEqual([]);
  });

  test("builds and normalizes arXiv academic search without promoting it to hard data", async () => {
    const url = new URL(buildArxivSearchUrl({ query: "humanoid robot whole-body control", maxResults: 9 }));
    expect(`${url.origin}${url.pathname}`).toBe("https://export.arxiv.org/api/query");
    expect(url.searchParams.get("search_query")).toContain("all:humanoid");
    expect(url.searchParams.get("max_results")).toBe("5");
    expect(url.searchParams.get("sortBy")).toBe("submittedDate");

    const xml = [
      "<feed>",
      "<entry>",
      "<id>http://arxiv.org/abs/2605.12345v1</id>",
      "<title>Whole-body control for humanoid robots</title>",
      "<summary>We study coordinated locomotion and manipulation control.</summary>",
      "<published>2026-05-20T00:00:00Z</published>",
      "<link href=\"http://arxiv.org/abs/2605.12345v1\" rel=\"alternate\" />",
      "</entry>",
      "</feed>",
    ].join("");
    const items = normalizeArxivResults(xml, { query: "humanoid robot whole-body control", topic: "优必选" });
    expect(items).toEqual([
      expect.objectContaining({
        source: "ArXiv",
        sourceType: "news",
        signalType: "external_search",
        weight: 2,
        contentType: "academic",
      }),
    ]);

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => xml });
    await expect(fetchArxivEvidence({ queries: [{ query: "humanoid robot", topic: "机器人" }], fetchImpl: fetchMock })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "ArXiv" })]),
    );
  });

  test("normalizes Semantic Scholar paper search as academic search evidence", async () => {
    const url = new URL(buildSemanticScholarSearchUrl({ query: "AI server HBM memory", maxResults: 50 }));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.semanticscholar.org/graph/v1/paper/search");
    expect(url.searchParams.get("query")).toBe("AI server HBM memory");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("fields")).toContain("title");

    const items = normalizeSemanticScholarResults(
      {
        data: [
          {
            title: "High bandwidth memory for AI accelerators",
            url: "https://www.semanticscholar.org/paper/abc",
            abstract: "HBM improves accelerator memory bandwidth.",
            year: 2026,
            venue: "Conference",
          },
        ],
      },
      { query: "AI server HBM memory", topic: "存储芯片" },
    );

    expect(items).toEqual([
      expect.objectContaining({
        source: "SemanticScholar",
        sourceType: "news",
        signalType: "external_search",
        weight: 2,
        contentType: "academic",
      }),
    ]);

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await expect(fetchSemanticScholarEvidence({ queries: [{ query: "empty" }], fetchImpl: fetchMock })).resolves.toEqual([]);
  });
});
