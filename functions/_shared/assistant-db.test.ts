import { describe, expect, test } from "vitest";
import { buildAssistantDeepSeekBody, buildAssistantPromptMessages, detectMemoryCandidate, parseDeepSeekUsage } from "./assistant-db";

describe("assistant prompt and memory helpers", () => {
  test("keeps stable rules and memory before volatile user message", () => {
    const messages = buildAssistantPromptMessages({
      memories: [{ id: "m1", content: "偏好：先看现金流。", category: "preference", status: "active", createdAt: "2026-05-24T00:00:00.000Z", updatedAt: "2026-05-24T00:00:00.000Z" }],
      threadSummary: "此前讨论过白酒估值纪律。",
      evidenceSummary: "雷达：光伏衰退，存储观察。",
      recentMessages: [{ role: "assistant", content: "上轮结论", createdAt: "2026-05-24T00:01:00.000Z" }],
      userMessage: "宁德时代现在怎么看？",
    });

    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("结论");
    expect(messages[1].content).toContain("已确认长期记忆");
    expect(messages[1].content).toContain("偏好：先看现金流");
    expect(messages[1].content).not.toContain("上轮结论");
    expect(messages[2]).toMatchObject({ role: "assistant", content: "上轮结论" });
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "宁德时代现在怎么看？" });
  });

  test("creates pending memory candidates only for explicit teaching language", () => {
    expect(detectMemoryCandidate("记住：以后分析白酒先看批价和库存。")).toMatchObject({
      category: "preference",
      status: "pending",
    });
    expect(detectMemoryCandidate("贵州茅台现在贵不贵？")).toBeNull();
  });

  test("normalizes DeepSeek cache usage metrics", () => {
    expect(
      parseDeepSeekUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 70,
        prompt_cache_miss_tokens: 30,
      }),
    ).toMatchObject({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      promptCacheHitTokens: 70,
      promptCacheMissTokens: 30,
    });
  });

  test("requests streaming usage so cache hit metrics can be recorded", () => {
    const body = buildAssistantDeepSeekBody([{ role: "user", content: "test" }]);

    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning_effort: "max",
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  test("includes a long stable cache anchor before volatile chat data", () => {
    const messages = buildAssistantPromptMessages({
      memories: [],
      threadSummary: "",
      evidenceSummary: "暂无证据。",
      recentMessages: [],
      userMessage: "测试",
    });

    expect(messages[0].content.length).toBeGreaterThan(10_000);
    expect(messages[0].content.indexOf("CSTD Alpha assistant cache anchor")).toBeLessThan(messages[0].content.indexOf("你是 CSTD Alpha"));
  });

  test("hardens rebuttal answers against overclaiming search evidence", () => {
    const messages = buildAssistantPromptMessages({
      memories: [],
      threadSummary: "",
      evidenceSummary: "站内证据：银行股证据薄。",
      externalEvidenceSummary: "外部搜索线索：E1 海外银行股息削减案例。",
      recentMessages: [],
      userMessage: "如果我认为银行股是稳赚高股息，你反驳我。",
      mode: "industry",
    });
    const system = messages[0].content;

    expect(system).toContain("不能因为 Exa/AnySearch/SearXNG 返回多条新闻或海外案例就写“证据等级：高”");
    expect(system).toContain("最高只能写“中”");
    expect(system).toContain("高股息策略可能合理，但“稳赚/无风险/必然赚钱”必须明确反驳");
    expect(system).toContain("禁止输出空标题或空章节");
  });
});
