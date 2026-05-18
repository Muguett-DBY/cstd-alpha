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
  test("uses only OpenCode Zen free models and never DeepSeek paid fallback", () => {
    const routes = radarModelRoutes("paid-key");

    expect(routes[0]).toMatchObject({
      model: "deepseek-v4-flash-free",
      url: "https://opencode.ai/zen/v1/chat/completions",
      isFree: true,
    });
    expect(routes.map((route) => route.model)).toEqual(["deepseek-v4-flash-free", "minimax-m2.5-free", "nemotron-3-super-free", "big-pickle"]);
    expect(routes.every((route) => route.isFree)).toBe(true);
    expect(routes.some((route) => route.url.includes("api.deepseek.com"))).toBe(false);
    expect(routes.some((route) => route.apiKey)).toBe(false);
  });

  test("builds a stable JSON request with free-model thinking enabled and no auth header", () => {
    const request = buildRadarRequest(
      { model: "deepseek-v4-flash-free", url: "https://opencode.ai/zen/v1/chat/completions", isFree: true },
      [{ source: "Google News", query: "A股 行业 景气", title: "半导体设备订单增长", url: "https://example.com/a" }],
      new AbortController().signal,
    );
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(request.headers).not.toHaveProperty("authorization");
    expect(body).toMatchObject({
      model: "deepseek-v4-flash-free",
      reasoning_effort: "max",
      thinking: { type: "enabled" },
      response_format: { type: "json_object" },
      stream: false,
      temperature: 0.1,
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
      { model: "deepseek-v4-flash-free", url: "https://opencode.ai/zen/v1/chat/completions", isFree: true },
      sources,
      new AbortController().signal,
      previous,
    );
    const body = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> };
    const userPayload = JSON.parse(body.messages[1].content) as Record<string, unknown>;

    expect(userPayload.evidenceBreakdown).toEqual({ announcement: 1, market: 1 });
    expect(userPayload.previousScan).toMatchObject({ id: "radar-1" });
    expect(JSON.stringify(userPayload)).toContain("硬数据和公告证据优先于新闻与研报观点");
  });
});

describe("radar scan evidence tiers", () => {
  test("keeps external source fetches within the Cloudflare Workers free-plan budget", () => {
    const plan = createRadarSourcePlan();

    expect(plan).toHaveLength(42);
    expect(plan.filter((item) => item.tier === "hard_data").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "announcement").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "market").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "news").length).toBeGreaterThan(0);
    expect(plan.filter((item) => item.tier === "research").length).toBeGreaterThan(0);
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
    expect(json.radar?.model).toBe("deepseek-v4-flash-free");
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
      model: "deepseek-v4-flash-free",
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

afterEach(() => {
  globalThis.fetch = OLD_FETCH;
  vi.restoreAllMocks();
});
