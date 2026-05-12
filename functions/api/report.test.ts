import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./report";
import { verifySessionCookie } from "../_shared/auth";
import { callDeepSeekReport, MODEL_OUTPUT_LENGTH_MESSAGE } from "../_shared/deepseek";
import { fetchPublicCompanyEvidence, type EvidenceBundle } from "../_shared/providers";

vi.mock("../_shared/auth", () => ({
  verifySessionCookie: vi.fn(),
}));

vi.mock("../_shared/deepseek", () => ({
  MODEL_OUTPUT_LENGTH_MESSAGE: "模型输出超过长度限制，本次报告未完成，请重试。",
  callDeepSeekReport: vi.fn(),
}));

vi.mock("../_shared/providers", () => ({
  fetchPublicCompanyEvidence: vi.fn(),
}));

const evidence: EvidenceBundle = {
  company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
  retrievedAt: "2026-05-10T00:00:00.000Z",
  evidence: [
    {
      title: "600519 identity",
      source: "Eastmoney",
      url: "https://example.com/identity",
      retrievedAt: "2026-05-10T00:00:00.000Z",
      freshness: "latest-public",
      notes: "ok",
    },
    {
      title: "600519 financials",
      source: "Eastmoney",
      url: "https://example.com/financials",
      retrievedAt: "2026-05-10T00:00:00.000Z",
      freshness: "latest-public",
      notes: "ok",
    },
  ],
  facts: {},
};

describe("report API stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns a shared server cached report without fetching providers or calling DeepSeek", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    const cachedReport = { company: evidence.company, evidence: evidence.evidence, oneSentence: "缓存报告" };
    const cache = mockKvCache({
      report: cachedReport,
      evidence,
      cachedAt: "2026-05-10T00:00:00.000Z",
      expiresAt: "2099-05-11T00:00:00.000Z",
      metrics: {
        startedAt: "2026-05-10T00:00:00.000Z",
        completedAt: "2026-05-10T00:06:00.000Z",
        elapsedMs: 360000,
        modelCalls: 9,
        cacheMode: "refresh",
      },
    });

    const events = await postReportEvents({ env: { REPORT_CACHE: cache } });

    expect(fetchPublicCompanyEvidence).not.toHaveBeenCalled();
    expect(callDeepSeekReport).not.toHaveBeenCalled();
    expect(cache.get).toHaveBeenCalledWith(expect.stringMatching(/^report:v5-risk-indicators:/), "json");
    expect(events.find((event) => event.stage === "server_cache_hit")).toMatchObject({
      type: "progress",
      label: "命中共享缓存",
      evidenceCount: 2,
    });
    expect(events.at(-1)).toMatchObject({
      type: "final",
      report: cachedReport,
      metrics: {
        cacheHit: true,
        modelCalls: 0,
        sourceElapsedMs: 360000,
      },
    });
  });

  test("uses the same shared cache key for the same listed security across candidate sources", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockResolvedValue({ company: evidence.company, evidence: evidence.evidence });
    const firstCache = mockKvCacheByKey(() => null);
    const secondCache = mockKvCacheByKey(() => null);
    const firstCompany = {
      id: "eastmoney:1.600519",
      name: "贵州茅台",
      code: "600519",
      exchange: "上海证券交易所",
      listingPlace: "沪A",
      marketType: "AStock",
      quoteId: "1.600519",
      source: "eastmoney" as const,
    };
    const secondCompany = {
      ...firstCompany,
      id: "alternate-provider:SH600519",
      name: "贵州茅台股份有限公司",
      exchange: "SSE",
    };

    await postReportEvents({ company: firstCompany, env: { REPORT_CACHE: firstCache } });
    await postReportEvents({ company: secondCompany, env: { REPORT_CACHE: secondCache } });

    expect(firstReportGetKey(firstCache)).toBe(firstReportGetKey(secondCache));
  });

  test("falls back to a legacy shared cache key before regenerating", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    const cachedReport = { company: evidence.company, evidence: evidence.evidence, oneSentence: "旧 key 缓存报告" };
    let reportReads = 0;
    const cache = mockKvCacheByKey((key) => {
      if (key.startsWith("report:")) {
        reportReads += 1;
        return reportReads === 2
          ? {
              report: cachedReport,
              evidence,
              cachedAt: "2026-05-10T00:00:00.000Z",
              expiresAt: "2099-05-11T00:00:00.000Z",
            }
          : null;
      }
      return null;
    });

    const events = await postReportEvents({ env: { REPORT_CACHE: cache } });

    expect(fetchPublicCompanyEvidence).not.toHaveBeenCalled();
    expect(callDeepSeekReport).not.toHaveBeenCalled();
    expect(reportGetKeys(cache)).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      report: cachedReport,
      metrics: { cacheHit: true },
    });
  });

  test("refresh mode bypasses shared cache and stores the generated report", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockResolvedValue({ company: evidence.company, evidence: evidence.evidence });
    const previousReport = { company: evidence.company, evidence: [], oneSentence: "旧缓存" };
    const cache = mockKvCache({
      report: previousReport,
      evidence: { ...evidence, evidence: [] },
      cachedAt: "2026-05-10T00:00:00.000Z",
      expiresAt: "2099-05-11T00:00:00.000Z",
    });

    const events = await postReportEvents({ forceRefresh: true, env: { REPORT_CACHE: cache } });

    expect(fetchPublicCompanyEvidence).toHaveBeenCalledTimes(1);
    expect(callDeepSeekReport).toHaveBeenCalledTimes(1);
    expect(callDeepSeekReport).toHaveBeenCalledWith(expect.objectContaining({ priorReport: previousReport }));
    expect(cache.get.mock.calls.some(([key]) => typeof key === "string" && key.startsWith("report:"))).toBe(true);
    expect(cache.put).toHaveBeenCalledWith(expect.stringMatching(/^report:/), expect.any(String), expect.objectContaining({ expirationTtl: 2_592_000 }));
    expect(events.at(-1)).toMatchObject({ type: "final" });
  });

  test("waits for a shared cached report when the same report is already generating", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    const cachedReport = { company: evidence.company, evidence: evidence.evidence, oneSentence: "等待后命中缓存" };
    let reportReads = 0;
    const cache = mockKvCacheByKey((key) => {
      if (key.startsWith("report:")) {
        reportReads += 1;
        return reportReads >= 4
          ? {
              report: cachedReport,
              evidence,
              cachedAt: "2026-05-10T00:00:00.000Z",
              expiresAt: "2099-05-11T00:00:00.000Z",
            }
          : null;
      }
      if (key.startsWith("report-lock:")) {
        return {
          owner: "other-request",
          companyName: "贵州茅台",
          startedAt: "2026-05-10T00:00:00.000Z",
          refreshedAt: "2099-05-10T00:10:00.000Z",
          expiresAt: "2099-05-10T00:30:00.000Z",
        };
      }
      return null;
    });

    const events = await postReportEvents({ env: { REPORT_CACHE: cache } });

    expect(fetchPublicCompanyEvidence).not.toHaveBeenCalled();
    expect(callDeepSeekReport).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(events.find((event) => event.stage === "generation_locked")).toMatchObject({
      type: "progress",
      label: "同公司报告正在生成",
    });
    expect(events.at(-1)).toMatchObject({
      type: "final",
      report: cachedReport,
      metrics: { cacheHit: true },
    });
  });

  test("takes over a stale legacy generation lock instead of waiting for the full lock TTL", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockResolvedValue({ company: evidence.company, evidence: evidence.evidence });
    const cache = mockKvCacheByKey((key) => {
      if (key.startsWith("report-lock:")) {
        return {
          owner: "stale-legacy-request",
          companyName: "贵州茅台",
          startedAt: "2026-05-10T00:00:00.000Z",
          expiresAt: "2099-05-10T00:30:00.000Z",
        };
      }
      return null;
    });

    const events = await postReportEvents({ env: { REPORT_CACHE: cache } });

    expect(fetchPublicCompanyEvidence).toHaveBeenCalledTimes(1);
    expect(callDeepSeekReport).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.stage === "generation_locked")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "final" });
  });

  test("creates and releases a shared generation lock around uncached generation", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockResolvedValue({ company: evidence.company, evidence: evidence.evidence });
    const cache = mockKvCacheByKey(() => null);

    const events = await postReportEvents({ env: { REPORT_CACHE: cache } });

    const lockPut = cache.put.mock.calls.find(([key]) => typeof key === "string" && key.startsWith("report-lock:"));
    expect(lockPut).toEqual([expect.stringMatching(/^report-lock:/), expect.any(String), expect.objectContaining({ expirationTtl: 1800 })]);
    expect(cache.delete).toHaveBeenCalledWith(expect.stringMatching(/^report-lock:/));
    expect(events.at(-1)).toMatchObject({ type: "final" });
  });

  test("releases the shared generation lock when report generation fails", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockRejectedValue(Object.assign(new Error("模型临时失败"), { code: "MODEL_TEMPORARY_FAILURE", retryable: true }));
    const cache = mockKvCacheByKey(() => null);

    const events = await postReportEvents({ env: { REPORT_CACHE: cache } });

    expect(cache.put).toHaveBeenCalledWith(expect.stringMatching(/^report-lock:/), expect.any(String), expect.objectContaining({ expirationTtl: 1800 }));
    expect(cache.delete).toHaveBeenCalledWith(expect.stringMatching(/^report-lock:/));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: "模型临时失败",
      code: "MODEL_TEMPORARY_FAILURE",
      retryable: true,
    });
  });

  test("keeps a successful report final when releasing the shared generation lock fails", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockResolvedValue({ company: evidence.company, evidence: evidence.evidence });
    const cache = mockKvCacheByKey(() => null, { failDelete: true });

    const events = await postReportEvents({ env: { REPORT_CACHE: cache } });

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "final" });
  });

  test("does not acquire the shared generation lock when another request overwrites ownership", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    const cachedReport = { company: evidence.company, evidence: evidence.evidence, oneSentence: "竞态后命中缓存" };
    let reportReads = 0;
    const cache = mockKvCacheByKey(() => null, {
      resolve: (key) => {
        if (!key.startsWith("report:")) return null;
        reportReads += 1;
        return reportReads >= 3
          ? {
              report: cachedReport,
              evidence,
              cachedAt: "2026-05-10T00:00:00.000Z",
              expiresAt: "2099-05-11T00:00:00.000Z",
            }
          : null;
      },
      afterPut: (key, stored) => {
        if (key.startsWith("report-lock:")) {
          stored.set(
            key,
            JSON.stringify({
              owner: "other-request",
              companyName: "贵州茅台",
              startedAt: "2026-05-10T00:00:00.000Z",
              refreshedAt: "2099-05-10T00:10:00.000Z",
              expiresAt: "2099-05-10T00:30:00.000Z",
            }),
          );
        }
      },
    });

    const events = await postReportEvents({ env: { REPORT_CACHE: cache } });

    expect(fetchPublicCompanyEvidence).not.toHaveBeenCalled();
    expect(callDeepSeekReport).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "final",
      report: cachedReport,
      metrics: { cacheHit: true },
    });
  });

  test("emits a structured evidence count before model generation", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockResolvedValue({ company: evidence.company, evidence: evidence.evidence });

    const events = await postReportEvents();

    expect(events.find((event) => event.stage === "evidence_ready")).toMatchObject({
      type: "progress",
      evidenceCount: 2,
    });
    expect(events.at(-1)).toMatchObject({ type: "final" });
  });

  test("uses a stream-owned abort signal for providers and DeepSeek", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockResolvedValue({ company: evidence.company, evidence: evidence.evidence });
    const controller = new AbortController();

    const events = await postReportEvents({ signal: controller.signal });

    const providerSignal = vi.mocked(fetchPublicCompanyEvidence).mock.calls[0][0].signal;
    const deepSeekSignal = vi.mocked(callDeepSeekReport).mock.calls[0][0].signal;
    expect(providerSignal).toBeInstanceOf(AbortSignal);
    expect(deepSeekSignal).toBe(providerSignal);
    expect(providerSignal).not.toBe(controller.signal);
    expect(events.at(-1)).toMatchObject({ type: "final" });
  });

  test("does not abort report work when the incoming request signal aborts after streaming starts", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    const requestController = new AbortController();
    let modelSignal: AbortSignal | undefined;
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockImplementation(({ signal }) => {
      modelSignal = signal;
      requestController.abort();
      return Promise.resolve({ company: evidence.company, evidence: evidence.evidence });
    });

    const events = await postReportEvents({ signal: requestController.signal });

    expect(modelSignal?.aborted).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "final" });
  });

  test("keeps report work alive when the response stream is passively canceled", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    let providerSignal: AbortSignal | undefined;
    let resolveEvidence: ((value: EvidenceBundle) => void) | undefined;
    const waitUntil = vi.fn();
    vi.mocked(fetchPublicCompanyEvidence).mockImplementation(({ signal }) => {
      providerSignal = signal;
      return new Promise((resolve) => {
        resolveEvidence = resolve;
      });
    });
    vi.mocked(callDeepSeekReport).mockResolvedValue({ company: evidence.company, evidence: evidence.evidence });
    const response = await postReportResponse({ waitUntil });
    const reader = response.body?.getReader();

    await reader?.read();
    await reader?.cancel();
    resolveEvidence?.(evidence);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    expect(providerSignal?.aborted).toBe(false);
    expect(callDeepSeekReport).toHaveBeenCalled();
  });

  test("adds elapsed timing fields to progress and final stream events", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockResolvedValue({ company: evidence.company, evidence: evidence.evidence });

    const events = await postReportEvents();
    const progress = events.find((event) => event.type === "progress");
    const final = events.at(-1);

    expect(progress).toEqual(
      expect.objectContaining({
        startedAt: expect.any(String),
        elapsedMs: expect.any(Number),
      }),
    );
    expect(final).toMatchObject({
      type: "final",
      metrics: {
        startedAt: expect.any(String),
        completedAt: expect.any(String),
        elapsedMs: expect.any(Number),
        modelCalls: expect.any(Number),
        cacheMode: "prefer-cache",
      },
    });
  });

  test("streams model length failures as errors instead of final reports", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockRejectedValue(Object.assign(new Error(MODEL_OUTPUT_LENGTH_MESSAGE), { code: "MODEL_OUTPUT_LENGTH", retryable: true }));

    const events = await postReportEvents();

    expect(events.some((event) => event.type === "final")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: MODEL_OUTPUT_LENGTH_MESSAGE,
      code: "MODEL_OUTPUT_LENGTH",
      retryable: true,
    });
  });

  test("emits US SEC fallback progress when SEC evidence is available", async () => {
    const usEvidence: EvidenceBundle = {
      ...evidence,
      company: { name: "苹果", ticker: "AAPL", market: "美股" },
      facts: {
        sec: {
          cik: "0000320193",
          latestAnnual: { form: "10-K", fiscalYear: 2025 },
        },
      },
    };
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(usEvidence);
    vi.mocked(callDeepSeekReport).mockResolvedValue({ company: usEvidence.company, evidence: usEvidence.evidence });

    const events = await postReportEvents();

    expect(events.find((event) => event.stage === "us_sec_fallback")).toMatchObject({
      type: "progress",
      label: "美股财报来源切换",
      evidenceCount: 2,
    });
  });
});

type TestKvCache = {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function mockKvCache(value: unknown): TestKvCache {
  return mockKvCacheByKey((key) => (key.startsWith("report:") ? value : null));
}

function mockKvCacheByKey(
  resolve: (key: string) => unknown,
  options: { resolve?: (key: string) => unknown; afterPut?: (key: string, stored: Map<string, string>) => void; failDelete?: boolean } = {},
): TestKvCache {
  const stored = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (stored.has(key)) return Promise.resolve(JSON.parse(stored.get(key) ?? "null"));
      return Promise.resolve((options.resolve ?? resolve)(key));
    }),
    put: vi.fn().mockImplementation((key: string, value: string) => {
      stored.set(key, value);
      options.afterPut?.(key, stored);
      return Promise.resolve();
    }),
    delete: vi.fn().mockImplementation((key: string) => {
      if (options.failDelete) return Promise.reject(new Error("KV delete failed"));
      stored.delete(key);
      return Promise.resolve();
    }),
  };
}

function reportGetKeys(cache: TestKvCache) {
  return cache.get.mock.calls.map(([key]) => key).filter((key): key is string => typeof key === "string" && key.startsWith("report:"));
}

function firstReportGetKey(cache: TestKvCache) {
  return reportGetKeys(cache)[0];
}

async function postReportEvents(options: { forceRefresh?: boolean; company?: Record<string, unknown>; env?: Record<string, unknown>; signal?: AbortSignal; waitUntil?: (promise: Promise<unknown>) => void } = {}) {
  const response = await postReportResponse(options);

  return (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function postReportResponse(options: { forceRefresh?: boolean; company?: Record<string, unknown>; env?: Record<string, unknown>; signal?: AbortSignal; waitUntil?: (promise: Promise<unknown>) => void } = {}) {
  const company = options.company ?? {
    id: "eastmoney:1.600519",
    name: "贵州茅台",
    code: "600519",
    exchange: "上海证券交易所",
    listingPlace: "沪A",
    marketType: "AStock",
    quoteId: "1.600519",
    source: "eastmoney",
  };
  return onRequestPost({
    request: new Request("https://alpha.custard.top/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session=ok" },
      signal: options.signal,
      body: JSON.stringify({
        forceRefresh: options.forceRefresh,
        company,
      }),
    }),
    env: { AUTH_SECRET: "secret", DEEPSEEK_API_KEY: "key", ...options.env },
    waitUntil: options.waitUntil ?? vi.fn(),
  } as Parameters<typeof onRequestPost>[0]);
}
