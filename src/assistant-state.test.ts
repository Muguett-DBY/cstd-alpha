import { describe, expect, test } from "vitest";
import { assistantCacheHitRate, mergeAssistantDelta } from "./assistant-state";

describe("assistant view state", () => {
  test("merges streamed deltas into one assistant draft", () => {
    expect(mergeAssistantDelta("结论：", "先观察。")).toBe("结论：先观察。");
  });

  test("calculates cache hit rate from DeepSeek usage", () => {
    expect(assistantCacheHitRate({ model: "deepseek-v4-flash", reasoningEffort: "high", promptCacheHitTokens: 80, promptCacheMissTokens: 20 })).toBe(80);
    expect(assistantCacheHitRate({ model: "deepseek-v4-flash", reasoningEffort: "high" })).toBeNull();
  });
});
