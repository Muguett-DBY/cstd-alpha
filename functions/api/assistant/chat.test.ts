import { describe, expect, test, vi } from "vitest";
import { onRequestPost, resolveAssistantResearchContext, shouldAutoUseResearchEvidence, shouldTriggerExternalEvidence, shouldUseExaForAssistant } from "./chat";

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }))
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(body).toContain("当前只能列为观察");
    expect(body).toContain("done");
    const answerBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(answerBody.stream).toBe(false);
    expect(JSON.stringify(answerBody.messages)).toContain("研究模式：标的研究");
    const reviewBody = JSON.parse(fetchMock.mock.calls[3][1].body);
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ needClarification: false }) } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }))
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

  test("uses Exa only for high-value weak-evidence research and respects quota storage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ needClarification: false }) } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ requestId: "exa_req", results: [{ title: "CATL overseas risk", url: "https://example.com/catl", highlights: ["海外竞争和政策风险。"] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "结论：观察。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
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
    expect(fetchMock.mock.calls.some((call) => call[0] === "https://api.exa.ai/search")).toBe(true);
    expect(kv.put).toHaveBeenCalled();
  });

  test("classifies Exa high-value trigger conservatively", () => {
    expect(shouldUseExaForAssistant("宁德时代海外竞争和政策风险最新怎么看？", "target", "公司证据包：未命中")).toEqual(
      expect.objectContaining({ use: true }),
    );
    expect(shouldUseExaForAssistant("茅台今年净利润业绩预估？", "target", "公司证据包：未命中")).toEqual(expect.objectContaining({ use: true }));
    expect(shouldUseExaForAssistant("简单总结一下", "chat", "站内证据充足")).toEqual(expect.objectContaining({ use: false }));
  });

  test("auto-detects target research in normal chat for forecasts and technical questions", () => {
    expect(shouldAutoUseResearchEvidence("茅台今年业绩预估？")).toBe(true);
    expect(shouldAutoUseResearchEvidence("优必选人形机器人，大脑与小脑之间的协调性如何？")).toBe(true);
    expect(shouldAutoUseResearchEvidence("用一句话解释自由现金流")).toBe(false);
  });

  test("resolves follow-up questions to the previous user research subject", () => {
    const resolved = resolveAssistantResearchContext("根据现有信息和数据进行预测", [
      { role: "user", content: "茅台今年业绩预估？" },
      { role: "assistant", content: "历史回答里的数字不能当事实证据。" },
    ]);
    expect(resolved.message).toContain("茅台今年业绩预估");
    expect(resolved.promptMessage).toContain("对话承接");
  });

  test("triggers external evidence for high-value chat research even without explicit search wording", () => {
    expect(shouldTriggerExternalEvidence("茅台今年业绩预估？", "target", "公司证据包：未命中")).toBe(true);
    expect(shouldTriggerExternalEvidence("优必选人形机器人技术优势是什么？", "target", "站内证据不足")).toBe(true);
    expect(shouldTriggerExternalEvidence("解释自由现金流", "chat", "站内证据充足")).toBe(false);
  });

  test("downgrades unaudited forecast wording in auto research answers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ needClarification: false }) } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }))
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
