import { describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./chat";

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

  test("streams with DeepSeek Flash high and records cache usage", async () => {
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
    expect(requestBody.reasoning_effort).toBe("high");
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
