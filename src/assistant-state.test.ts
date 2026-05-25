import { describe, expect, test } from "vitest";
import { assistantCacheHitRate, mergeAssistantDelta, stripInternalAssistantCompletion } from "./assistant-state";

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
});
