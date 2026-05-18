import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../_shared/auth", () => ({
  verifySessionCookie: vi.fn(async () => true),
}));

import {
  RADAR_CACHE_KEY,
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
    const request = buildRadarRequest(
      { model: "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions", apiKey: "paid-key", isFree: false },
      [{ source: "Google News", query: "A股 行业 景气", title: "半导体设备订单增长", url: "https://example.com/a" }],
      new AbortController().signal,
    );
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(request.headers).toMatchObject({ authorization: "Bearer paid-key" });
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning_effort: "max",
      thinking: { type: "enabled", budget_tokens: 8192 },
      response_format: { type: "json_object" },
      stream: false,
      temperature: 0.1,
      max_tokens: 14000,
    });
    expect(JSON.stringify(body.messages)).toContain("短时间内不要因为单条新闻改变结论");
  });

  test("passes evidence tiers and previous scan context to the model request", () => {
    const previous = cachedRadarPayload().radar;
    const sources = [
      { source: "东方财富板块", query: "行业板块", title: "半导体设备 +3.2%", url: "https://example.com/board", sourceType: "market", weight: 3 },
      { source: "公司公告", query: "业绩预告", title: "某公司净利润预增", url: "https://example.com/ann", sourceType: "announcement", weight: 4 },
    ] as const;

    const request = buildRadarRequest(
      { model: "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions", apiKey: "paid-key", isFree: false },
      sources,
      new AbortController().signal,
      previous,
    );
    const body = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> };
    const stablePayload = JSON.parse(body.messages[1].content) as Record<string, unknown>;
    const dynamicPayload = JSON.parse(body.messages[2].content) as Record<string, unknown>;

    expect(dynamicPayload.evidenceBreakdown).toEqual({ announcement: 1, market: 1 });
    expect(dynamicPayload.previousScan).toMatchObject({ id: "radar-1" });
    expect(JSON.stringify(stablePayload)).toContain("硬数据和公告证据优先于新闻与研报观点");
  });

  test("separates stable scan instructions from dynamic evidence to improve provider cache hits", () => {
    const request = buildRadarRequest(
      { model: "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions", apiKey: "paid-key", isFree: false },
      [{ source: "Google News", query: "A股 行业 景气", title: "半导体设备订单增长", url: "https://example.com/a" }],
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
    expect(dynamicPayload).toMatchObject({
      asOfDate: expect.any(String),
      sources: expect.any(Array),
      previousScan: expect.objectContaining({ id: "radar-1" }),
    });
  });
});

describe("radar scan evidence tiers", () => {
  test("keeps external source fetches within the Cloudflare Workers free-plan budget", () => {
    const plan = createRadarSourcePlan();

    expect(plan).toHaveLength(38);
    expect(plan.filter((item) => item.tier === "hard_data").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "announcement").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "market").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "news").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "research").length).toBeGreaterThan(0);
  });

  test("reserves subrequest headroom for model fallbacks and cache writes on the Cloudflare free plan", () => {
    const plan = createRadarSourcePlan();
    const sourceExternalFetches = plan.reduce((sum, item) => sum + (item.kind === "boards" ? 2 : 1), 0);
    const maxModelFallbackFetches = radarModelRoutes("paid-key").length;
    const cacheReadAndWriteRequests = 2;

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

  test("POST returns the previous cached radar with a clear warning when refresh generation fails", async () => {
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
    expect(json.radar?.refreshWarning).toContain("本次刷新失败");
    expect(json.warning).toContain("模型限流");
  });

  test("POST calls the DeepSeek paid API directly and caches the result", async () => {
    const payload = cachedRadarPayload();
    const env = { AUTH_SECRET: "secret", DEEPSEEK_API_KEY: "paid-key", REPORT_CACHE: kvWith(payload) };
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
});

function request(method: string) {
  return new Request("https://alpha.custard.top/api/radar-scan", {
    method,
    headers: { cookie: "session=mock" },
  });
}

function kvWith(payload: RadarCachePayload) {
  return {
    get: vi.fn(async (key: string) => (key === RADAR_CACHE_KEY ? payload : null)),
    put: vi.fn(),
  };
}

function cachedRadarPayload(): RadarCachePayload {
  const now = new Date().toISOString();
  return {
    version: "v1",
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

afterEach(() => {
  globalThis.fetch = OLD_FETCH;
  vi.restoreAllMocks();
});
