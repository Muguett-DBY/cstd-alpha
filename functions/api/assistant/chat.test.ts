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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ needClarification: false }) } }],
            usage: { prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 10, total_tokens: 60 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "记住：以后先看现金流。" }),
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
    expect(body).toContain("memory_candidate");
    expect(body).toContain("usage");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(requestBody.model).toBe("deepseek-v4-flash");
    expect(requestBody.reasoning_effort).toBe("max");
    expect(requestBody.stream).toBe(true);
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
        body: JSON.stringify({ message: "宁德时代能买吗？" }),
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

  test("target research mode uses non-stream answer and rational review before returning", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ needClarification: false }) } }] }), { status: 200 }))
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
        body: JSON.stringify({ message: "宁德时代能买吗？", mode: "target" }),
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(body).toContain("当前只能列为观察");
    expect(body).toContain("done");
    const answerBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(answerBody.stream).toBe(false);
    expect(JSON.stringify(answerBody.messages)).toContain("研究模式：标的研究");
    const reviewBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(JSON.stringify(reviewBody.messages)).toContain("理性审查器");
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
      "### 反驳用户典型观点",
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
    expect(body).not.toContain("反驳用户典型观点");
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
