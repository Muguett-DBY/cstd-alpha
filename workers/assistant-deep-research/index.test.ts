import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildDeepResearchExecutionToolCalls, ensureDeepResearchAnswerCompleteness } from "./index";
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
