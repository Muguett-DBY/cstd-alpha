import { describe, expect, test } from "vitest";
import {
  ASSISTANT_CONTEXT_COMPACT_TOKEN_LIMIT,
  buildAssistantDeepSeekBody,
  buildAssistantPromptMessages,
  buildSiteEvidenceSummary,
  detectMemoryCandidate,
  estimateAssistantContextTokens,
  parseDeepSeekUsage,
  shouldCompactAssistantContext,
} from "./assistant-db";

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
    expect(messages[0].content).toContain("第一行必须以“结论：”开头");
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

  test("adds watchlist ranking scores to site evidence summary", async () => {
    const fakeDb = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes("FROM user_watchlist")) {
                  return { results: [{ company_name: "万科A", ticker: "000002", market: "深A" }] };
                }
                if (sql.includes("FROM watchlist_ranking_score")) {
                  return {
                    results: [
                      {
                        company_name: "宁德时代",
                        ticker: "300750",
                        market: "深A",
                        company_quality_score: 88,
                        investment_attractiveness_score: 82,
                        overall_score: 85,
                        verdict: "龙头质量高但估值需审慎",
                        summary: "证据包评分摘要",
                      },
                      {
                        company_name: "万科A",
                        ticker: "000002",
                        market: "深A",
                        company_quality_score: 18,
                        investment_attractiveness_score: 12,
                        overall_score: 15,
                        verdict: "严重危机，建议回避",
                        summary: "证据包评分摘要",
                      },
                    ],
                  };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const summary = await buildSiteEvidenceSummary(fakeDb, "admin");

    expect(summary).toContain("自选股排行");
    expect(summary).toContain("宁德时代(300750/深A) 综合85");
    expect(summary).toContain("低分/优先排雷=万科A(000002/深A) 综合15");
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

  test("keeps changing evidence and memory inside volatile assistant context", () => {
    const messages = buildAssistantPromptMessages({
      memories: [{ id: "m1", userKey: "admin", category: "preference", content: "先看现金流", status: "active", createdAt: "2026-05-25T00:00:00.000Z", updatedAt: "2026-05-25T00:00:00.000Z" }],
      threadSummary: "长期摘要会变",
      evidenceSummary: "站内证据会变",
      externalEvidenceSummary: "外部证据会变",
      recentMessages: [],
      userMessage: "测试",
      mode: "target",
    });

    const payload = JSON.parse(messages[1].content.replace(/^已确认长期记忆、线程摘要和站内证据如下：\n/, ""));
    expect(payload.outputRules).toBeDefined();
    expect(payload.siteEvidenceSummary).toBeUndefined();
    expect(payload.confirmedMemories).toBeUndefined();
    expect(payload.threadSummary).toBeUndefined();
    expect(payload.volatileContext.siteEvidenceSummary).toBe("站内证据会变");
    expect(payload.volatileContext.confirmedMemories).toEqual([{ category: "preference", content: "先看现金流" }]);
    expect(payload.volatileContext.threadSummary).toBe("长期摘要会变");
  });

  test("uses token-oriented context compaction thresholds instead of raw character count", () => {
    const chineseText = "茅台批价库存现金流反证条件".repeat(100);
    const englishText = "free cash flow margin inventory valuation risk ".repeat(100);

    expect(estimateAssistantContextTokens(chineseText)).toBeGreaterThan(400);
    expect(estimateAssistantContextTokens(englishText)).toBeGreaterThan(400);
    expect(shouldCompactAssistantContext("短对话", ASSISTANT_CONTEXT_COMPACT_TOKEN_LIMIT)).toBe(false);
    expect(shouldCompactAssistantContext("长期投研上下文".repeat(110_000), ASSISTANT_CONTEXT_COMPACT_TOKEN_LIMIT)).toBe(true);
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

  test("forbids invented quantitative thresholds in confirmation conditions", () => {
    const messages = buildAssistantPromptMessages({
      memories: [],
      threadSummary: "",
      evidenceSummary: "自选股排行：优必选综合40，澜起科技综合58。",
      recentMessages: [],
      userMessage: "根据我的自选股，哪些需要优先排雷？",
      mode: "chat",
    });
    const system = messages[0].content;

    expect(system).toContain("禁止自造“订单>500台”“渗透率>50%”“贡献>20%”");
    expect(system).toContain("判断主要依赖站内自选股排行、模板报告、模型评分或搜索线索");
  });
});
