import { describe, expect, test, vi } from "vitest";
import { callDeepSeekReport, MODEL_OUTPUT_INVALID_JSON_MESSAGE, MODEL_OUTPUT_LENGTH_MESSAGE } from "./deepseek";
import type { EvidenceBundle } from "./providers";
import { SCORE_ITEMS_20 } from "../../src/shared/report";

const evidence: EvidenceBundle = {
  company: { name: "Example Inc.", ticker: "EXM", market: "US" },
  retrievedAt: "2026-05-10T00:00:00.000Z",
  evidence: [],
  facts: { quote: { regularMarketPrice: 10 } },
};

function modelResponse(payload: Record<string, unknown>, finishReason = "stop") {
  return {
    ok: true,
    json: async () => ({
      usage: {
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 100,
        prompt_cache_miss_tokens: 900,
        completion_tokens: 200,
        total_tokens: 1200,
      },
      choices: [
        {
          finish_reason: finishReason,
          message: { content: JSON.stringify(payload) },
        },
      ],
    }),
  };
}

function deferredModelResponse(payload: Record<string, unknown>) {
  let resolve!: (value: ReturnType<typeof modelResponse>) => void;
  const promise = new Promise<ReturnType<typeof modelResponse>>((next) => {
    resolve = next;
  });
  return {
    promise,
    resolve: () => resolve(modelResponse(payload)),
  };
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function reportPayload(overrides: Record<string, unknown> = {}) {
  return {
    company: { name: "Example Inc.", ticker: "EXM", market: "US" },
    asOf: "2026-05-10T00:00:00.000Z",
    conclusion: "观察",
    oneSentence: "A test company.",
    cqs: 60,
    ias: 55,
    moduleScores: [],
    scoreItems20: SCORE_ITEMS_20.map((item, index) => ({
      id: item.id,
      score: 55 + (index % 10),
      label: "一般",
      evidence: ["公开证据"],
      deductions: ["扣分点"],
      recentChange: "最近 12 个月影响有限。",
      reason: "基于公开证据给出中性评分。",
    })),
    redFlags: [],
    evidence: [],
    sections: {
      companyOverview: "overview",
      industry: "industry",
      businessModel: "model",
      moat: "moat",
      governance: "governance",
      financialQuality: "financials",
      growth: "growth",
      valuation: "valuation",
      risks: "risks",
      finalConclusion: "final",
    },
    disclaimer: "Research only.",
    ...overrides,
  };
}

const narrativeSections = {
  onePageConclusion: "完整一页结论",
  companyOverview: "完整公司概况",
  industryTrack: "完整行业分析",
  businessModel: "完整商业模式",
  moat: "完整护城河",
  governance: "完整治理分析",
  financialQuality: "完整财务分析",
  growthInflection: "完整成长分析",
  valuation: "完整估值分析",
  risks: "完整风险分析",
  finalConclusion: "完整最终结论",
  accountRules: "完整仓位规则",
};

const narrativeBatches = [
  ["onePageConclusion", "companyOverview", "industryTrack"],
  ["businessModel", "moat", "governance"],
  ["financialQuality", "growthInflection", "valuation"],
  ["risks", "finalConclusion", "accountRules"],
] as const;

const detailBatches = [
  SCORE_ITEMS_20.slice(0, 5),
  SCORE_ITEMS_20.slice(5, 10),
  SCORE_ITEMS_20.slice(10, 15),
  SCORE_ITEMS_20.slice(15, 20),
] as const;

function narrativePayload(keys: readonly string[] = Object.keys(narrativeSections)) {
  return {
    fullSections: Object.fromEntries(keys.map((key) => [key, narrativeSections[key as keyof typeof narrativeSections]])),
  };
}

function mockNarrativeBatches(fetchMock: ReturnType<typeof vi.fn>) {
  for (const batch of narrativeBatches) {
    fetchMock.mockResolvedValueOnce(modelResponse(narrativePayload(batch)));
  }
  return fetchMock;
}

function detailPayload(items = SCORE_ITEMS_20) {
  return {
    scoreItemDetails: items.map((item) => ({
      id: item.id,
      evidence: [`${item.title} 最新财报证据一`, `${item.title} 最新行情证据二`, `${item.title} 行业对比证据三`],
      deductions: [`${item.title} 主要扣分点`],
      recentChange: `${item.title} 最近 12 个月变化已纳入评分。`,
      reason:
        `${item.title} 的评分基于最新公开财报、行情估值和可验证经营线索综合判断。该项既考虑绝对水平，也考虑趋势变化和潜在反证条件；若关键指标继续恶化，分数应继续下调，不能因为公司知名度而给出模糊高分。`,
    })),
  };
}

function mockDetailBatches(fetchMock: ReturnType<typeof vi.fn>) {
  for (const batch of detailBatches) {
    fetchMock.mockResolvedValueOnce(modelResponse(detailPayload(batch)));
  }
  return fetchMock;
}

function mockSuccessfulReport(scoringPayload = reportPayload()) {
  const fetchMock = vi.fn().mockResolvedValueOnce(modelResponse(scoringPayload));
  mockDetailBatches(fetchMock);
  return mockNarrativeBatches(fetchMock);
}

describe("DeepSeek report client", () => {
  test("requests DeepSeek V4 Pro in max thinking mode with JSON output", async () => {
    const fetchMock = mockSuccessfulReport();

    await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.reasoning_effort).toBe("max");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(18000);
    const userPayload = JSON.parse(body.messages[1].content);
    expect(userPayload.expectedOutputShape.scoreItems20[0]).not.toHaveProperty("question");
    expect(userPayload.expectedOutputShape.scoreItems20[0]).toEqual(
      expect.objectContaining({ id: "industryLifecycle", score: 0, label: "一般" }),
    );
  });

  test("uses V4 Pro for scoring and V4 Flash for detail and narrative generation", async () => {
    const fetchMock = mockSuccessfulReport();

    await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    const scoringBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const detailBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    const narrativeBody = JSON.parse(fetchMock.mock.calls[5][1].body);
    expect(scoringBody.model).toBe("deepseek-v4-pro");
    expect(detailBody.model).toBe("deepseek-v4-flash");
    expect(narrativeBody.model).toBe("deepseek-v4-flash");
    for (const body of [scoringBody, detailBody, narrativeBody]) {
      expect(body.reasoning_effort).toBe("max");
      expect(body.thinking).toEqual({ type: "enabled" });
    }
  });

  test("collects DeepSeek token usage including cache hit and miss tokens by model", async () => {
    const fetchMock = mockSuccessfulReport();
    const metrics = { modelCalls: 0 };

    await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock, metrics });

    expect(metrics.modelCalls).toBe(9);
    expect(metrics.tokenUsage).toEqual([
      {
        model: "deepseek-v4-pro",
        calls: 1,
        promptTokens: 1000,
        promptCacheHitTokens: 100,
        promptCacheMissTokens: 900,
        completionTokens: 200,
        totalTokens: 1200,
      },
      {
        model: "deepseek-v4-flash",
        calls: 8,
        promptTokens: 8000,
        promptCacheHitTokens: 800,
        promptCacheMissTokens: 7200,
        completionTokens: 1600,
        totalTokens: 9600,
      },
    ]);
  });

  test("does not repeat raw provider financial rows in every DeepSeek prompt", async () => {
    const rawHeavyEvidence: EvidenceBundle = {
      ...evidence,
      facts: {
        quote: { regularMarketPrice: 10 },
        eastmoney: {
          quote: { code: "EXM" },
          incomeRows: [{ REPORT_DATE: "2025", RAW_FIELD_SENTINEL: "SHOULD_NOT_BE_SENT" }],
          cashflowRows: [{ REPORT_DATE: "2025", RAW_FIELD_SENTINEL: "SHOULD_NOT_BE_SENT" }],
          balanceRows: [{ REPORT_DATE: "2025", RAW_FIELD_SENTINEL: "SHOULD_NOT_BE_SENT" }],
        },
        sec: {
          cik: "0000000000",
          companyFacts: { RAW_FIELD_SENTINEL: "SHOULD_NOT_BE_SENT" },
          normalizedFinancialTenYear: {
            rows: [{ metric: "营业收入", values: { "2025": "100 亿美元" }, trend: "上升", interpretation: "规范化数据" }],
            interpretation: "SEC normalized table",
          },
        },
        financialTenYear: {
          rows: [{ metric: "营业收入", values: { "2025": "100 亿美元" }, trend: "上升", interpretation: "规范化数据" }],
          interpretation: "normalized table",
        },
      },
    };
    const fetchMock = mockSuccessfulReport();

    await callDeepSeekReport({ apiKey: "key", evidence: rawHeavyEvidence, fetchImpl: fetchMock });

    const userPrompts = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).messages[1].content as string);
    expect(userPrompts.join("\n")).not.toContain("SHOULD_NOT_BE_SENT");
    expect(userPrompts[0]).toContain("normalized table");
    expect(userPrompts[0]).toContain("statementRowCounts");
  });

  test("keeps long shared context before batch-specific detail and narrative keys to improve prefix caching", async () => {
    const fetchMock = mockSuccessfulReport();

    await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    const detailPayload = JSON.parse(JSON.parse(fetchMock.mock.calls[1][1].body).messages[1].content);
    const narrativePayload = JSON.parse(JSON.parse(fetchMock.mock.calls[5][1].body).messages[1].content);
    expect(Object.keys(detailPayload).indexOf("sharedContext")).toBeLessThan(Object.keys(detailPayload).indexOf("requestedItemIds"));
    expect(Object.keys(narrativePayload).indexOf("sharedContext")).toBeLessThan(Object.keys(narrativePayload).indexOf("requestedFullSectionKeys"));
  });

  test("keeps narrative prompt prefixes stable and sends section-specific score items after shared context", async () => {
    const fetchMock = mockSuccessfulReport();

    await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    const firstNarrativeBody = JSON.parse(fetchMock.mock.calls[5][1].body);
    const secondNarrativeBody = JSON.parse(fetchMock.mock.calls[6][1].body);
    const firstNarrativePayload = JSON.parse(firstNarrativeBody.messages[1].content);
    const secondNarrativePayload = JSON.parse(secondNarrativeBody.messages[1].content);
    expect(firstNarrativeBody.messages[0].content).toBe(secondNarrativeBody.messages[0].content);
    expect(firstNarrativePayload.sharedContext.scoringReport.scoreItems20).toBeUndefined();
    expect(firstNarrativePayload.requestedScoreItems.length).toBeLessThan(20);
    expect(firstNarrativePayload.requestedScoreItems.map((item: { id: string }) => item.id)).toContain("industryLifecycle");
    expect(secondNarrativePayload.requestedScoreItems.map((item: { id: string }) => item.id)).toContain("businessModelQuality");
    expect(firstNarrativePayload.sharedContext.evidence.facts).toBeUndefined();
  });

  test("enriches score item evidence and reasons in four small batches before narrative sections", async () => {
    const fetchMock = mockSuccessfulReport();

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(9);
    const firstDetailBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstDetailBody.messages[1].content).toContain("industryLifecycle");
    expect(report.scoreItems20[0].evidence).toHaveLength(3);
    expect(report.scoreItems20[0].deductions).toEqual(["行业生命周期与产业状态 主要扣分点"]);
    expect(report.scoreItems20[0].reason).toContain("不能因为公司知名度而给出模糊高分");
  });

  test("warms the first score detail and narrative batch before parallel follow-up batches", async () => {
    const detailDeferreds = detailBatches.map((batch) => deferredModelResponse(detailPayload(batch)));
    const narrativeDeferreds = narrativeBatches.map((batch) => deferredModelResponse(narrativePayload(batch)));
    let detailIndex = 0;
    let narrativeIndex = 0;
    const fetchMock = vi.fn((_: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.model === "deepseek-v4-pro") return Promise.resolve(modelResponse(reportPayload()));

      const userPayload = JSON.parse(body.messages[1].content);
      if (Array.isArray(userPayload.requestedItemIds)) return detailDeferreds[detailIndex++].promise;
      if (Array.isArray(userPayload.requestedFullSectionKeys)) return narrativeDeferreds[narrativeIndex++].promise;
      throw new Error("Unexpected DeepSeek request");
    });

    const reportPromise = callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock as typeof fetch });
    await nextTick();
    await nextTick();

    expect(detailIndex).toBe(1);
    expect(narrativeIndex).toBe(0);

    detailDeferreds[0].resolve();
    await nextTick();
    await nextTick();

    expect(detailIndex).toBe(4);
    detailDeferreds.slice(1).forEach((item) => item.resolve());
    await nextTick();
    await nextTick();

    expect(narrativeIndex).toBe(1);
    narrativeDeferreds[0].resolve();
    await nextTick();
    await nextTick();

    expect(narrativeIndex).toBe(4);

    narrativeDeferreds.slice(1).forEach((item) => item.resolve());
    const report = await reportPromise;

    expect(report.scoreItems20).toHaveLength(20);
    expect(report.fullSections.accountRules).toBe("完整仓位规则");
  });

  test("throws a user-facing error instead of returning a zero-score report when DeepSeek output is truncated", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: "length", message: { content: "" } }],
      }),
    });

    await expect(callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock })).rejects.toMatchObject({
      message: MODEL_OUTPUT_LENGTH_MESSAGE,
      code: "MODEL_OUTPUT_LENGTH",
    });
  });

  test("retries the scoring pass when DeepSeek returns incomplete JSON without a length finish reason", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ finish_reason: "stop", message: { content: `{"company":{"name":"Example Inc."},"scoreItems20":[` } }],
        }),
      })
      .mockResolvedValueOnce(modelResponse(reportPayload()));
    mockDetailBatches(fetchMock);
    mockNarrativeBatches(fetchMock);

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(report.company.name).toBe("Example Inc.");
    expect(report.scoreItems20).toHaveLength(20);
  });

  test("maps unrecoverable incomplete JSON to a Chinese retryable model error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: "stop", message: { content: `{"company":{"name":"Example Inc."},"scoreItems20":[` } }],
      }),
    });

    await expect(callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock })).rejects.toMatchObject({
      message: MODEL_OUTPUT_INVALID_JSON_MESSAGE,
      code: "MODEL_OUTPUT_INVALID_JSON",
      retryable: true,
    });
  });

  test("combines structured scoring and narrative sections without losing provider company identity", async () => {
    const maotaiEvidence: EvidenceBundle = {
      ...evidence,
      company: { name: "贵州茅台", ticker: "600519", market: "沪A", sector: "AStock" },
      evidence: [
        {
          title: "600519 Eastmoney financial statements",
          source: "Eastmoney",
          url: "https://example.com/600519",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(modelResponse(reportPayload({ company: { name: "贵州茅台" } })));
    mockDetailBatches(fetchMock);
    mockNarrativeBatches(fetchMock);

    const report = await callDeepSeekReport({ apiKey: "key", evidence: maotaiEvidence, fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(report.company).toMatchObject({ name: "贵州茅台", ticker: "600519", market: "沪A" });
    expect(report.scoreItems20).toHaveLength(20);
    expect(report.fullSections.onePageConclusion).toBe("完整一页结论");
    expect(report.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ title: "600519 Eastmoney financial statements" })]));
  });

  test("falls back to provider company identity when model omits company fields", async () => {
    const fetchMock = mockSuccessfulReport(reportPayload({ company: undefined }));

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    expect(report.company.name).toBe("Example Inc.");
    expect(report.company.ticker).toBe("EXM");
  });

  test("fills missing template sections with traceable fallback text", async () => {
    const fetchMock = mockSuccessfulReport(reportPayload({ company: { name: "Example Inc." }, sections: undefined }));

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    expect(report.sections.companyOverview).toBe("完整公司概况");
    expect(report.fullSections.companyOverview).toBe("完整公司概况");
  });

  test("repairs malformed JSON before schema validation", async () => {
    const malformed = JSON.stringify(reportPayload()).replace('},"asOf"', '}"asOf"');
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: "stop", message: { content: malformed } }],
      }),
    });
    mockDetailBatches(fetchMock);
    mockNarrativeBatches(fetchMock);

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    expect(report.company.name).toBe("Example Inc.");
    expect(report.sections.finalConclusion).toBe("完整最终结论");
  });

  test("retries a narrative batch with a stricter prompt when one section group is truncated", async () => {
    let firstNarrativeAttempts = 0;
    const fetchMock = vi.fn((_: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.model === "deepseek-v4-pro") return Promise.resolve(modelResponse(reportPayload()));
      const userPayload = JSON.parse(body.messages[1].content);
      if (Array.isArray(userPayload.requestedItemIds)) {
        return Promise.resolve(modelResponse(detailPayload(detailBatches.find((batch) => batch[0].id === userPayload.requestedItemIds[0]) ?? detailBatches[0])));
      }
      if (Array.isArray(userPayload.requestedFullSectionKeys)) {
        const keys = userPayload.requestedFullSectionKeys as string[];
        if (keys.includes("onePageConclusion") && firstNarrativeAttempts++ === 0) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              choices: [{ finish_reason: "length", message: { content: "" } }],
            }),
          });
        }
        return Promise.resolve(modelResponse(narrativePayload(keys)));
      }
      throw new Error("Unexpected DeepSeek request");
    });

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(report.fullSections.onePageConclusion).toBe("完整一页结论");
    expect(report.fullSections.accountRules).toBe("完整仓位规则");
  });

  test("splits narrative sections into single-section retries when a compact batch is still truncated", async () => {
    let finalBatchAttempts = 0;
    const fetchMock = vi.fn((_: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.model === "deepseek-v4-pro") return Promise.resolve(modelResponse(reportPayload()));
      const userPayload = JSON.parse(body.messages[1].content);
      if (Array.isArray(userPayload.requestedItemIds)) {
        return Promise.resolve(modelResponse(detailPayload(detailBatches.find((batch) => batch[0].id === userPayload.requestedItemIds[0]) ?? detailBatches[0])));
      }
      if (Array.isArray(userPayload.requestedFullSectionKeys)) {
        const keys = userPayload.requestedFullSectionKeys as string[];
        if (keys.includes("risks") && keys.length > 1 && finalBatchAttempts++ < 2) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              choices: [{ finish_reason: "length", message: { content: "" } }],
            }),
          });
        }
        return Promise.resolve(modelResponse(narrativePayload(keys)));
      }
      throw new Error("Unexpected DeepSeek request");
    });

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(13);
    expect(report.fullSections.risks).toBe("完整风险分析");
    expect(report.fullSections.finalConclusion).toBe("完整最终结论");
    expect(report.fullSections.accountRules).toBe("完整仓位规则");
  });

  test("splits score detail enrichment into single items when a five-item detail batch is truncated", async () => {
    let firstDetailBatchAttempts = 0;
    const fetchMock = vi.fn((_: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.model === "deepseek-v4-pro") return Promise.resolve(modelResponse(reportPayload()));
      const userPayload = JSON.parse(body.messages[1].content);
      if (Array.isArray(userPayload.requestedItemIds)) {
        const itemIds = userPayload.requestedItemIds as string[];
        const isFirstBatch = itemIds.includes(detailBatches[0][0].id) && itemIds.length > 1;
        if (isFirstBatch && firstDetailBatchAttempts++ < 2) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              choices: [{ finish_reason: "length", message: { content: "" } }],
            }),
          });
        }
        return Promise.resolve(modelResponse(detailPayload(SCORE_ITEMS_20.filter((item) => itemIds.includes(item.id)))));
      }
      if (Array.isArray(userPayload.requestedFullSectionKeys)) {
        return Promise.resolve(modelResponse(narrativePayload(userPayload.requestedFullSectionKeys)));
      }
      throw new Error("Unexpected DeepSeek request");
    });

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(15);
    expect(report.scoreItems20[0].evidence).toHaveLength(3);
    expect(report.scoreItems20[4].reason).toContain("不能因为公司知名度而给出模糊高分");
    expect(report.fullSections.finalConclusion).toBe("完整最终结论");
  });
});
