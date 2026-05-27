import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../_shared/auth", () => ({
  readSessionCookie: vi.fn(async () => ({ userId: "user-admin", username: "admin", displayName: "admin", role: "admin", sessionId: "session", expiresAt: new Date(Date.now() + 3600_000).toISOString() })),
}));

import {
  RADAR_ANALYSIS_JOB_LATEST_KEY,
  RADAR_ANALYSIS_JOB_PREFIX,
  RADAR_CACHE_KEY,
  RADAR_CACHE_VERSION,
  RADAR_EVIDENCE_SNAPSHOT_KEY,
  buildRadarEvidenceDigest,
  buildRadarRequest,
  classifyRadarSource,
  generateRadarScan,
  onRequestGet,
  onRequestPost,
  radarModelRoutes,
  summarizeEvidenceBreakdown,
  type RadarCachePayload,
} from "./radar-scan";

const OLD_FETCH = globalThis.fetch;

describe("radar scan model contract", () => {
  test("routes DeepSeek requests through free OpenCode Zen, OpenCode Go, then official DeepSeek", () => {
    const routes = radarModelRoutes({ OPENCODE_API_KEY: "go-key", DEEPSEEK_API_KEY: "deepseek-key" });

    expect(routes).toEqual([
      {
        model: "deepseek-v4-flash-free",
        url: "https://opencode.ai/zen/v1/chat/completions",
        apiKey: undefined,
        isFree: true,
        provider: "opencode-zen-free",
      },
      {
        model: "deepseek-v4-flash",
        url: "https://opencode.ai/zen/v1/chat/completions",
        apiKey: "go-key",
        isFree: false,
        provider: "opencode-go",
      },
      {
        model: "deepseek-v4-flash",
        url: "https://api.deepseek.com/chat/completions",
        apiKey: "deepseek-key",
        isFree: false,
        provider: "deepseek-official",
      },
    ]);
  });

  test("builds a DeepSeek request from structured evidence and previous scan context", () => {
    const previous = cachedRadarPayload().radar;
    const digest = buildRadarEvidenceDigest([
      {
        source: "东方财富业绩报表",
        query: "A股 财报 营收 净利润 毛利率 经营现金流",
        title: "百济神州 2026Q1 营收同比 31.02%，净利润同比 1801.30%",
        url: "https://data.eastmoney.com/bbsj/202603/yjbb.html#688235",
        sourceType: "announcement",
        signalType: "financial_metric",
        weight: 4,
      },
      {
        source: "AKShare/乘联会汽车统计",
        query: "汽车/智能驾驶 汽车出口 销量 同比",
        title: "狭义乘用车出口 2026年4月 77.02 万辆，同比 82.16%",
        url: "http://data.cpcadata.com/TotalMarket",
        sourceType: "official",
        signalType: "industry_stat",
        weight: 4,
      },
    ]);

    const request = buildRadarRequest(
      { model: "deepseek-v4-flash-free", url: "https://opencode.ai/zen/v1/chat/completions", isFree: true, provider: "opencode-zen-free" },
      digest,
      new AbortController().signal,
      previous,
    );
    const body = JSON.parse(String(request.body)) as { reasoning_effort?: string; thinking?: unknown; messages: Array<{ content: string }> };
    const stablePayload = JSON.parse(body.messages[1].content) as Record<string, unknown>;
    const dynamicPayload = JSON.parse(body.messages[2].content) as Record<string, unknown>;

    expect(request.headers).not.toHaveProperty("authorization");
    expect(body).toMatchObject({
      model: "deepseek-v4-flash-free",
      response_format: { type: "json_object" },
      stream: false,
      temperature: 0.1,
    });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(JSON.stringify(stablePayload)).toContain("信息差");
    expect(JSON.stringify(stablePayload)).toContain("代表公司只能列 A 股或港股上市公司");
    expect(dynamicPayload).toMatchObject({
      previousScan: expect.objectContaining({ id: "radar-1" }),
      evidenceDigest: expect.objectContaining({
        sourceCount: 2,
        evidenceBreakdown: { announcement: 1, official: 1 },
      }),
    });
  });
});

describe("radar scan async job API", () => {
  test("GET returns cached radar and latest job status without calling upstream APIs", async () => {
    const payload = cachedRadarPayload();
    const job = radarJob("running");
    const env = { AUTH_SECRET: "secret", REPORT_CACHE: kvWith({ [RADAR_CACHE_KEY]: payload, [RADAR_ANALYSIS_JOB_LATEST_KEY]: job }) };
    globalThis.fetch = vi.fn(async () => new Response("unexpected")) as typeof fetch;

    const response = await onRequestGet(context("GET", env));
    const json = (await response.json()) as { radar?: { fromCache?: boolean; evidenceFreshness?: { sourceCount?: number } }; job?: { status?: string }; diagnostics?: { jobStatus?: string } };

    expect(response.status).toBe(200);
    expect(json.radar?.fromCache).toBe(true);
    expect(json.radar?.evidenceFreshness?.sourceCount).toBeUndefined();
    expect(json.job?.status).toBe("running");
    expect(json.diagnostics?.jobStatus).toBe("running");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("POST creates a KV job, dispatches the GitHub Action, and never calls DeepSeek in Cloudflare", async () => {
    const payload = cachedRadarPayload();
    const store = {
      [RADAR_CACHE_KEY]: payload,
      [RADAR_EVIDENCE_SNAPSHOT_KEY]: radarEvidenceSnapshot(),
    };
    const env = {
      AUTH_SECRET: "secret",
      GITHUB_RADAR_DISPATCH_TOKEN: "github-token",
      REPORT_CACHE: kvWith(store),
    };
    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchedUrls.push(String(input));
      expect(String(init?.body)).toContain("job_id");
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const response = await onRequestPost(context("POST", env));
    const json = (await response.json()) as { radar?: { fromCache?: boolean; evidenceFreshness?: { evidenceHash?: string; stale?: boolean } }; job?: { id?: string; status?: string }; diagnostics?: { evidenceHash?: string } };

    expect(response.status).toBe(202);
    expect(json.radar?.fromCache).toBe(true);
    expect(json.radar?.evidenceFreshness).toMatchObject({ evidenceHash: "abc123", stale: false });
    expect(json.job?.status).toBe("queued");
    expect(json.diagnostics?.evidenceHash).toBe("abc123");
    expect(json.job?.id).toMatch(/^radar-/);
    expect(fetchedUrls).toEqual(["https://api.github.com/repos/Muguett-DBY/cstd-alpha/actions/workflows/radar-analysis.yml/dispatches"]);
    expect(fetchedUrls.some((url) => url.includes("deepseek.com"))).toBe(false);
    expect(env.REPORT_CACHE.put).toHaveBeenCalledWith(`${RADAR_ANALYSIS_JOB_PREFIX}${json.job?.id}`, expect.stringContaining('"queued"'), expect.anything());
    expect(env.REPORT_CACHE.put).toHaveBeenCalledWith(RADAR_ANALYSIS_JOB_LATEST_KEY, expect.stringContaining('"queued"'), expect.anything());
  });

  test("POST reuses a running job so repeated clicks do not duplicate DeepSeek spend", async () => {
    const payload = cachedRadarPayload();
    const job = radarJob("running");
    const env = {
      AUTH_SECRET: "secret",
      GITHUB_RADAR_DISPATCH_TOKEN: "github-token",
      REPORT_CACHE: kvWith({ [RADAR_CACHE_KEY]: payload, [RADAR_ANALYSIS_JOB_LATEST_KEY]: job }),
    };
    globalThis.fetch = vi.fn(async () => new Response("unexpected")) as typeof fetch;

    const response = await onRequestPost(context("POST", env));
    const json = (await response.json()) as { radar?: { fromCache?: boolean }; job?: { id?: string; status?: string } };

    expect(response.status).toBe(202);
    expect(json.radar?.fromCache).toBe(true);
    expect(json.job).toMatchObject({ id: job.id, status: "running" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("Cloudflare fallback analysis never performs live source crawling", async () => {
    const env = {
      AUTH_SECRET: "secret",
      OPENCODE_API_KEY: "paid-key",
      REPORT_CACHE: kvWith({}),
    };
    globalThis.fetch = vi.fn(async () => new Response("unexpected")) as typeof fetch;

    await expect(generateRadarScan(env, new AbortController().signal, null)).rejects.toThrow("雷达证据包过薄");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("POST returns a queued job immediately and records background dispatch failure without exposing details", async () => {
    const payload = cachedRadarPayload();
    const env = {
      AUTH_SECRET: "secret",
      GITHUB_RADAR_DISPATCH_TOKEN: "github-token",
      REPORT_CACHE: kvWith({ [RADAR_CACHE_KEY]: payload, [RADAR_EVIDENCE_SNAPSHOT_KEY]: radarEvidenceSnapshot() }),
    };
    globalThis.fetch = vi.fn(async () => new Response("bad token", { status: 401 })) as typeof fetch;
    const waitUntilTasks: Promise<unknown>[] = [];

    const response = await onRequestPost(context("POST", env, waitUntilTasks));
    const json = (await response.json()) as { radar?: { fromCache?: boolean; refreshWarning?: string }; job?: { status?: string }; warning?: string };

    expect(response.status).toBe(202);
    expect(json.radar?.fromCache).toBe(true);
    expect(json.job?.status).toBe("queued");
    expect(json.warning).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("bad token");
    await Promise.all(waitUntilTasks);
    expect(env.REPORT_CACHE.put).toHaveBeenCalledWith(RADAR_ANALYSIS_JOB_LATEST_KEY, expect.stringContaining('"failed"'), expect.anything());
  });
});

describe("radar evidence tiers", () => {
  test("builds citation packets with structured financial, industry, and market evidence", () => {
    const digest = buildRadarEvidenceDigest([
      { source: "东方财富业绩报表", query: "A股 财报 营收 净利润 毛利率 经营现金流", title: "百济神州 2026Q1 营收同比 31.02%，净利润同比 1801.30%", url: "https://example.com/fin", sourceType: "announcement", signalType: "financial_metric", weight: 4 },
      { source: "AKShare/Sina期货日线", query: "铜 期货 价格 库存 供需", title: "沪铜主连收盘上涨", url: "https://example.com/copper", sourceType: "hard_data", signalType: "commodity_price", weight: 5 },
      { source: "AKShare/乘联会汽车统计", query: "汽车 销量 新能源车 出口 数据", title: "汽车出口同比增长", url: "https://example.com/auto", sourceType: "official", signalType: "industry_stat", weight: 4 },
      { source: "东方财富板块", query: "行业资金流", title: "机器人板块涨跌幅 4.2%", url: "https://example.com/board", sourceType: "market", weight: 3 },
    ]);

    expect(digest.sourceCount).toBe(4);
    expect(digest.citations.map((source) => source.id)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(digest.evidenceBreakdown).toMatchObject({ hard_data: 1, official: 1, announcement: 1, market: 1 });
    expect(digest.packets.some((packet) => packet.signalTypes.includes("financial_metric"))).toBe(true);
  });

  test("classifies source tiers consistently", () => {
    expect(classifyRadarSource({ source: "公司公告", query: "业绩预告", title: "净利润预增", url: "" })).toMatchObject({ sourceType: "announcement", weight: 4 });
    expect(classifyRadarSource({ source: "东方财富板块", query: "行业资金流", title: "半导体设备", url: "" })).toMatchObject({ sourceType: "market", weight: 3 });
    expect(classifyRadarSource({ source: "行业价格", query: "碳酸锂 价格", title: "碳酸锂价格", url: "" })).toMatchObject({ sourceType: "hard_data", weight: 5 });
    expect(summarizeEvidenceBreakdown([{ source: "Google News", query: "A股 行业", title: "新闻标题", url: "", sourceType: "news", weight: 2 }])).toEqual({ news: 1 });
  });
});

function request(method: string) {
  return new Request("https://alpha.custard.top/api/radar-scan", {
    method,
    headers: { cookie: "session=mock" },
  });
}

function context<TEnv>(method: string, env: TEnv, waitUntilTasks?: Promise<unknown>[]) {
  return {
    request: request(method),
    env,
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      waitUntilTasks?.push(promise);
    }),
  } as unknown as EventContext<TEnv, string, unknown>;
}

function kvWith(store: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store[key] = JSON.parse(value) as unknown;
    }),
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
      sourceCount: 8,
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

function radarJob(status: "queued" | "running" | "completed" | "failed") {
  const now = new Date().toISOString();
  return {
    id: "radar-job-1",
    status,
    createdAt: now,
    updatedAt: now,
    evidenceHash: "abc123",
    message: "后台分析中。",
  };
}

function radarEvidenceSnapshot() {
  return {
    version: "v1",
    generatedAt: new Date().toISOString(),
    asOfDate: new Date().toISOString().slice(0, 10),
    source: "github-actions-python",
    evidenceHash: "abc123",
    sources: [
      { source: "东方财富业绩报表", query: "A股 财报 营收 净利润", title: "百济神州净利润高增", url: "https://example.com/fin", sourceType: "announcement", signalType: "financial_metric", weight: 4 },
    ],
    financialFacts: [{ company: "百济神州", market: "A股", code: "688235.SH", metric: "净利润", value: 1607782000, yoy: 1801.3 }],
    industryFacts: [],
    companyCandidates: [{ company: "百济神州", market: "A股", industry: "化学制药", evidenceStrength: 4 }],
  };
}

afterEach(() => {
  globalThis.fetch = OLD_FETCH;
  vi.restoreAllMocks();
});
