import { describe, expect, test, vi } from "vitest";
import { buildAssistantEvidenceQueries, onRequestPost, resolveAssistantResearchContext, shouldAnswerDirectlyWithoutClarification, shouldAutoUseResearchEvidence, shouldIncludeRecentAssistantContext, shouldTreatAsSimpleGeneralChat, shouldTriggerExternalEvidence, shouldUseExaForAssistant } from "./chat";

describe("assistant chat endpoint", () => {
  test("rejects non-admin users before calling DeepSeek", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", { method: "POST", headers: { cookie: "cstd_alpha_session=session-1.token" }, body: JSON.stringify({ message: "hi" }) }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "user" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("streams with DeepSeek Flash max and records cache usage", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "结论：" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "先观察。" } }], usage: { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, total_tokens: 150 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "自由现金流为什么比利润更适合看长期回报？" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("usage");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.model).toBe("deepseek-v4-flash");
    expect(requestBody.reasoning_effort).toBe("max");
    expect(requestBody.stream).toBe(true);
  });

  test("does not append internal system completion text to short normal chat replies", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "你好，我是 CSTD Alpha 的私人投研助手。" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(stream, { status: 200 })));

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "用一句话解释自由现金流为什么重要。", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("私人投研助手");
    expect(body).not.toContain("系统补全");
    expect(body).not.toContain("当前应输出低置信判断");
  });

  test("treats greeting and identity questions as simple chat without research fallback", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "你好，我是 CSTD Alpha 的私人投研助手。" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "你好，你是？", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain("私人投研助手");
    expect(body).not.toContain("补充框架");
    expect(body).not.toContain("当前应输出低置信判断");
  });

  test("memory-only teaching messages create a candidate without calling DeepSeek", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "记住：以后分析白酒先看批价和库存。", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(body).toContain("memory_candidate");
    expect(body).toContain("待确认记忆");
    expect(body).toContain("不会影响正式投研结论");
    expect(body).toContain("done");
  });

  test("returns a model-generated choice request without starting the final answer call", async () => {
    const choiceRequest = {
      id: "cr-1",
      title: "先确认研究口径",
      question: "你希望我优先按哪种口径回答？",
      reason: "这个问题缺少时间维度，直接回答容易混淆。",
      customPlaceholder: "例如：按三年持有，先看现金流和估值。",
      options: [
        { id: "long-term", label: "长期投资视角", description: "看商业质量、现金流、估值和反证。", recommended: true },
        { id: "risk", label: "先排雷", description: "先找财务、行业和治理风险。" },
        { id: "catalyst", label: "短期催化", description: "看订单、财报和资金催化。" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ needClarification: true, request: choiceRequest }) } }],
          usage: { prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 10, total_tokens: 80 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "这个能买吗？" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain("choice_request");
    expect(body).toContain("先确认研究口径");
    expect(body).not.toContain("delta");
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.stream).toBe(false);
    expect(requestBody.response_format).toEqual({ type: "json_object" });
  });

  test("forces a clarification choice for ambiguous buy/sell action questions even if the model under-asks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ needClarification: false }) } }],
          usage: { prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 10, total_tokens: 80 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "这个能买吗？", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain("choice_request");
    expect(body).toContain("持有周期");
    expect(body).not.toContain("delta");
  });

  test("forces clarification for short subject-only industry prompts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ needClarification: false }) } }], usage: { total_tokens: 80 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "半导体呢？", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain("choice_request");
    expect(body).toContain("机会与风险");
  });

  test("target research mode uses non-stream answer and rational review before returning", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "结论：可以买，逻辑很强。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    passed: false,
                    revisedAnswer: "结论：当前只能列为观察，不能直接说可以买。\n证据等级：弱。\n反驳用户观点：如果用户认为只因龙头地位就能买，这个逻辑不充分。\n我可能错在哪里：若后续财报和估值证据同时改善，可以上调判断。",
                  }),
                },
              },
            ],
            usage: { total_tokens: 80 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "宁德时代长期投资价值怎么判断？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body).toContain("当前只能列为观察");
    expect(body).toContain("done");
    const answerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(answerBody.stream).toBe(false);
    expect(JSON.stringify(answerBody.messages)).toContain("研究模式：标的研究");
    const reviewBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(JSON.stringify(reviewBody.messages)).toContain("理性审查器");
  });

  test("rational review repairs moat answers missing counter and follow-up sections", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "结论：观察。\n证据等级：中。\n核心理由：品牌强，但渠道承压。" } }],
            usage: { total_tokens: 120 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    passed: false,
                    revisedAnswer:
                      "结论：观察。\n证据等级：中。\n核心理由：品牌心智仍强，但批价和渠道库存削弱短期护城河厚度。\n反驳用户观点：不能只因历史品牌溢价就认为护城河没有变化。\n我可能错在哪里：若批价回升且直营利润率改善，护城河收窄判断应下修。\n下一步跟踪：批价、直营占比、库存、毛利率。",
                  }),
                },
              },
            ],
            usage: { total_tokens: 80 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "茅台护城河是不是变窄了？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body).toContain("不能只因历史品牌溢价");
    expect(body).toContain("下一步跟踪");
  });

  test("adds minimum research sections when reviewed answer is still truncated", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "结论：关键反证是大客户自研芯片侵蚀GPU份额。\n证据等级：中。外部证据 E8" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true, revisedAnswer: "结论：关键反证是大客户自研芯片侵蚀GPU份额。\n证据等级：中。外部证据 E8" }) } }], usage: { total_tokens: 80 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "英伟达未来两年最关键的反证是什么？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("下一步跟踪");
  });

  test("comparison answers are framed as relative judgments, not single-stock hold calls", async () => {
    const answer = "结论：贵州茅台相对五粮液长期回报更稳，但五粮液估值弹性可能更高。\n证据等级：中。\n核心理由：贵州茅台品牌和现金流更强，五粮液受渠道和批价波动影响更大。\n反驳用户观点：不能把单一低估值当作更稳。\n我可能错在哪里：若五粮液库存去化和批价回升更快，弹性会改善。\n下一步跟踪：两者批价、库存、合同负债和自由现金流。";
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url, init) => {
        const requestBody = JSON.parse(String(init?.body ?? "{}"));
        if (requestBody.stream === false) {
          return new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { total_tokens: 120 } }), { status: 200 });
        }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }], usage: { total_tokens: 120 } })}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "贵州茅台和五粮液长期回报谁更稳？请列表对比。", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("相对");
    expect(body).toContain("五粮液");
    expect(body).not.toContain("结论：持有");
  });

  test("compacts long target research threads after non-stream answers", async () => {
    const longAnswer = [
      "结论：长期线程需要压缩，但必须保留投资规则、证据边界和反证条件。",
      "证据等级：中。",
      `核心理由：${"现金流、估值、行业周期、反证条件。".repeat(110_000)}`,
      "反驳用户观点：不能只因龙头地位给高分。",
      "我可能错在哪里：若证据更新，结论要重算。",
      "下一步跟踪：财报、价格、库存、订单。",
    ].join("\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: longAnswer } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const db = mockDb({ role: "admin" });

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "宁德时代长期投资价值怎么判断？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: db,
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    await response.text();
    expect((db as unknown as { __state: { sql: string[] } }).__state.sql.some((sql) => sql.includes("UPDATE assistant_threads SET summary"))).toBe(true);
  });

  test("emits table and chart blocks when assistant returns a markdown table", async () => {
    const answer = [
      "结论：先观察。",
      "| 指标 | 2025 | 2026 |",
      "| --- | --- | --- |",
      "| 营收同比 | 12% | 18% |",
      "| 净利润同比 | -5% | 9% |",
    ].join("\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "宁德时代：请画图对比营收和净利润", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("\"type\":\"block\"");
    expect(body).toContain("\"type\":\"table\"");
    expect(body).toContain("\"type\":\"chart\"");
  });

  test("removes empty research headings from assistant output", async () => {
    const answer = [
      "结论：高股息可以是策略，但不是稳赚。",
      "",
      "### 反驳用户观点（过度乐观部分）",
      "",
      "---",
      "",
      "### 我可能错在哪里（反证条件）",
      "",
      "---",
      "",
      "### 下一步跟踪",
      "",
      "---",
      "",
      "最终重申：股息收益需要和本金波动一起看。",
    ].join("\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "如果我认为银行股是稳赚高股息，你反驳我。", mode: "industry" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("高股息可以是策略");
    expect(body).toContain("最终重申");
    expect(body).not.toContain("反驳用户观点");
    expect(body).not.toContain("我可能错在哪里（反证条件）");
    expect(body).not.toContain("下一步跟踪");
  });

  test("caps high evidence grade when answer relies on Exa and overseas analogies", async () => {
    const answer = [
      "结论：反对银行股稳赚高股息。",
      "证据等级：高（以下证据来自 Exa 检索的多地区银行季报、S&P 报告及行业新闻，覆盖美国、GCC、印度等市场。）",
      "核心理由：海外银行案例说明股息可能因资本压力被削减。",
      "| 维度 | 证据 | 含义 |",
      "| --- | --- | --- |",
      "| 股息 | GCC银行可能削减股息 | 高股息不是无风险 |",
    ].join("\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "如果我认为银行股是稳赚高股息，你反驳我。", mode: "industry" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("证据等级：中");
    expect(body).not.toContain("证据等级：高");
  });

  test("caps forecast confidence and removes stale history phrasing", async () => {
    const answer = [
      "结论：维持此前测算口径，2026年全年归母净利润区间为800-870亿元。本次无新增站内证据或外部检索信息修正此前判断。",
      "证据等级：中至高（Q1财报为硬事实，券商预测为外部推断。）",
    ].join("\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "根据现有信息和数据预测贵州茅台今年净利润区间。", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("证据等级：中");
    expect(body).not.toContain("中至高");
    expect(body).not.toContain("维持此前测算口径");
    expect(body).not.toContain("本次无新增站内证据");
  });

  test("uses Exa only for high-value weak-evidence research and respects quota storage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_exa_1",
                      type: "function",
                      function: { name: "search_exa", arguments: JSON.stringify({ query: "CATL overseas policy risk", maxResults: 5 }) },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ requestId: "exa_req", results: [{ title: "CATL overseas risk", url: "https://example.com/catl", highlights: ["海外竞争和政策风险。"] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "结论：Exa无可用结果，先观察。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const kv = mockKv();

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "宁德时代海外竞争和政策风险最新怎么看？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        EXA_API_KEY: "exa-key",
        REPORT_CACHE: kv,
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("done");
    expect(body).toContain("Exa返回了外部线索");
    expect(body).not.toContain("Exa无可用结果");
    expect(fetchMock.mock.calls.some((call) => call[0] === "https://api.exa.ai/search")).toBe(true);
    expect(kv.put).toHaveBeenCalled();
  });

  test("lets DeepSeek tool calls choose external search without explicit search wording", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_search_1",
                      type: "function",
                      function: {
                        name: "search_anysearch",
                        arguments: JSON.stringify({ query: "贵州茅台 2026 全年净利润 业绩预测 批价 渠道", freshness: "month", reason: "需要最新外部预测和批价线索" }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { total_tokens: 55, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 35 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ title: "贵州茅台业绩预测和批价跟踪", url: "https://example.com/maotai", description: "券商预测增速低个位数，批价仍需跟踪。", score: 0.9 }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "结论：低个位数增长更合理。\n证据等级：中低。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "茅台今年业绩预估？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        ANYSEARCH_API_KEY: "any-key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    const routerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(routerBody.tools?.[0]?.function?.name).toBe("search_anysearch");
    expect(routerBody.tool_choice).toBe("auto");
    expect(fetchMock.mock.calls.some((call) => call[0] === "https://api.anysearch.com/v1/search")).toBe(true);
    expect(body).toContain("模型调用工具");
    expect(body).toContain("AnySearch");
  });

  test("lets the model call keyless GDELT and caps evidence grade from global news search", async () => {
    const answer = [
      "结论：全球新闻线索显示海外政策风险值得跟踪。",
      "证据等级：高（来自 GDELT 全球新闻搜索和市场新闻，多地区覆盖。）",
      "核心理由：政策限制和海外供应链新闻频繁出现。",
    ].join("\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_gdelt_1",
                      type: "function",
                      function: {
                        name: "search_gdelt",
                        arguments: JSON.stringify({ query: "CATL overseas policy risk global news", freshness: "week", reason: "需要免费全球新闻补召回" }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { total_tokens: 55 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ articles: [{ title: "Battery policy risk", url: "https://example.com/battery-risk", seendate: "20260524T100000Z", domain: "example.com" }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "宁德时代海外政策风险最新怎么看？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    const routerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const toolNames = routerBody.tools.map((item: { function: { name: string } }) => item.function.name);
    expect(toolNames).toContain("search_gdelt");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith("https://api.gdeltproject.org/api/v2/doc/doc?"))).toBe(true);
    expect(body).toContain("GDELT");
    expect(body).toContain("证据等级：中");
    expect(body).not.toContain("证据等级：高");
  });

  test("falls back to free academic search for technical investment questions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.deepseek.com/chat/completions") {
        const callIndex = fetchMock.mock.calls.filter((call) => String(call[0]) === "https://api.deepseek.com/chat/completions").length;
        if (callIndex === 1) return new Response(JSON.stringify({ choices: [{ message: { content: "不需要搜索" } }] }), { status: 200 });
        if (callIndex === 2) return new Response(JSON.stringify({ choices: [{ message: { content: "结论：优必选大脑小脑协同仍需看实时控制和规划系统闭环。\n证据等级：中。\n核心理由：学术线索只能证明技术路线，不证明公司已经领先。" } }], usage: { total_tokens: 120 } }), { status: 200 });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 });
      }
      if (url.startsWith("https://export.arxiv.org/api/query?")) {
        return new Response("<feed><entry><id>http://arxiv.org/abs/2605.12345v1</id><title>Humanoid robot planning and control</title><summary>Coordinating high-level planning with low-level control.</summary><published>2026-05-20T00:00:00Z</published></entry></feed>", { status: 200 });
      }
      if (url.startsWith("https://api.semanticscholar.org/graph/v1/paper/search?")) {
        return new Response(JSON.stringify({ data: [{ title: "Whole-body control for humanoids", url: "https://www.semanticscholar.org/paper/1", abstract: "Control and planning coordination.", year: 2026 }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ articles: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "优必选人形机器人，大脑与小脑之间的协调性如何？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith("https://export.arxiv.org/api/query?"))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith("https://api.semanticscholar.org/graph/v1/paper/search?"))).toBe(true);
    expect(body).toContain("学术线索");
    expect(body).toContain("证据等级：中");
  });

  test("turns evidence-gap table requests into a usable comparison table", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.deepseek.com/chat/completions") {
        const callIndex = fetchMock.mock.calls.filter((call) => String(call[0]) === "https://api.deepseek.com/chat/completions").length;
        if (callIndex === 1) return new Response(JSON.stringify({ choices: [{ message: { content: "不需要搜索" } }] }), { status: 200 });
        if (callIndex === 2) return new Response(JSON.stringify({ choices: [{ message: { content: "证据不足，无法回答。" } }], usage: { total_tokens: 120 } }), { status: 200 });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 });
      }
      if (url.startsWith("https://api.gdeltproject.org/api/v2/doc/doc?")) return new Response(JSON.stringify({ articles: [] }), { status: 200 });
      if (url.startsWith("https://export.arxiv.org/api/query?")) return new Response("<feed></feed>", { status: 200 });
      if (url.startsWith("https://api.semanticscholar.org/graph/v1/paper/search?")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "画表比较AI服务器产业链里光模块、PCB、液冷、存储这四个环节的景气度、证据强度和风险。", mode: "industry" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("| 环节 |");
    expect(body).toContain("光模块");
    expect(body).toContain("PCB");
    expect(body).toContain("液冷");
    expect(body).toContain("\"type\":\"block\"");
  });

  test("turns evidence-gap driver questions into a concrete driver comparison", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "证据不足，无法判断。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "港股互联网现在投资吸引力来自利润修复、回购还是估值修复？反驳过度乐观观点。", mode: "industry" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("主导驱动");
    expect(body).toContain("利润修复");
    expect(body).toContain("回购");
    expect(body).toContain("估值修复");
    expect(body).toContain("过度乐观");
  });

  test("turns evidence-gap supply-chain realization questions into a concrete ranking", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "不需要搜索" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ articles: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("<feed></feed>", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "证据不足，无法判断。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "人形机器人产业链哪些环节最可能先兑现业绩？不要只讲概念。", mode: "industry" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("兑现顺序");
    expect(body).toContain("执行器");
    expect(body).toContain("精密零部件");
    expect(body).toContain("整机");
    expect(body).not.toContain("不能只停在“资料不够”");
  });

  test("removes customer-service preambles from research answers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "好的，收到您的指令。作为 CSTD Alpha 的私人投研助手，我将严格分析。\n\n结论：港股互联网需要看利润修复、回购和估值修复。\n证据等级：中。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "港股互联网现在投资吸引力来自利润修复、回购还是估值修复？", mode: "industry" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).not.toContain("好的，收到");
    expect(body).not.toContain("私人投研助手");
    expect(body).toContain("结论：港股互联网");
  });

  test("falls back to search tools when router under-selects a clear research question", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "不需要搜索" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ requestId: "exa_req", results: [{ title: "SMIC mature node value", url: "https://example.com/smic", highlights: ["成熟制程国产替代。"] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "结论：观察。\n证据等级：中。\n反证：若制裁加码则下修。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "中芯国际在先进制程受限下还有哪些投资价值？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        EXA_API_KEY: "exa-key",
        REPORT_CACHE: mockKv(),
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock.mock.calls.some((call) => call[0] === "https://api.exa.ai/search")).toBe(true);
    expect(body).toContain("模型调用工具");
  });

  test("classifies Exa high-value trigger conservatively", () => {
    expect(shouldUseExaForAssistant("宁德时代海外竞争和政策风险最新怎么看？", "target", "公司证据包：未命中")).toEqual(
      expect.objectContaining({ use: true }),
    );
    expect(shouldUseExaForAssistant("茅台今年净利润业绩预估？", "target", "公司证据包：未命中")).toEqual(expect.objectContaining({ use: true }));
    expect(shouldUseExaForAssistant("苹果AI硬件周期对A股消费电子有什么影响？", "industry", "行业证据包：证据不足")).toEqual(expect.objectContaining({ use: true }));
    expect(shouldUseExaForAssistant("简单总结一下", "chat", "站内证据充足")).toEqual(expect.objectContaining({ use: false }));
  });

  test("auto-detects target research in normal chat for forecasts and technical questions", () => {
    expect(shouldAutoUseResearchEvidence("茅台今年业绩预估？")).toBe(true);
    expect(shouldAutoUseResearchEvidence("优必选人形机器人，大脑与小脑之间的协调性如何？")).toBe(true);
    expect(shouldAutoUseResearchEvidence("中芯国际在先进制程受限下还有哪些投资价值？")).toBe(true);
    expect(shouldAutoUseResearchEvidence("用一句话解释自由现金流")).toBe(false);
  });

  test("answers clear research questions directly without a clarification round", () => {
    expect(shouldAnswerDirectlyWithoutClarification("茅台今年业绩预估？")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("优必选人形机器人，大脑与小脑之间的协调性如何？")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("如果我认为光伏已经到底了，你反驳我。")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("宁德时代现在能买吗？")).toBe(false);
    expect(shouldAnswerDirectlyWithoutClarification("宁德时代能买吗？")).toBe(false);
  });

  test("resolves follow-up questions to the previous user research subject", () => {
    const resolved = resolveAssistantResearchContext("根据现有信息和数据进行预测", [
      { role: "user", content: "茅台今年业绩预估？" },
      { role: "assistant", content: "历史回答里的数字不能当事实证据。" },
    ]);
    expect(resolved.message).toContain("茅台今年业绩预估");
    expect(resolved.promptMessage).toContain("对话承接");
  });

  test("does not treat standalone concept explanations as follow-up research", () => {
    const resolved = resolveAssistantResearchContext("用两句话解释自由现金流为什么比利润更适合看长期回报。", [
      { role: "user", content: "万科现在是不是困境反转？" },
      { role: "assistant", content: "结论：观察。" },
    ]);
    expect(resolved.message).toBe("用两句话解释自由现金流为什么比利润更适合看长期回报。");
    expect(resolved.promptMessage).not.toContain("对话承接");
  });

  test("triggers external evidence for high-value chat research even without explicit search wording", () => {
    expect(shouldTriggerExternalEvidence("茅台今年业绩预估？", "target", "公司证据包：未命中")).toBe(true);
    expect(shouldTriggerExternalEvidence("优必选人形机器人技术优势是什么？", "target", "站内证据不足")).toBe(true);
    expect(shouldTriggerExternalEvidence("解释自由现金流", "chat", "站内证据充足")).toBe(false);
  });

  test("uses recent chat context only for explicit follow-up wording", () => {
    expect(shouldIncludeRecentAssistantContext("根据现有信息和数据预测贵州茅台今年净利润区间。")).toBe(false);
    expect(shouldIncludeRecentAssistantContext("优必选人形机器人，大脑与小脑之间的协调性如何？")).toBe(false);
    expect(shouldIncludeRecentAssistantContext("那它的反证条件是什么？")).toBe(true);
    expect(shouldIncludeRecentAssistantContext("继续上面那个问题，给我表格。")).toBe(true);
  });

  test("does not route simple concept explanations through external tools", () => {
    expect(shouldTreatAsSimpleGeneralChat("用两句话解释自由现金流为什么比利润更适合看长期回报。", "chat")).toBe(true);
    expect(shouldTreatAsSimpleGeneralChat("用两句话解释ROIC为什么比ROE更不容易被杠杆误导。", "chat")).toBe(true);
    expect(shouldTreatAsSimpleGeneralChat("茅台今年业绩预估？", "target")).toBe(false);
    expect(shouldTreatAsSimpleGeneralChat("请联网查一下自由现金流最新研究", "chat")).toBe(false);
  });

  test("builds layered evidence queries instead of one mixed search query", () => {
    const forecastQueries = buildAssistantEvidenceQueries("茅台今年业绩预估？", "target");
    expect(forecastQueries.length).toBeGreaterThanOrEqual(3);
    expect(forecastQueries.map((item) => item.query).join("\n")).toContain("业绩预告");
    expect(forecastQueries.map((item) => item.query).join("\n")).toContain("批价");
    expect(forecastQueries.every((item) => item.maxResults && item.maxResults <= 4)).toBe(true);

    const technicalQueries = buildAssistantEvidenceQueries("优必选人形机器人，大脑与小脑之间的协调性如何？", "target");
    expect(technicalQueries.map((item) => item.query).join("\n")).toContain("技术");
    expect(technicalQueries.map((item) => item.query).join("\n")).toContain("产品");
  });

  test("rational review rewrites evidence-only refusal into a useful scenario answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "结论：证据不足，无法给出净利润预测。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    passed: false,
                    revisedAnswer:
                      "结论：只能做低置信情景测算，不应停在无法预测。\n证据等级：低。\n核心理由：基于现有季度增速和批价压力，给保守、中性、乐观三个净利润增速区间。\n反驳用户观点：单看品牌力不足以推出高增长。\n我可能错在哪里：若批价和直营占比改善，区间需上修。\n下一步跟踪：半年报、批价、库存和渠道反馈。",
                  }),
                },
              },
            ],
            usage: { total_tokens: 80 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "茅台今年业绩预估？" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("低置信情景测算");
    expect(body).not.toContain("无法给出净利润预测");
  });

  test("removes stale-history wording from clear technical research answers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "不需要搜索" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ articles: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("<feed><entry><id>http://arxiv.org/abs/2605.1</id><title>Humanoid planning control</title><summary>Planning and control coordination.</summary><published>2026-05-20T00:00:00Z</published></entry></feed>", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ title: "Humanoid robot coordination", url: "https://www.semanticscholar.org/paper/1", abstract: "Brain and controller coordination.", year: 2026 }] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "结论：当前无新增证据，此前结论保持不变——优必选大脑和小脑已贯通，但仍需第三方验证。" } }],
            usage: { total_tokens: 120 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "优必选人形机器人，大脑与小脑之间的协调性如何？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("本轮判断");
    expect(body).not.toContain("此前结论保持不变");
    expect(body).not.toContain("当前无新增证据");
  });

  test("downgrades unaudited forecast wording in auto research answers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "结论：2025年实际值为100亿元，2026年预测为105亿元。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "茅台今年净利润业绩预估？" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("口径说明");
    expect(body).toContain("2025年基数线索");
    expect(body).not.toContain("2025年实际值");
  });

  test("downgrades unaudited strong fact wording", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "结论：上市25年首次业绩双降，且2025年营收利润首次双降，风险明显。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "画一个表对比茅台、五粮液、泸州老窖的核心风险。", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("业绩承压待核验线索");
    expect(body).toContain("营收和利润承压待核验线索");
    expect(body).not.toContain("上市25年首次业绩双降");
    expect(body).not.toContain("营收利润首次双降");
  });

  test("keeps a full research answer when rational review returns a short fragment", async () => {
    const longAnswer = [
      "结论：泡泡玛特长期风险不能只看IP生命周期，还要看海外渠道和估值消化。",
      "证据等级：中。",
      "核心理由：公司增长来自IP矩阵、渠道扩张和海外市场，但这些变量需要持续验证。",
      "反驳用户观点：如果只把风险归因于单个IP老化，会低估海外扩张、渠道库存和估值下修的影响。",
      "我可能错在哪里：如果公司持续孵化新IP并保持高复购，生命周期风险会被分散。",
      "下一步跟踪：关注海外收入占比、门店坪效、库存周转、毛利率和新品复购率。",
    ].join("\n").repeat(6);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: longAnswer } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ passed: false, revisedAnswer: "结论：反对该观点。证据等级：高。外部证据显示核心挑战" }) } }],
            usage: { total_tokens: 30 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "泡泡玛特最大的长期风险是IP生命周期吗？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    const doneLine = body.split("\n").find((line) => line.startsWith("data: ") && line.includes('"type":"done"'));
    const done = doneLine ? JSON.parse(doneLine.slice(6)) as { message?: { content?: string } } : {};
    expect(body).toContain("海外渠道和估值消化");
    expect(done.message?.content).not.toContain("外部证据显示核心挑战");
  });

  test("does not spend a second model call reviewing a complete research answer", async () => {
    const completeAnswer = [
      "结论：宁德时代当前更适合观察，核心变量是海外订单、储能毛利率和资本开支纪律。",
      "证据等级：中。站内证据能证明公司基本面仍强，但估值和现金流仍需继续核验。",
      "核心理由：动力电池龙头地位仍在，储能需求提供第二增长曲线；但价格竞争和资本开支会压制自由现金流。",
      "反驳用户观点：如果只因为公司是龙头就认为可以买，忽略了估值、行业价格战和现金流压力。",
      "我可能错在哪里：如果新一季财报显示毛利率和经营现金流同时改善，投资吸引力应上调。",
      "下一步跟踪：毛利率、经营现金流、储能出货、海外订单、资本开支和估值分位。",
    ].join("\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: completeAnswer } }], usage: { prompt_cache_hit_tokens: 9000, prompt_cache_miss_tokens: 600, total_tokens: 10000 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "宁德时代现在能买吗？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        DEEPSEEK_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("更适合观察");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("treats explicit framework and scoring instructions as memory-only messages", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const message of ["我的投资框架是先排雷，再看现金流，最后看估值。", "以后评分要严格，宁可低估，不要给困境公司虚高分。"]) {
      const response = await onRequestPost({
        request: new Request("https://example.com/api/assistant/chat", {
          method: "POST",
          headers: { cookie: "cstd_alpha_session=session-1.token" },
          body: JSON.stringify({ message }),
        }),
        env: {
          AUTH_SECRET: "secret",
          DEEPSEEK_API_KEY: "key",
          REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
        },
        params: {},
        waitUntil: vi.fn(),
        next: vi.fn(),
        data: {},
      } as never);
      const body = await response.text();
      expect(body).toContain("memory_candidate");
      expect(body).toContain("待确认记忆");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("answers rebuttal and watchlist questions directly without clarification", async () => {
    const answer = "结论：需要优先排雷。\n证据等级：中。\n核心理由：估值、现金流和行业风险都要核验。\n反驳用户观点：不能只看跌幅或自选股名称。\n我可能错在哪里：若财报和现金流改善应修正。\n下一步跟踪：财报、估值、现金流。";
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url, init) => {
        const requestBody = JSON.parse(String(init?.body ?? "{}"));
        if (requestBody.stream) {
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }], usage: { total_tokens: 120 } })}\n\ndata: [DONE]\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { total_tokens: 120 } }), { status: 200 });
      });
    vi.stubGlobal("fetch", fetchMock);

    for (const message of ["我觉得万科A已经跌够了所以可以买，你反驳一下。", "根据我的自选股，哪些需要优先排雷？", "小米还能涨吗？"]) {
      const response = await onRequestPost({
        request: new Request("https://example.com/api/assistant/chat", {
          method: "POST",
          headers: { cookie: "cstd_alpha_session=session-1.token" },
          body: JSON.stringify({ message }),
        }),
        env: {
          AUTH_SECRET: "secret",
          DEEPSEEK_API_KEY: "key",
          REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
        },
        params: {},
        waitUntil: vi.fn(),
        next: vi.fn(),
        data: {},
      } as never);
      const body = await response.text();
      expect(body).not.toContain("choice_request");
      expect(body).toContain("结论");
    }
  });
});

function mockDb({ role }: { role: string }) {
  const state = { sql: [] as string[] };
  const db = {
    prepare(sql: string) {
      state.sql.push(sql);
      return {
        bind: () => ({
          first: async () => {
            if (sql.includes("FROM auth_sessions")) {
              return {
                id: "session-1",
                user_id: "user-1",
                token_hash: "hVhvD1VpBYnV5arqq-K3tpge3K4fBQqJNr1tyQOnp3c",
                expires_at: "2999-01-01T00:00:00.000Z",
                username: "admin",
                display_name: "admin",
                role,
                disabled_at: null,
              };
            }
            if (sql.includes("assistant_threads")) return null;
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => undefined,
        }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => undefined,
      };
    },
    batch: async () => [],
    __state: state,
  };
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async () => {
    const bytes = new Uint8Array([133, 88, 111, 15, 85, 105, 5, 137, 213, 229, 170, 234, 171, 226, 183, 182, 152, 30, 220, 174, 31, 5, 10, 137, 54, 189, 109, 201, 3, 167, 167, 119]);
    return bytes.buffer;
  });
  return db as unknown as D1Database;
}

function mockKv() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace;
}
