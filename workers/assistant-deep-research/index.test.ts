import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildDeepResearchCandidateEnrichmentToolCalls, buildDeepResearchExecutionToolCalls, ensureDeepResearchAnswerCompleteness, sanitizeAssistantAStockTickerPairs } from "./index";
import type { AssistantDeepResearchWorkerJob } from "../../functions/_shared/assistant-deep-research";

describe("assistant deep research worker", () => {
  test("configures a single-message Queue consumer with an extended CPU budget", () => {
    const config = JSON.parse(readFileSync(resolve("workers/assistant-deep-research/wrangler.jsonc"), "utf8")) as {
      limits: { cpu_ms: number };
      queues: { consumers: Array<{ queue: string; max_batch_size: number }> };
    };

    expect(config.limits.cpu_ms).toBeGreaterThanOrEqual(300_000);
    expect(config.queues.consumers).toEqual([
      expect.objectContaining({
        queue: "cstd-alpha-assistant-deep-research",
        max_batch_size: 1,
      }),
    ]);
  });

  test("adds an auditable staged summary when a stopped job returns an incomplete answer", () => {
    const text = ensureDeepResearchAnswerCompleteness("主判断：中性观察", mockJob(), true, 3);

    expect(text).toContain("这是用户停止后的阶段性总结");
    expect(text).toContain("已整理证据摘要 | 3 条");
    expect(text).toContain("反证条件");
    expect(text).toContain("下一步跟踪");
  });

  test("does not append generic boilerplate to a normal incomplete recommendation answer", () => {
    const text = ensureDeepResearchAnswerCompleteness("推荐口径：优先选择AI产业链龙头。", {
      ...mockJob(),
      query: "从AI相关产业中推荐10支A股股票，10支美股股票",
      researchKind: "selection",
      status: "running",
      stopRequested: false,
    }, false, 8);

    expect(text).toBe("推荐口径：优先选择AI产业链龙头。");
    expect(text).not.toContain("若关键硬数据恶化，按保守情景处理");
  });

  test("normalizes a known company before collecting forecast evidence", () => {
    const calls = buildDeepResearchExecutionToolCalls(mockJob(), {
      siteEvidenceSummary: "",
      modeEvidenceSummary: "",
    });

    expect(calls.find((call) => call.name === "read_tencent_quote")?.query).toBe("600519");
    expect(calls.find((call) => call.name === "read_financial_statements")?.query).toBe("600519");
    expect(calls.find((call) => call.name === "read_filings_news")?.query).toBe("600519");
    expect(calls.find((call) => call.name === "read_tencent_quote")?.query).not.toContain("预测");
  });

  test("enriches discovered A-share selection candidates with quotes and financial statements", () => {
    const calls = buildDeepResearchCandidateEnrichmentToolCalls({
      ...mockJob(),
      query: "给我三家半导体/AI算力目前最值得买的公司",
      researchKind: "selection",
    }, [{
      source: "Tavily",
      query: "AI算力",
      title: "候选公司",
      summary: "中际旭创 300308、工业富联 601138、海光信息 688041 值得进一步核验。",
      url: "https://example.com/ai",
      content: "",
      sourceType: "news",
      signalType: "external_search",
      weight: 1,
      score: 1,
      freshness: "month",
    }]);

    expect(calls.map((call) => call.name)).toEqual(["read_tencent_quote", "read_financial_statements", "read_reports_concepts"]);
    expect(calls[0]?.query).toBe("300308,601138,688041");
  });

  test("splits candidate enrichment into batches accepted by the internal data tools", () => {
    const calls = buildDeepResearchCandidateEnrichmentToolCalls({
      ...mockJob(),
      query: "推荐八家A股AI公司",
      researchKind: "selection",
    }, [{
      source: "Tavily",
      query: "AI算力",
      title: "候选公司",
      summary: "候选代码 300308、601138、688041、688256、688008、002371、688012、603986。",
      url: "https://example.com/ai",
      content: "",
      sourceType: "news",
      signalType: "external_search",
      weight: 1,
      score: 1,
      freshness: "month",
    }]);

    expect(calls).toHaveLength(6);
    expect(calls.map((call) => call.query)).toEqual([
      "300308,601138,688041,688256,688008",
      "300308,601138,688041,688256,688008",
      "300308,601138,688041,688256,688008",
      "002371,688012,603986",
      "002371,688012,603986",
      "002371,688012,603986",
    ]);
  });

  test("corrects mismatched A-share tickers using verified quote evidence", () => {
    const text = sanitizeAssistantAStockTickerPairs(
      "1. 中际旭创 (002463.SZ)\n2. 工业富联 (601138.SH)",
      [{
        source: "CSTD Alpha",
        query: "300308,601138",
        title: "实时行情快照",
        summary: "中际旭创(300308) 价格123元；工业富联(601138) 价格45元",
        url: "",
        sourceType: "official",
        signalType: "external_search",
        weight: 3,
        score: 3,
        freshness: "today",
      }],
    );

    expect(text).toContain("中际旭创 (300308)");
    expect(text).toContain("工业富联 (601138)");
    expect(text).not.toContain("002463");
  });
});

function mockJob(): AssistantDeepResearchWorkerJob {
  return {
    id: "job-1",
    userKey: "admin",
    threadId: "thread-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    query: "茅台明年净利润预测",
    mode: "target",
    researchKind: "forecast",
    status: "stopping",
    progressTitle: "正在整理阶段性总结...",
    progressStage: "synthesize",
    progressCurrent: 3,
    progressTotal: 4,
    stopRequested: true,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}
