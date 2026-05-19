import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../_shared/auth", () => ({
  verifySessionCookie: vi.fn(async () => true),
}));

import {
  RADAR_CACHE_KEY,
  RADAR_CACHE_VERSION,
  RADAR_DIGEST_CACHE_KEY,
  RADAR_EVIDENCE_SNAPSHOT_KEY,
  RADAR_SOURCE_CACHE_KEY,
  buildRadarEvidenceDigest,
  buildRadarRequest,
  classifyRadarSource,
  createRadarSourcePlan,
  onRequestGet,
  onRequestPost,
  radarModelRoutes,
  summarizeEvidenceBreakdown,
  type RadarCachePayload,
} from "./radar-scan";

const OLD_FETCH = globalThis.fetch;

describe("radar scan model routing", () => {
  test("uses only the DeepSeek paid API for radar scans", () => {
    const routes = radarModelRoutes("paid-key");

    expect(routes).toEqual([
      {
        model: "deepseek-v4-flash",
        url: "https://api.deepseek.com/chat/completions",
        apiKey: "paid-key",
        isFree: false,
      },
    ]);
    expect(routes.some((route) => route.url.includes("opencode.ai"))).toBe(false);
  });

  test("does not call any model when the DeepSeek API key is not configured", () => {
    expect(radarModelRoutes(undefined)).toEqual([]);
  });

  test("builds a paid DeepSeek request with auth, max thinking, and stable JSON output", () => {
    const digest = buildRadarEvidenceDigest([
      { source: "Google News", query: "A股 行业 景气", title: "半导体设备订单增长", url: "https://example.com/a" },
    ]);
    const request = buildRadarRequest(
      { model: "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions", apiKey: "paid-key", isFree: false },
      digest,
      new AbortController().signal,
    );
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(request.headers).toMatchObject({ authorization: "Bearer paid-key" });
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning_effort: "max",
      thinking: { type: "enabled", budget_tokens: 4096 },
      response_format: { type: "json_object" },
      stream: false,
      temperature: 0.1,
      max_tokens: 9000,
    });
    expect(JSON.stringify(body.messages)).toContain("短时间内不要因为单条新闻改变结论");
    expect(JSON.stringify(body.messages)).toContain("代表公司只能列 A 股或港股上市公司");
  });

  test("passes evidence tiers and previous scan context to the model request", () => {
    const previous = cachedRadarPayload().radar;
    const digest = buildRadarEvidenceDigest([
      { source: "东方财富板块", query: "行业板块", title: "半导体设备 +3.2%", url: "https://example.com/board", sourceType: "market", weight: 3 },
      { source: "公司公告", query: "业绩预告", title: "某公司净利润预增", url: "https://example.com/ann", sourceType: "announcement", weight: 4 },
    ]);

    const request = buildRadarRequest(
      { model: "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions", apiKey: "paid-key", isFree: false },
      digest,
      new AbortController().signal,
      previous,
    );
    const body = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> };
    const stablePayload = JSON.parse(body.messages[1].content) as Record<string, unknown>;
    const dynamicPayload = JSON.parse(body.messages[2].content) as Record<string, unknown>;

    expect(dynamicPayload.evidenceDigest).toMatchObject({
      sourceCount: 2,
      evidenceBreakdown: { announcement: 1, market: 1 },
      packets: expect.any(Array),
    });
    expect(dynamicPayload.previousScan).toMatchObject({ id: "radar-1" });
    expect(JSON.stringify(stablePayload)).toContain("硬数据和公告证据优先于新闻与研报观点");
  });

  test("separates stable scan instructions from compact dynamic evidence to improve provider cache hits", () => {
    const digest = buildRadarEvidenceDigest([
      { source: "Google News", query: "A股 行业 景气", title: "半导体设备订单增长", url: "https://example.com/a" },
    ]);
    const request = buildRadarRequest(
      { model: "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions", apiKey: "paid-key", isFree: false },
      digest,
      new AbortController().signal,
      cachedRadarPayload().radar,
    );
    const body = JSON.parse(String(request.body)) as { messages: Array<{ role: string; content: string }> };
    const stablePayload = JSON.parse(body.messages[1].content) as Record<string, unknown>;
    const dynamicPayload = JSON.parse(body.messages[2].content) as Record<string, unknown>;

    expect(stablePayload).toMatchObject({
      task: expect.stringContaining("当前扎实增长的细分产业"),
      expectedJsonShape: expect.any(Object),
    });
    expect(stablePayload).not.toHaveProperty("sources");
    expect(stablePayload).not.toHaveProperty("asOfDate");
    expect(stablePayload).not.toHaveProperty("evidenceBreakdown");
    expect(dynamicPayload).toMatchObject({
      asOfDate: expect.any(String),
      evidenceDigest: expect.objectContaining({
        packets: expect.any(Array),
        citations: expect.any(Array),
      }),
      previousScan: expect.objectContaining({ id: "radar-1" }),
    });
    expect(dynamicPayload).not.toHaveProperty("sources");
  });

  test("defines investment-radar conclusion fields in the stable JSON contract", () => {
    const digest = buildRadarEvidenceDigest([
      { source: "Google News", query: "A股 行业 景气", title: "半导体设备订单增长", url: "https://example.com/a" },
    ]);
    const request = buildRadarRequest(
      { model: "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions", apiKey: "paid-key", isFree: false },
      digest,
      new AbortController().signal,
    );
    const body = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> };
    const stablePayload = JSON.parse(body.messages[1].content) as {
      evidenceRules: string[];
      expectedJsonShape: {
        solidGrowth: Array<Record<string, unknown>>;
      };
    };
    const sampleItem = stablePayload.expectedJsonShape.solidGrowth[0];
    const stableText = JSON.stringify(stablePayload);

    expect(sampleItem).toMatchObject({
      conclusionStrength: "正式结论 | 观察 | 证据不足",
      evidenceGaps: ["缺财报", "缺价格", "缺销量"],
      driverTags: ["需求", "价格", "技术"],
      sustainabilityTier: "短期催化 | 中期景气 | 长期护城河",
      counterEvidenceConditions: ["反证条件"],
    });
    expect(stableText).toContain("驱动因素标签");
    expect(stableText).toContain("供给收缩");
    expect(stableText).toContain("证据缺口");
    expect(stableText).toContain("不要生成全空报告");
  });

  test("caps dynamic evidence text while keeping broad coverage for lower DeepSeek input cost", () => {
    const digest = buildRadarEvidenceDigest(
      Array.from({ length: 120 }, (_, index) => ({
        source: "Google News",
        query: index % 2 === 0 ? "A股 平稳产业 高股息 现金流" : "A股 汽车 航运 钢铁 周期 反转",
        title: `证据标题 ${index} ${"增长验证".repeat(20)}`,
        summary: `摘要 ${index} ${"公开来源与硬数据交叉验证".repeat(30)}`,
        url: `https://example.com/${index}`,
      })),
    );
    const request = buildRadarRequest(
      { model: "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions", apiKey: "paid-key", isFree: false },
      digest,
      new AbortController().signal,
      cachedRadarPayload().radar,
    );
    const body = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> };
    const dynamicPayload = JSON.parse(body.messages[2].content) as {
      evidenceDigest: {
        packets: Array<{ signals: string[] }>;
        citations: Array<{ title: string; summary?: string }>;
      };
    };

    expect(dynamicPayload.evidenceDigest.packets.length).toBeLessThanOrEqual(16);
    expect(dynamicPayload.evidenceDigest.packets.every((packet) => packet.signals.length <= 3)).toBe(true);
    expect(dynamicPayload.evidenceDigest.citations.length).toBeLessThanOrEqual(72);
    expect(dynamicPayload.evidenceDigest.citations.every((source) => source.title.length <= 110 && (source.summary?.length ?? 0) <= 130)).toBe(true);
  });

  test("filters non A-share and Hong Kong representatives from model output", async () => {
    const payload = cachedRadarPayload();
    const digest = buildRadarEvidenceDigest(manyRadarSources(40));
    const env = { AUTH_SECRET: "secret", DEEPSEEK_API_KEY: "paid-key", REPORT_CACHE: kvWith(radarCacheStore(payload, digest)) };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("api.deepseek.com/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(modelRadarPayloadWithOverseasCompanies()) } }],
          }),
        );
      }
      return new Response("", { status: 503 });
    }) as typeof fetch;

    const response = await onRequestPost({
      request: request("POST"),
      env,
    } as unknown as EventContext<typeof env, string, unknown>);
    const json = (await response.json()) as { radar?: unknown };
    const text = JSON.stringify(json.radar);

    expect(response.status).toBe(200);
    expect(text).toContain("兆易创新");
    expect(text).toContain("中芯国际");
    expect(text).not.toContain("美光");
    expect(text).not.toContain("Micron");
    expect(text).not.toContain("英伟达");
  });
});

describe("radar scan evidence tiers", () => {
  test("builds a compact two-stage evidence digest with stable citation ids", () => {
    const digest = buildRadarEvidenceDigest([
      { source: "行业价格", query: "存储芯片 DRAM NAND 价格 库存", title: "DRAM 价格继续上涨", url: "https://example.com/memory", summary: "AI 服务器需求拉动。", sourceType: "hard_data", weight: 5 },
      { source: "公司公告", query: "一季报 营收 净利润 毛利率 订单 产能", title: "半导体设备公司订单增长", url: "https://example.com/order", sourceType: "announcement", weight: 4 },
      { source: "东方财富板块", query: "东方财富板块/行业/概念数据", title: "半导体设备 涨跌幅 4.2%", url: "https://example.com/board", sourceType: "market", signalType: "commodity_price", weight: 3 },
    ]);

    expect(digest.sourceCount).toBe(3);
    expect(digest.citations.map((source) => source.id)).toEqual(["S1", "S2", "S3"]);
    expect(digest.packets[0]).toMatchObject({
      topic: expect.stringContaining("半导体"),
      sourceIds: expect.arrayContaining(["S1"]),
      evidenceTypes: expect.arrayContaining(["hard_data", "announcement"]),
      signalTypes: expect.arrayContaining(["commodity_price"]),
    });
    expect(digest.softCoverage[0]).toMatchObject({
      label: expect.stringContaining("半导体"),
      sourceCount: 3,
    });
  });

  test("keeps external source fetches within the Cloudflare Workers free-plan budget", () => {
    const plan = createRadarSourcePlan();

    expect(plan).toHaveLength(38);
    expect(JSON.stringify(plan)).toContain("平稳产业");
    expect(JSON.stringify(plan)).toContain("高股息");
    expect(plan.filter((item) => item.tier === "hard_data").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "announcement").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "market").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "news").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "research").length).toBeGreaterThan(0);
  });

  test("keeps news line clues in the compact digest even when structured sources have higher scores", () => {
    const digest = buildRadarEvidenceDigest([
      ...Array.from({ length: 80 }, (_, index) => ({
        source: "新浪概念板块",
        query: "新浪概念板块 涨跌幅 成交额",
        title: `概念板块 ${index} 涨跌幅 ${index % 5}%`,
        url: `https://example.com/sina-concept-${index}`,
        sourceType: "market" as const,
        weight: 3,
      })),
      ...Array.from({ length: 44 }, (_, index) => ({
        source: "新浪行业板块",
        query: "新浪行业板块 涨跌幅 成交额",
        title: `行业板块 ${index} 涨跌幅 ${index % 4}%`,
        url: `https://example.com/sina-industry-${index}`,
        sourceType: "market" as const,
        weight: 3,
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        source: "BaoStock 行业分类",
        query: "A股 行业分类 公司分布",
        title: `行业分类 ${index} 覆盖上市公司`,
        url: `https://example.com/baostock-${index}`,
        sourceType: "official" as const,
        weight: 4,
      })),
      ...Array.from({ length: 32 }, (_, index) => ({
        source: "Google News",
        query: "存储芯片 DRAM NAND 价格 库存",
        title: `存储芯片价格和库存新闻线索 ${index}`,
        url: `https://example.com/google-news-${index}`,
        sourceType: "news" as const,
        weight: 2,
      })),
    ]);

    expect(digest.sourceCount).toBe(72);
    expect(digest.evidenceBreakdown.news).toBeGreaterThanOrEqual(16);
    expect(digest.evidenceBreakdown.market).toBeGreaterThan(0);
    expect(digest.evidenceBreakdown.official).toBeGreaterThan(0);
  });

  test("tracks stable high-dividend industries as soft coverage instead of saying they were not covered", () => {
    const digest = buildRadarEvidenceDigest([
      { source: "行业价格", query: "A股 平稳产业 高股息 现金流 公用事业 电信 水电", title: "高股息公用事业现金流稳定", url: "https://example.com/stable", sourceType: "hard_data", weight: 5 },
      { source: "公司公告", query: "A股 港股 平稳产业 分红 ROE 经营现金流", title: "电信运营商分红和经营现金流保持稳定", url: "https://example.com/dividend", sourceType: "announcement", weight: 4 },
    ]);

    expect(digest.softCoverage.some((item) => item.label.includes("平稳"))).toBe(true);
  });

  test("reserves subrequest headroom for model fallbacks and cache writes on the Cloudflare free plan", () => {
    const plan = createRadarSourcePlan();
    const sourceExternalFetches = plan.reduce((sum, item) => sum + (item.kind === "boards" ? 2 : 1), 0);
    const maxModelFallbackFetches = radarModelRoutes("paid-key").length;
    const cacheReadAndWriteRequests = 6;

    expect(sourceExternalFetches + maxModelFallbackFetches + cacheReadAndWriteRequests).toBeLessThanOrEqual(50);
  });

  test("classifies hard data, announcements, market data, news, and research", () => {
    expect(classifyRadarSource({ source: "公司公告", query: "业绩预告", title: "净利润预增", url: "" })).toMatchObject({ sourceType: "announcement", weight: 4 });
    expect(classifyRadarSource({ source: "东方财富板块", query: "行业资金流", title: "半导体设备", url: "" })).toMatchObject({ sourceType: "market", weight: 3 });
    expect(classifyRadarSource({ source: "行业价格", query: "碳酸锂 价格", title: "碳酸锂价格", url: "" })).toMatchObject({ sourceType: "hard_data", weight: 5 });
    expect(classifyRadarSource({ source: "研报摘要", query: "创新药 研报", title: "行业深度", url: "" })).toMatchObject({ sourceType: "research", weight: 1 });
    expect(classifyRadarSource({ source: "Google News", query: "A股 行业", title: "新闻标题", url: "" })).toMatchObject({ sourceType: "news", weight: 2 });
  });

  test("summarizes evidence source counts by tier", () => {
    expect(
      summarizeEvidenceBreakdown([
        { source: "公司公告", query: "业绩预告", title: "净利润预增", url: "", sourceType: "announcement", weight: 4 },
        { source: "东方财富板块", query: "行业资金流", title: "半导体设备", url: "", sourceType: "market", weight: 3 },
        { source: "Google News", query: "A股 行业", title: "新闻标题", url: "", sourceType: "news", weight: 2 },
      ]),
    ).toEqual({ announcement: 1, market: 1, news: 1 });
  });
});

describe("radar scan caching", () => {
  test("GET returns cached radar without calling upstream sources", async () => {
    const payload = cachedRadarPayload();
    const env = { AUTH_SECRET: "secret", REPORT_CACHE: kvWith(payload) };
    globalThis.fetch = vi.fn(async () => new Response("unexpected")) as typeof fetch;

    const response = await onRequestGet({
      request: request("GET"),
      env,
    } as unknown as EventContext<typeof env, string, unknown>);
    const json = (await response.json()) as { radar?: { fromCache?: boolean; model?: string } };

    expect(response.status).toBe(200);
    expect(json.radar?.fromCache).toBe(true);
    expect(json.radar?.model).toBe("deepseek-v4-flash");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("GET keeps returning cached radar even after its display window has passed", async () => {
    const payload = cachedRadarPayload();
    payload.radar.validUntil = "2020-01-01T00:00:00.000Z";
    const env = { AUTH_SECRET: "secret", REPORT_CACHE: kvWith(payload) };
    globalThis.fetch = vi.fn(async () => new Response("unexpected")) as typeof fetch;

    const response = await onRequestGet({
      request: request("GET"),
      env,
    } as unknown as EventContext<typeof env, string, unknown>);
    const json = (await response.json()) as { radar?: { fromCache?: boolean; validUntil?: string } };

    expect(response.status).toBe(200);
    expect(json.radar?.fromCache).toBe(true);
    expect(json.radar?.validUntil).toBe("2020-01-01T00:00:00.000Z");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("POST returns the previous cached radar with a brief warning when refresh generation fails", async () => {
    const payload = cachedRadarPayload();
    const env = { AUTH_SECRET: "secret", DEEPSEEK_API_KEY: "paid-key", REPORT_CACHE: kvWith(payload) };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("chat/completions")) return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
      return new Response("", { status: 503 });
    }) as typeof fetch;

    const response = await onRequestPost({
      request: request("POST"),
      env,
    } as unknown as EventContext<typeof env, string, unknown>);
    const json = (await response.json()) as { radar?: { fromCache?: boolean; refreshWarning?: string }; warning?: string };

    expect(response.status).toBe(200);
    expect(json.radar?.fromCache).toBe(true);
    expect(json.radar?.refreshWarning).toBe("本次刷新失败，已保留上次扫描。请稍后重试。");
    expect(json.warning).toBe("本次刷新失败，已保留上次扫描。请稍后重试。");
  });

  test("POST reuses fresh source and digest caches while still creating a new model scan", async () => {
    const payload = cachedRadarPayload();
    const digest = buildRadarEvidenceDigest([
      { source: "行业价格", query: "存储芯片 DRAM NAND 价格 库存", title: "DRAM 价格继续上涨", url: "https://example.com/memory", summary: "AI 服务器需求拉动。", sourceType: "hard_data", weight: 5 },
      ...manyRadarSources(40),
    ]);
    const env = {
      AUTH_SECRET: "secret",
      DEEPSEEK_API_KEY: "paid-key",
      REPORT_CACHE: kvWith({
        [RADAR_CACHE_KEY]: payload,
        [RADAR_SOURCE_CACHE_KEY]: {
          version: "v2",
          cachedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          sources: digest.citations,
        },
        [RADAR_DIGEST_CACHE_KEY]: {
          version: "v3",
          cachedAt: new Date().toISOString(),
          sourceFingerprint: digest.sourceFingerprint,
          digest,
        },
      }),
    };
    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("api.deepseek.com/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        const dynamicPayload = JSON.parse(body.messages[2].content) as Record<string, unknown>;
        expect(dynamicPayload).not.toHaveProperty("sources");
        expect(dynamicPayload.evidenceDigest).toMatchObject({
          sourceCount: digest.sourceCount,
          packets: expect.any(Array),
        });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(modelRadarPayloadWithSourceIds()) } }],
          }),
        );
      }
      return new Response("", { status: 503 });
    }) as typeof fetch;

    const response = await onRequestPost({
      request: request("POST"),
      env,
    } as unknown as EventContext<typeof env, string, unknown>);
    const json = (await response.json()) as { radar?: { evidenceSources?: Array<{ id: string }>; solidGrowth?: Array<{ sourceIds?: string[] }> } };

    expect(response.status).toBe(200);
    expect(fetchedUrls).toEqual(["https://api.deepseek.com/chat/completions"]);
    expect(env.REPORT_CACHE.get).toHaveBeenCalledWith(RADAR_SOURCE_CACHE_KEY, "json");
    expect(env.REPORT_CACHE.get).toHaveBeenCalledWith(RADAR_DIGEST_CACHE_KEY, "json");
    expect(json.radar?.evidenceSources?.map((source) => source.id)).toContain("S1");
    expect(json.radar?.solidGrowth?.[0]?.sourceIds).toEqual(["S1"]);
  });

  test("POST prefers the rolling evidence snapshot and does not fetch live sources", async () => {
    const payload = cachedRadarPayload();
    const snapshotSources = manyRadarSources(48).map((source, index) => ({
      ...source,
      source: index % 2 === 0 ? "AKShare" : "BaoStock",
      sourceType: index % 3 === 0 ? ("hard_data" as const) : ("market" as const),
      weight: index % 3 === 0 ? 5 : 3,
    }));
    const env = {
      AUTH_SECRET: "secret",
      DEEPSEEK_API_KEY: "paid-key",
      REPORT_CACHE: kvWith({
        [RADAR_CACHE_KEY]: payload,
        [RADAR_EVIDENCE_SNAPSHOT_KEY]: radarEvidenceSnapshot(snapshotSources),
      }),
    };
    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("api.deepseek.com/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        const dynamicPayload = JSON.parse(body.messages[2].content) as { evidenceDigest?: { sourceCount?: number; citations?: Array<{ source: string }> } };
        expect(dynamicPayload.evidenceDigest?.sourceCount).toBe(48);
        expect(dynamicPayload.evidenceDigest?.citations?.some((source) => source.source === "AKShare")).toBe(true);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(modelRadarPayloadWithSourceIds()) } }],
          }),
        );
      }
      return new Response("unexpected live source fetch", { status: 503 });
    }) as typeof fetch;

    const response = await onRequestPost({
      request: request("POST"),
      env,
    } as unknown as EventContext<typeof env, string, unknown>);

    expect(response.status).toBe(200);
    expect(fetchedUrls).toEqual(["https://api.deepseek.com/chat/completions"]);
    expect(env.REPORT_CACHE.get).toHaveBeenCalledWith(RADAR_EVIDENCE_SNAPSHOT_KEY, "json");
  });

  test("POST reuses the cached radar without DeepSeek when the rolling evidence hash is unchanged", async () => {
    const digest = buildRadarEvidenceDigest(manyRadarSources(48));
    const payload = cachedRadarPayload();
    payload.radar.evidenceSources = digest.citations;
    payload.radar.sourceCount = digest.sourceCount;
    const env = {
      AUTH_SECRET: "secret",
      DEEPSEEK_API_KEY: "paid-key",
      REPORT_CACHE: kvWith({
        [RADAR_CACHE_KEY]: payload,
        [RADAR_EVIDENCE_SNAPSHOT_KEY]: radarEvidenceSnapshot(digest.citations),
      }),
    };
    globalThis.fetch = vi.fn(async () => new Response("unexpected")) as typeof fetch;

    const response = await onRequestPost({
      request: request("POST"),
      env,
    } as unknown as EventContext<typeof env, string, unknown>);
    const json = (await response.json()) as { radar?: { fromCache?: boolean; reuseReason?: string; sourceCount?: number } };

    expect(response.status).toBe(200);
    expect(json.radar?.fromCache).toBe(true);
    expect(json.radar?.sourceCount).toBe(digest.sourceCount);
    expect(json.radar?.reuseReason).toContain("证据库未变化");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("POST calls the DeepSeek paid API directly and caches the result", async () => {
    const payload = cachedRadarPayload();
    const digest = buildRadarEvidenceDigest(manyRadarSources(40));
    const env = { AUTH_SECRET: "secret", DEEPSEEK_API_KEY: "paid-key", REPORT_CACHE: kvWith(radarCacheStore(payload, digest)) };
    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("api.deepseek.com/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(modelRadarPayload()) } }],
          }),
        );
      }
      return new Response("", { status: 503 });
    }) as typeof fetch;

    const response = await onRequestPost({
      request: request("POST"),
      env,
    } as unknown as EventContext<typeof env, string, unknown>);
    const json = (await response.json()) as { radar?: { model?: string; fromCache?: boolean } };

    expect(response.status).toBe(200);
    expect(json.radar?.model).toBe("deepseek-v4-flash");
    expect(json.radar?.fromCache).toBe(false);
    expect(env.REPORT_CACHE.put).toHaveBeenCalledWith(RADAR_CACHE_KEY, expect.stringContaining("deepseek-v4-flash"));
    expect(fetchedUrls.filter((url) => url.includes("api.deepseek.com/chat/completions"))).toHaveLength(1);
    expect(fetchedUrls.some((url) => url.includes("opencode.ai"))).toBe(false);
  });

  test("POST normalizes investment-radar fields from model output", async () => {
    const payload = cachedRadarPayload();
    const digest = buildRadarEvidenceDigest(manyRadarSources(40));
    const env = { AUTH_SECRET: "secret", DEEPSEEK_API_KEY: "paid-key", REPORT_CACHE: kvWith(radarCacheStore(payload, digest)) };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("api.deepseek.com/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(modelRadarPayloadWithInvestmentFields()) } }],
          }),
        );
      }
      return new Response("", { status: 503 });
    }) as typeof fetch;

    const response = await onRequestPost({
      request: request("POST"),
      env,
    } as unknown as EventContext<typeof env, string, unknown>);
    const json = (await response.json()) as {
      radar?: {
        solidGrowth?: Array<{
          conclusionStrength?: string;
          evidenceGaps?: string[];
          driverTags?: string[];
          sustainabilityTier?: string;
          counterEvidenceConditions?: string[];
        }>;
      };
    };
    const item = json.radar?.solidGrowth?.[0];

    expect(response.status).toBe(200);
    expect(item).toMatchObject({
      conclusionStrength: "正式结论",
      evidenceGaps: ["缺财报", "缺价格", "缺销量"],
      driverTags: ["需求", "价格", "供给收缩"],
      sustainabilityTier: "长期护城河",
      counterEvidenceConditions: ["订单连续两个季度低于预期"],
    });
    expect(item?.driverTags).not.toContain("海外扩张");
    expect(item?.evidenceGaps).not.toContain("缺品牌认知");
  });

  test("POST returns coverage review and rewrites misleading not-covered wording", async () => {
    const payload = cachedRadarPayload();
    const digest = buildRadarEvidenceDigest([
      { source: "行业价格", query: "汽车 销量 新能源车 出口 数据", title: "汽车出口保持增长", url: "https://example.com/auto", sourceType: "hard_data", weight: 5 },
      { source: "行业价格", query: "航运 运价 指数 供需", title: "集运运价分化", url: "https://example.com/shipping", sourceType: "hard_data", weight: 5 },
      { source: "公司公告", query: "A股 平稳产业 高股息 现金流 公用事业 电信 水电", title: "高股息公用事业现金流稳定", url: "https://example.com/stable", sourceType: "announcement", weight: 4 },
      ...manyRadarSources(40),
    ]);
    const env = {
      AUTH_SECRET: "secret",
      DEEPSEEK_API_KEY: "paid-key",
      REPORT_CACHE: kvWith({
        [RADAR_CACHE_KEY]: payload,
        [RADAR_SOURCE_CACHE_KEY]: {
          version: "v2",
          cachedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          sources: digest.citations,
        },
        [RADAR_DIGEST_CACHE_KEY]: {
          version: "v3",
          cachedAt: new Date().toISOString(),
          sourceFingerprint: digest.sourceFingerprint,
          digest,
        },
      }),
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("api.deepseek.com/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(modelRadarPayloadWithMisleadingCoverage()) } }],
          }),
        );
      }
      return new Response("", { status: 503 });
    }) as typeof fetch;

    const response = await onRequestPost({
      request: request("POST"),
      env,
    } as unknown as EventContext<typeof env, string, unknown>);
    const json = (await response.json()) as { radar?: { coverageReview?: Array<{ label: string; status: string }>; stageCompanies?: Array<{ label: string; note: string }>; limitations?: string[] } };

    expect(response.status).toBe(200);
    expect(json.radar?.coverageReview?.some((item) => item.label.includes("汽车") && item.status === "watched")).toBe(true);
    expect(JSON.stringify(json.radar)).not.toContain("未能覆盖汽车");
    expect(JSON.stringify(json.radar)).not.toContain("没有覆盖平稳产业");
  });

  test("POST preserves the cached radar when the evidence pack is too thin", async () => {
    const payload = cachedRadarPayload();
    const digest = buildRadarEvidenceDigest([
      { source: "行业价格", query: "汽车 销量 新能源车 出口 数据", title: "汽车出口保持增长", url: "https://example.com/auto", sourceType: "hard_data", weight: 5 },
    ]);
    const env = {
      AUTH_SECRET: "secret",
      DEEPSEEK_API_KEY: "paid-key",
      REPORT_CACHE: kvWith({
        [RADAR_CACHE_KEY]: payload,
        [RADAR_SOURCE_CACHE_KEY]: {
          version: "v2",
          cachedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          sources: digest.citations,
        },
        [RADAR_DIGEST_CACHE_KEY]: {
          version: "v3",
          cachedAt: new Date().toISOString(),
          sourceFingerprint: digest.sourceFingerprint,
          digest,
        },
      }),
    };
    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input));
      return new Response("", { status: 503 });
    }) as typeof fetch;

    const response = await onRequestPost({
      request: request("POST"),
      env,
    } as unknown as EventContext<typeof env, string, unknown>);
    const json = (await response.json()) as { radar?: { fromCache?: boolean; sourceCount?: number }; warning?: string };

    expect(response.status).toBe(200);
    expect(json.radar?.fromCache).toBe(true);
    expect(json.radar?.sourceCount).toBe(payload.radar.sourceCount);
    expect(json.warning).toBe("本次刷新失败，已保留上次扫描。请稍后重试。");
    expect(fetchedUrls.some((url) => url.includes("api.deepseek.com/chat/completions"))).toBe(false);
  });
});

function request(method: string) {
  return new Request("https://alpha.custard.top/api/radar-scan", {
    method,
    headers: { cookie: "session=mock" },
  });
}

function kvWith(payload: RadarCachePayload | Record<string, unknown>) {
  if (RADAR_CACHE_KEY in payload) {
    const store = payload;
    return {
      get: vi.fn(async (key: string) => store[key] ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store[key] = JSON.parse(value) as unknown;
      }),
    };
  }
  return {
    get: vi.fn(async (key: string) => (key === RADAR_CACHE_KEY ? payload : null)),
    put: vi.fn(),
  };
}

function radarCacheStore(payload: RadarCachePayload, digest: ReturnType<typeof buildRadarEvidenceDigest>) {
  return {
    [RADAR_CACHE_KEY]: payload,
    [RADAR_SOURCE_CACHE_KEY]: {
      version: "v2",
      cachedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      sources: digest.citations,
    },
    [RADAR_DIGEST_CACHE_KEY]: {
      version: "v3",
      cachedAt: new Date().toISOString(),
      sourceFingerprint: digest.sourceFingerprint,
      digest,
    },
  };
}

function radarEvidenceSnapshot(sources: ReturnType<typeof manyRadarSources>) {
  return {
    version: "v1",
    generatedAt: new Date().toISOString(),
    asOfDate: new Date().toISOString().slice(0, 10),
    source: "github-actions",
    sources,
  };
}

function cachedRadarPayload(): RadarCachePayload {
  const now = new Date().toISOString();
  return {
    version: RADAR_CACHE_VERSION,
    cachedAt: now,
    radar: {
      id: "radar-1",
      title: "行业雷达扫描",
      generatedAt: now,
      asOfDate: now.slice(0, 10),
      validUntil: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      model: "deepseek-v4-flash",
      sourceCount: 1,
      sourceQueries: ["A股 行业 景气"],
      fromCache: false,
      executiveSummary: ["半导体设备、电网设备和创新药保持较扎实增长。"],
      solidGrowth: [],
      sustainability: [],
      bubbleRisks: [],
      upcomingGrowth: [],
      decliningIndustries: [],
      representativeCompanies: [],
      stageCompanies: [],
      limitations: ["测试缓存。"],
    },
  };
}

function modelRadarPayload() {
  return {
    title: "行业雷达扫描",
    asOfDate: "2026-05-18",
    confidenceSummary: "测试模型输出。",
    changeLog: ["DeepSeek 官方 API 生成。"],
    executiveSummary: ["雷达扫描直接使用 DeepSeek 官方 API。"],
    solidGrowth: [],
    sustainability: [],
    bubbleRisks: [],
    upcomingGrowth: [],
    decliningIndustries: [],
    representativeCompanies: [],
    stageCompanies: [],
    limitations: ["测试输出。"],
  };
}

function modelRadarPayloadWithSourceIds() {
  return {
    ...modelRadarPayload(),
    solidGrowth: [
      {
        title: "半导体设备增长",
        industries: ["半导体设备"],
        companies: ["北方华创"],
        thesis: "测试证据 ID 绑定。",
        drivers: ["订单增长"],
        evidence: ["DRAM 价格继续上涨"],
        sourceIds: ["S1"],
        evidenceTypes: ["hard_data"],
        supportingSourceCount: 1,
        confidence: "高",
        durability: "中期",
        riskLevel: "中",
        changeReason: "测试。",
        turningPoints: ["订单放缓"],
      },
    ],
  };
}

function modelRadarPayloadWithInvestmentFields() {
  return {
    ...modelRadarPayload(),
    solidGrowth: [
      {
        title: "存储芯片价格复苏",
        industries: ["存储芯片"],
        companies: ["兆易创新"],
        thesis: "价格、库存和服务器需求共同支持复苏判断。",
        drivers: ["AI 服务器需求", "价格上涨", "供给收缩"],
        evidence: ["测试证据"],
        sourceIds: ["S1"],
        evidenceTypes: ["hard_data"],
        supportingSourceCount: 3,
        confidence: "高",
        durability: "长期",
        riskLevel: "中",
        conclusionStrength: "正式结论",
        evidenceGaps: ["缺财报", "缺价格", "缺销量", "缺品牌认知"],
        driverTags: ["需求", "价格", "供给收缩", "海外扩张"],
        sustainabilityTier: "长期护城河",
        changeReason: "测试。",
        counterEvidenceConditions: ["订单连续两个季度低于预期"],
        turningPoints: ["价格下跌"],
      },
    ],
  };
}

function modelRadarPayloadWithOverseasCompanies() {
  return {
    ...modelRadarPayload(),
    solidGrowth: [
      {
        title: "存储芯片",
        industries: ["存储芯片"],
        companies: ["美光（Micron）", "兆易创新", "中芯国际", "英伟达"],
        thesis: "测试海外代表公司过滤。",
        drivers: ["AI需求"],
        evidence: ["测试证据"],
        evidenceTypes: ["hard_data"],
        supportingSourceCount: 3,
        confidence: "高",
        durability: "长期",
        riskLevel: "中",
        changeReason: "测试。",
        turningPoints: ["测试拐点"],
      },
    ],
    representativeCompanies: [
      {
        label: "扎实增长产业中的代表公司",
        companies: ["美光（Micron）", "兆易创新", "中芯国际", "NVIDIA"],
        note: "测试代表公司清洗。",
      },
    ],
    stageCompanies: [
      {
        label: "上升产业中的领军人物",
        companies: ["英伟达", "中芯国际"],
        note: "测试阶段公司清洗。",
      },
    ],
  };
}

function modelRadarPayloadWithMisleadingCoverage() {
  return {
    ...modelRadarPayload(),
    stageCompanies: [
      {
        label: "平稳产业中的杰出经营者",
        companies: [],
        note: "没有覆盖平稳产业，无法推荐。",
      },
    ],
    limitations: ["未能覆盖汽车、航运、钢铁等产业的反转或增长机会。"],
  };
}

function manyRadarSources(count: number) {
  const templates = [
    { source: "行业价格", query: "碳酸锂 价格 库存 产能 锂电", sourceType: "hard_data" as const, weight: 5 },
    { source: "AKShare/Sina期货日线", query: "铜 钨 稀土 价格 供需 库存", sourceType: "hard_data" as const, weight: 5 },
    { source: "AKShare/100ppi期现基差", query: "钢铁 水泥 价格 开工率 需求", sourceType: "hard_data" as const, weight: 5 },
    { source: "AKShare/乘联会汽车统计", query: "汽车 销量 新能源车 出口 数据", sourceType: "official" as const, weight: 4 },
    { source: "AKShare/生猪价格统计", query: "猪价 产能 库存 周期", sourceType: "hard_data" as const, weight: 5 },
    { source: "东方财富行业指数", query: "航运 运价 指数 供需", sourceType: "market" as const, weight: 3 },
    { source: "公司公告", query: "一季报 营收 净利润 毛利率 订单 产能", sourceType: "announcement" as const, weight: 4 },
    { source: "BaoStock 行业分类", query: "A股 行业分类 公司分布", sourceType: "official" as const, weight: 4 },
    { source: "新浪概念板块", query: "新浪概念板块 涨跌幅 成交额", sourceType: "market" as const, weight: 3 },
    { source: "Google News", query: "存储芯片 DRAM NAND 价格 库存", sourceType: "news" as const, weight: 2 },
    { source: "研报摘要", query: "行业研报 高景气 业绩增长 细分产业", sourceType: "research" as const, weight: 1 },
    { source: "平稳产业数据", query: "A股 平稳产业 高股息 现金流 公用事业 电信 水电", sourceType: "hard_data" as const, weight: 5 },
  ];
  return Array.from({ length: count }, (_, index) => {
    const template = templates[index % templates.length];
    return {
      ...template,
      title: `补充证据 ${index} ${template.query}`,
      url: `https://example.com/source-${index}`,
      signalType: template.sourceType === "hard_data" ? ("commodity_price" as const) : undefined,
    };
  });
}

afterEach(() => {
  globalThis.fetch = OLD_FETCH;
  vi.restoreAllMocks();
});
