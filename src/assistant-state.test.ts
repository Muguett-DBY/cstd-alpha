import { describe, expect, test } from "vitest";
import { assistantCacheHitRate, mergeAssistantDeepResearchJobs, mergeAssistantDelta, stripInternalAssistantCompletion } from "./assistant-state";
import type { AssistantDeepResearchJob } from "./shared/assistant";

describe("assistant view state", () => {
  test("merges streamed deltas into one assistant draft", () => {
    expect(mergeAssistantDelta("结论：", "先观察。")).toBe("结论：先观察。");
  });

  test("calculates cache hit rate from DeepSeek usage", () => {
    expect(assistantCacheHitRate({ model: "deepseek-v4-flash", reasoningEffort: "high", promptCacheHitTokens: 80, promptCacheMissTokens: 20 })).toBe(80);
    expect(assistantCacheHitRate({ model: "deepseek-v4-flash", reasoningEffort: "high" })).toBeNull();
  });

  test("hides legacy internal system completion appendix from stored messages", () => {
    const text = [
      "你好，我是 CSTD Alpha 的私人投研助手。",
      "",
      "---",
      "",
      "系统补全：上方模型输出存在截断或缺少跟踪/反证项，以下为可审计的整理版。",
      "",
      "结论：你好 当前应输出低置信判断。",
    ].join("\n");

    expect(stripInternalAssistantCompletion(text)).toBe("你好，我是 CSTD Alpha 的私人投研助手。");
  });

  test("hides standalone legacy internal fallback answers", () => {
    const text =
      "结论：把贵州茅台的上行空间和下行风险做成表。 当前应输出低置信判断，而不是停止回答。 证据等级：低。可用证据只够形成方向性判断，不能形成高置信投资结论。 核心理由：先列出已知事实，再给最可能解释、反证条件和需要补齐的数据。 反驳用户观点：如果用户把单一新闻、单家公司样本或概念叙事当作充分证据，这个逻辑不成立。 我可能错在哪里：若最新公告、官方统计或公司级硬数据已经更新，本轮判断可能被推翻。 下一步跟踪：补公司公告、财务指标、行业价格/销量/库存/订单、竞争格局和政策变化。";

    expect(stripInternalAssistantCompletion(text)).toBe("");
  });

  test("does not let stale deep research metadata regress live job status", () => {
    const completed = deepResearchJob({ status: "completed", updatedAt: "2026-06-01T08:00:00.000Z" });
    const queuedFromMessageMetadata = deepResearchJob({ status: "queued", updatedAt: "2026-06-01T07:50:00.000Z" });

    const merged = mergeAssistantDeepResearchJobs({ job1: completed }, [queuedFromMessageMetadata]);

    expect(merged.job1.status).toBe("completed");
  });

  test("keeps deep research status moving forward during polling", () => {
    const queued = deepResearchJob({ status: "queued", updatedAt: "2026-06-01T07:50:00.000Z" });
    const running = deepResearchJob({ status: "running", updatedAt: "2026-06-01T07:51:00.000Z" });

    const merged = mergeAssistantDeepResearchJobs({ job1: queued }, [running]);

    expect(merged.job1.status).toBe("running");
  });
});

function deepResearchJob(overrides: Partial<AssistantDeepResearchJob>): AssistantDeepResearchJob {
  return {
    id: "job1",
    threadId: "thread1",
    query: "茅台预测",
    mode: "chat",
    researchKind: "forecast",
    status: "queued",
    progressTitle: "正在排队...",
    progressStage: "queued",
    progressCurrent: 0,
    progressTotal: 4,
    stopRequested: false,
    createdAt: "2026-06-01T07:50:00.000Z",
    updatedAt: "2026-06-01T07:50:00.000Z",
    ...overrides,
  };
}
