import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../_shared/auth", () => ({
  verifySessionCookie: vi.fn(async () => true),
}));

import {
  RADAR_CACHE_KEY,
  buildRadarRequest,
  onRequestGet,
  radarModelRoutes,
  type RadarCachePayload,
} from "./radar-scan";

const OLD_FETCH = globalThis.fetch;

describe("radar scan model routing", () => {
  test("uses OpenCode Zen free model before paid fallback", () => {
    const routes = radarModelRoutes("paid-key");

    expect(routes[0]).toMatchObject({
      model: "deepseek-v4-flash-free",
      url: "https://opencode.ai/zen/v1/chat/completions",
      isFree: true,
    });
    expect(routes[1]).toMatchObject({
      model: "deepseek-v4-flash",
      url: "https://api.deepseek.com/chat/completions",
      apiKey: "paid-key",
      isFree: false,
    });
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
