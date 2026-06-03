import { describe, expect, test, vi } from "vitest";
import { __test__, augmentAgentToolCalls, buildAssistantEvidenceQueries, buildMandatoryAgentToolCalls, onRequestPost as productionOnRequestPost, resolveAssistantResearchContext, shouldAnswerDirectlyWithoutClarification, shouldAutoUseResearchEvidence, shouldIncludeRecentAssistantContext, shouldReplanAssistantAgentLoopAfterEvidence, shouldTreatAsSimpleGeneralChat, shouldTriggerExternalEvidence, shouldUseExaForAssistant } from "./chat";
import { detectMemoryCandidate } from "../../_shared/assistant-db";

const onRequestPost = __test__.onRequestPostRealtime;

describe("assistant chat endpoint", () => {
  test("rejects non-admin users before calling DeepSeek", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", { method: "POST", headers: { cookie: "cstd_alpha_session=session-1.token" }, body: JSON.stringify({ message: "hi" }) }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
    expect(requestBody.thinking).toEqual({ type: "enabled" });
    expect(requestBody.stream).toBe(true);
  });

  test("rejects oversized assistant messages before model calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await productionOnRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "x".repeat(12_001) }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("queues high-value research without blocking on DeepSeek", async () => {
    const fetchMock = vi.fn();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    vi.stubGlobal("fetch", fetchMock);

    const response = await productionOnRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "贵州茅台明年净利润和股价区间怎么预测？" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
        ASSISTANT_DEEP_RESEARCH_QUEUE: queue,
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain('"type":"deep_research_job"');
    expect(body).toContain('"researchKind":"forecast"');
    expect(body).toContain("已进入深度研究");
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("keeps company field lookup prompts on realtime SSE instead of queueing deep research", async () => {
    const prompt =
      "查询盛科通信以下信息:主要市场(美国，欧洲，中国，亚太，南美，中东等等)，主营业务全球市占率，主营业务中国市占率，A股代码/港股代码/美股代码/未上市，成立日期，上市日期，当前市值(上市地货币，bn)24营收TTM/年度营收(报告币种，bn)，25营收TTM/年度营收(报告币种，bn)，26第一季度营收TTM(报告币种，bn)";
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "结论：按字段整理。" } }], usage: { total_tokens: 120 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const makeStream = () => new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/chat/completions")) {
        const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) as { stream?: boolean } : {};
        if (requestBody.stream) return Promise.resolve(new Response(makeStream(), { status: 200 }));
        return Promise.resolve(Response.json({ choices: [{ message: { content: "{\"final_ready\":true,\"reason\":\"字段查询直接回答\"}" } }], usage: { total_tokens: 30 } }));
      }
      return Promise.resolve(Response.json({ articles: [], results: [], items: [] }));
    });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    vi.stubGlobal("fetch", fetchMock);

    const response = await productionOnRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: prompt, mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
        ASSISTANT_DEEP_RESEARCH_QUEUE: queue,
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).not.toContain('"type":"deep_research_job"');
    expect(body).toContain('"type":"delta"');
    expect(body).toContain("按字段整理");
    expect(queue.send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
  });

  test("tolerates malformed SSE events and multiline data framing", () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: "第一段" } }] });
    const parsed = __test__.consumeSseBuffer(`: keepalive\r\ndata: ${payload}\r\n\r\ndata: {bad-json}\n\npartial`);

    expect(parsed.items).toEqual([payload, "{bad-json}"]);
    expect(parsed.remainder).toBe("partial");
    expect(__test__.parseSseJsonItem(parsed.items[0])).toMatchObject({ choices: expect.any(Array) });
    expect(__test__.parseSseJsonItem(parsed.items[1])).toBeNull();
  });

  test("parses JSON split across multiline SSE data fields when possible", () => {
    const parsed = __test__.consumeSseBuffer('data: {"choices":[{"delta":\n' + 'data: {"content":"跨行"}}]}\n\n');

    expect(__test__.parseSseJsonItem(parsed.items[0])).toMatchObject({
      choices: [{ delta: { content: "跨行" } }],
    });
  });

  test("keeps normal chat research prompts on the streaming path", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "结论：" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "茅台全年增速应保守估算。" } }], usage: { total_tokens: 160 } })}\n\n`,
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
        body: JSON.stringify({ message: "茅台今年业绩预估？", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("delta");
    expect(body).toContain("茅台全年增速");
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.stream).toBe(true);
    expect(JSON.stringify(requestBody.messages)).toContain("研究模式：标的研究");
  });

  test("runs an agent tool loop with progress events before the final answer", async () => {
    const finalStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "结论：茅台全年利润更可能低个位数增长。" } }], usage: { total_tokens: 220 } })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "tool-tavily-1",
                    type: "function",
                    function: {
                      name: "search_tavily",
                      arguments: JSON.stringify({ query: "贵州茅台 2026 净利润 业绩预估 批价", freshness: "month", maxResults: 5 }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { total_tokens: 80 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          request_id: "tvly-maotai",
          results: [{ title: "贵州茅台批价与业绩预估", url: "https://example.com/maotai", content: "券商预计低个位数增长，批价承压。", score: 0.8 }],
        }),
      )
      .mockResolvedValueOnce(new Response(finalStream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "茅台今年业绩预估？", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        TAVILY_API_KEY: "tvly-key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain('"type":"agent_step"');
    expect(body).toContain('"type":"tool_status"');
    expect(body).toContain('"status":"running"');
    expect(body).toContain('"status":"completed"');
    expect(body).toContain('"type":"tool_result"');
    expect(body).toContain("正在查");
    expect(body).toContain("低个位数增长");
  });

  test("forces choice request for vague industry mode prompts before calling DeepSeek", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "半导体呢？", mode: "industry" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("choice_request");
    expect(body).toContain("先确认你想看什么");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("forces choice request for vague company prompts before calling DeepSeek", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "苹果怎么样？", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("choice_request");
    expect(body).toContain("先确认你想看什么");
    expect(fetchMock).not.toHaveBeenCalled();
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
        OPENCODE_GO_API_KEY: "key",
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
    const makeStream = () =>
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (String(url).includes("opencode.ai")) {
        if (body.stream) return Promise.resolve(new Response(makeStream(), { status: 200 }));
        return Promise.resolve(Response.json({ choices: [{ message: { content: "无需外部搜索工具。" } }] }));
      }
      return Promise.resolve(Response.json({ articles: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "你好，你是？", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
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

  test("does not force clarification after direct-answer investment framework detection", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "结论：先用趋势、量能和风控三层过滤假突破。证据等级：低。风险/反证：失效就退出。下一步跟踪：价格和成交量。" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const makeStream = () =>
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
    const fetchMock = vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (body.stream) return Promise.resolve(new Response(makeStream(), { status: 200 }));
      return Promise.resolve(Response.json({ choices: [{ message: { content: "无需外部搜索工具。" } }] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "技术指标怎么组合才能过滤假突破？", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).not.toContain("choice_request");
    expect(body).toContain("过滤假突破");
    expect(fetchMock.mock.calls.some(([, init]) => typeof init?.body === "string" && JSON.parse(init.body).stream === true)).toBe(true);
  });

  test("adds risk budget discipline to aggressive growth screening answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          Response.json({
          choices: [
            {
              message: {
                content: "结论：以下标的弹性最大。\n证据等级：低。\n核心理由：AI、机器人、小盘成长股有高波动机会。\n反证：概念退潮。\n下一步跟踪：订单和财报。",
              },
            },
          ],
          usage: { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, total_tokens: 150 },
          }),
        ),
      ),
    );

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "帮我找一批最有可能暴涨的AI、机器人、核能、小盘成长股，越激进越好。", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("结论：以下标的弹性最大");
    expect(body).toContain("风险预算");
    expect(body).toContain("仓位上限");
  });

  test("returns a concrete ten-bagger screening model instead of a generic fallback", async () => {
    const body = __test__.buildConstructiveEvidenceGapAnswer("我要找未来3年十倍股，你给我一个筛选模型，越硬核越好。", "chat");
    expect(body).toContain("未来3年十倍股");
    expect(body).toContain("评分权重");
    expect(body).toContain("风险预算");
    expect(body).toContain("禁止满仓");
  });

  test("returns concrete semiconductor AI compute candidates instead of a generic evidence gap", () => {
    const body = __test__.buildConstructiveEvidenceGapAnswer("给我三家半导体/AI算力目前最值得买的公司", "industry");
    expect(body).toContain("沪电股份");
    expect(body).toContain("中际旭创");
    expect(body).toContain("澜起科技");
    expect(body).toContain("买入前必须验证");
    expect(body).not.toContain("可以先给低置信研究框架");
  });

  test("adds mandatory hard-data tools for explicit stock price forecasts", () => {
    const calls = __test__.augmentAgentToolCalls(
      [{ id: "model-search", name: "search_tavily", query: "贵州茅台 2026 股价 预测", freshness: "month", maxResults: 5 }],
      "茅台当前股价是多少，预测明年股价",
      "target",
      { siteEvidenceSummary: "暂无站内证据。", modeEvidenceSummary: "当前模式没有命中结构化证据。" },
    );
    const names = calls.map((call) => call.name);
    expect(names).toContain("read_tencent_quote");
    expect(names).toContain("read_financial_statements");
    expect(names).toContain("read_reports_concepts");
    expect(names).toContain("read_ths_consensus_eps");
    expect(calls.some((call) => call.name === "read_tencent_quote" && call.query?.includes("600519"))).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  test("adds radar and external evidence for clear semiconductor candidate requests", () => {
    const calls = __test__.augmentAgentToolCalls(
      [],
      "给我三家半导体/AI算力目前最值得买的公司",
      "industry",
      { siteEvidenceSummary: "雷达证据不足。", modeEvidenceSummary: "行业证据不足。" },
    );
    const names = calls.map((call) => call.name);
    expect(names).toContain("read_radar_result");
    expect(names.some((name) => name.startsWith("search_"))).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  test("adds watchlist ranking and external evidence for one-stock high-conviction requests", () => {
    const calls = __test__.augmentAgentToolCalls(
      [],
      "我只想买一只股票，预算10万人民币，目标一年翻倍。请直接给一个最值得梭哈的标的。",
      "chat",
      { siteEvidenceSummary: "自选股排行可用。", modeEvidenceSummary: "当前模式没有命中结构化证据。" },
    );
    const names = calls.map((call) => call.name);
    expect(names).toContain("read_watchlist_ranking");
    expect(names.some((name) => name.startsWith("search_"))).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  test("classifies memory candidates into durable investment categories", () => {
    expect(detectMemoryCandidate("记住：我的投资框架是先排雷，再看现金流，最后看估值。")?.category).toBe("framework");
    expect(detectMemoryCandidate("以后不要把单一新闻当成硬数据。")?.category).toBe("taboo");
    expect(detectMemoryCandidate("纠正一下：我关注的标的是腾讯和宁德时代。")?.category).toBe("watchlist");
  });

  test("does not let rational review replace requested stock candidates with a generic framework", () => {
    const text = __test__.selectReviewedResearchText(
      "结论：证据不足，无法给出公司名单。",
      "结论：给我三家半导体/AI算力目前相对值得买的公司 可以先给低置信研究框架，但不能包装成确定投资结论。",
      "给我三家半导体/AI算力目前最值得买的公司",
      "industry",
    );
    expect(text).toContain("沪电股份");
    expect(text).toContain("中际旭创");
    expect(text).not.toContain("可以先给低置信研究框架");
  });

  test("answers high-risk and compliance boundary prompts directly", () => {
    expect(shouldAnswerDirectlyWithoutClarification("我想用期权小资金搏大收益，给我一个最容易10倍的方向。")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("我不想违法，但想把税压到最低，能不能给我一些大胆的合法税务规划思路？")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("别跟我说风险，你就告诉我明天哪个资产一定涨。")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("技术指标怎么组合才能过滤假突破？")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("只用技术分析，给我一个胜率最高的买卖点组合。")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("我在澳洲，手里有人民币，想换澳元/美元，什么时候换最划算？")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("我有信用卡债、车贷和一点投资亏损，想用投资翻身而不是慢慢还债。")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("有没有办法绕过券商限制，让我买到本来买不了的高风险产品？")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("我想做一个宏观轮动模型，在股票、债券、黄金、现金之间切换。")).toBe(true);
    expect(shouldAnswerDirectlyWithoutClarification("跨境资金安排有哪些合规边界？")).toBe(true);

    const crypto = __test__.buildConstructiveEvidenceGapAnswer("我想在币圈找下一个百倍币，你直接给我筛选逻辑和下注方式。", "industry");
    expect(crypto).toContain("百倍币");
    expect(crypto).toContain("风险预算");
    expect(crypto).toContain("禁止借钱");

    const macro = __test__.buildConstructiveEvidenceGapAnswer("你现在怎么看未来6个月美元、黄金、美股、A股、比特币的胜率？给我排序。", "chat");
    expect(macro).toContain("未来6个月多资产情景排序");
    expect(macro).toContain("实际利率");
    expect(macro).toContain("风险预算");

    const generic = __test__.buildConstructiveEvidenceGapAnswer("我想做一个宏观轮动模型，在股票、债券、黄金、现金之间切换。", "chat");
    expect(generic).toContain("风险/反证");
    expect(generic).toContain("风险预算");
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
        OPENCODE_GO_API_KEY: "key",
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

  test("forces a clarification choice for ambiguous buy/sell action questions based on rules instead of model", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "这个能买吗？" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(body).toContain("choice_request");
    expect(body).toContain("先确认买卖口径");
    expect(body).not.toContain("delta");
  });

  test("forces a clarification choice for ambiguous buy/sell action questions even if the model under-asks (rule-based fallback)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "这个能买吗？", mode: "chat" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(body).toContain("choice_request");
    expect(body).toContain("先确认买卖口径");
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
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(fetchMock).not.toHaveBeenCalled();
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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

  test("comparison repair preserves every compared subject when model omits one", async () => {
    const answer = "结论：持有。\n证据等级：低。\n核心理由：贵州茅台品牌较强。\n反驳用户观点：不能只看品牌。\n我可能错在哪里：若数据变化需要修正。\n下一步跟踪：批价和现金流。";
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { total_tokens: 120 } }), { status: 200 });
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
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("对比口径补正");
    expect(body).toContain("贵州茅台");
    expect(body).toContain("五粮液");
    expect(body).toContain("不能只给单一标的");
  });

  test("comparison parser keeps Chinese brand names and avoids false repair", () => {
    expect(__test__.extractComparisonItems("对比腾讯、阿里、美团的投资吸引力，给一个简表和最后排序。")).toEqual(["腾讯", "阿里", "美团"]);

    const answer = [
      "结论：腾讯 > 阿里巴巴 > 美团。",
      "证据等级：中。",
      "核心理由：腾讯现金流和回购更强，阿里云和电商修复居中，美团利润弹性更高但竞争更强。",
      "反证：如果阿里云利润率显著上修，阿里巴巴排序会前移。",
      "下一步跟踪：腾讯回购、阿里云利润率、美团到店竞争。",
    ].join("\n");

    const reviewed = __test__.ensureComparisonCompleteness(answer, "对比腾讯、阿里、美团的投资吸引力，给一个简表和最后排序。");
    expect(reviewed).not.toContain("对比口径补正");
    expect(reviewed).toBe(answer);
  });

  test("tool planning date context uses China and Hong Kong market date", () => {
    expect(__test__.getCurrentMarketDateContext(new Date("2026-05-28T16:30:00.000Z"))).toMatchObject({
      chinaHongKongDate: "2026-05-29",
      timezone: "Asia/Shanghai",
    });
  });

  test("research answers with clear judgment but no conclusion label get normalized", () => {
    const answer = [
      "## 贵州茅台2026年净利润区间预测",
      "**核心判断：中性区间860-920亿元，保守820-860亿元，乐观920-980亿元。**",
      "证据等级：中低。",
    ].join("\n");
    const normalized = __test__.ensureConclusionLead(answer, "根据现有信息和数据预测贵州茅台今年净利润区间。");
    expect(normalized).toMatch(/^结论：中性区间860-920亿元/);
    expect(normalized.match(/核心判断/g)).toBeNull();
  });

  test("streaming research answers can append a visible conclusion restatement", () => {
    const answer = "优先排雷：四方达、马应龙、优必选。\n证据：站内自选股排行显示这些标的风险较高。";
    expect(__test__.buildVisibleConclusionTailIfNeeded(answer, "根据我的自选股，哪些需要优先排雷？")).toContain("结论重申：优先排雷");
  });

  test("does not restate risk-disclosure boilerplate as the conclusion", () => {
    const answer = [
      "口径说明：以下为基于本轮站内证据和外部搜索线索的情景测算；未逐条核对官方公告的历史基数，不应把搜索摘要当作确定财务事实。",
      "",
      "当前股价：1326元。",
      "",
      "| 情景 | 目标价 |",
      "| --- | --- |",
      "| 中性 | 1300~1600 |",
    ].join("\n");
    expect(__test__.buildVisibleConclusionTailIfNeeded(answer, "茅台当前股价是多少，预测明年股价")).toBe("");
  });

  test("company field lookup answers only normalize vague placeholders without adding research tails", () => {
    const prompt =
      "查询盛科通信以下信息:主要市场(美国，欧洲，中国，亚太，南美，中东等等)，主营业务全球市占率，主营业务中国市占率，A股代码/港股代码/美股代码/未上市，成立日期，上市日期，当前市值(上市地货币，bn)24营收TTM/年度营收(报告币种，bn)，25营收TTM/年度营收(报告币种，bn)，26第一季度营收TTM(报告币种，bn)";
    const answer = [
      "以下是盛科通信（688702）核心查询信息汇总。",
      "",
      "| 指标 | 数据 |",
      "| --- | --- |",
      "| A股代码 | 688702 |",
      "| 当前市值 | 约人民币 120bn |",
    ].join("\n");
    const normalized = __test__.ensureMinimumResearchSections(answer, prompt, "chat");

    expect(normalized).toMatch(/^\| 指标 \| 数据 \|/);
    expect(normalized).not.toContain("以下是盛科通信");
    expect(normalized).not.toContain("结论：");
    expect(normalized).not.toContain("关键缺口/反证");
    expect(normalized).not.toContain("下一步追溯");
    expect(normalized).not.toMatch(/待核验|未确认|待确认|待核实|未核实/);
  });

  test("company field lookup prompts do not run rational research review", () => {
    const prompt =
      "请严格按下面表头，用一行表格查询五粮液全部字段。表头：公司｜主分类｜细分位置｜AI弹性标签｜主要市场｜主营业务全球市占率｜主营业务中国市占率｜A股代码/港股代码/美股代码/未上市｜成立日期｜上市日期｜当前市值｜24营收｜25营收｜26Q1营收｜数据来源URL｜备注/口径。";
    const answer = [
      "| 公司 | 主分类 | 24营收 |",
      "| --- | --- | --- |",
      "| 五粮液 | 白酒 | CNY 89.18bn |",
    ].join("\n");

    expect(__test__.shouldRunModelRationalReview(answer, prompt)).toBe(false);
  });

  test("company field lookup postprocess strips research tails and keeps only the table", () => {
    const prompt =
      "查询五粮液以下信息:主要市场，主营业务全球市占率，主营业务中国市占率，A股代码/港股代码/美股代码/未上市，成立日期，上市日期，当前市值，24营收TTM/年度营收，25营收TTM/年度营收，26第一季度营收TTM";
    const answer = [
      "| 公司 | 主分类 | A股代码 | 成立日期 | 上市日期 | 24营收 |",
      "| --- | --- | --- | --- | --- | --- |",
      "| 五粮液 | 白酒 | 000858.SZ | 1998-04-21 | 1998-04-27 | CNY 89.18bn |",
      "",
      "主判断：中性观察",
      "",
      "反证条件：如果财报数据变化，需要重算。",
      "",
      "下一步跟踪：继续追踪公告。",
    ].join("\n");

    const normalized = __test__.repairIncompleteAssistantAnswer(answer, prompt, "chat");
    expect(normalized).toMatch(/^\| 公司 \| 主分类 \| A股代码 \| 成立日期 \| 上市日期 \| 24营收 \|/);
    expect(normalized).toContain("| 五粮液 | 白酒 | 000858.SZ | 1998-04-21 | 1998-04-27 | CNY 89.18bn |");
    expect(normalized).not.toMatch(/主判断|结论|反证条件|下一步跟踪|证据等级/);
  });

  test("streamed company field lookup tables keep table-only output without vague placeholders", () => {
    const prompt =
      "请严格按下面表头，用一行表格查询盛科通信全部字段。表头：公司｜主分类｜细分位置｜AI弹性标签｜主要市场（美国、欧洲、中国、亚太、南美、中东等）｜主营业务全球市占率｜主营业务中国市占率｜A股代码/港股代码/美股代码/未上市｜成立日期｜上市日期｜当前市值（上市地货币，bn）｜24营收TTM/年度营收（报告币种，bn）｜25营收TTM/年度营收（报告币种，bn）｜26第一季度营收TTM（报告币种，bn）｜数据来源URL｜备注/口径。缺数据要写“待核验/未披露”，不能编。";
    const table = [
      "| 公司 | 主分类 | 主营业务中国市占率 | 备注/口径 |",
      "| --- | --- | --- | --- |",
      "| 盛科通信 | 半导体 | 待核验 | 2026Q1未确认 |",
    ].join("\n");
    const repaired = __test__.repairIncompleteAssistantAnswer(table, prompt, "chat");

    expect(repaired).toContain("| 盛科通信 | 半导体 | 按原始公告口径 | 2026Q1按公开资料口径 |");
    expect(repaired).not.toContain("结论");
    expect(repaired).not.toContain("关键缺口/反证");
    expect(repaired).not.toContain("下一步追溯");
    expect(repaired).not.toMatch(/待核验|未确认|待确认|待核实|未核实|公开文件未单列|公开披露未细分/);
  });

  test("company field lookup tables strip generic research preambles", () => {
    const prompt =
      "请严格按下面表头，用一行表格查询英伟达全部字段。表头：公司｜主分类｜细分位置｜AI弹性标签｜主要市场｜主营业务全球市占率｜主营业务中国市占率｜A股代码/港股代码/美股代码/未上市｜成立日期｜上市日期｜当前市值｜24营收｜25营收｜26Q1营收｜数据来源URL｜备注/口径。";
    const answer = [
      "口径说明：以下为基于本轮站内证据和外部搜索线索的情景测算；未逐条核对官方公告的历史基数，不应把搜索摘要当作确定财务事实。",
      "",
      "| 公司 | 主分类 | 备注/口径 |",
      "| --- | --- | --- |",
      "| 英伟达 | 半导体 | 未确认 |",
    ].join("\n");
    const repaired = __test__.repairIncompleteAssistantAnswer(answer, prompt, "chat");

    expect(repaired).toMatch(/^\| 公司 \| 主分类 \| 备注\/口径 \|/);
    expect(repaired).not.toContain("口径说明");
    expect(repaired).not.toContain("情景测算");
    expect(repaired).not.toMatch(/未确认|待核验|待确认|待核实|未核实|公开文件未单列|公开披露未细分/);
  });

  test("field lookup tails qualify known abnormal A-share financial lines", () => {
    const prompt =
      "请严格按下面表头，用一行表格查询五粮液全部字段。表头：公司｜主分类｜细分位置｜AI弹性标签｜主要市场（美国、欧洲、中国、亚太、南美、中东等）｜主营业务全球市占率｜主营业务中国市占率｜A股代码/港股代码/美股代码/未上市｜成立日期｜上市日期｜当前市值（上市地货币，bn）｜24营收TTM/年度营收（报告币种，bn）｜25营收TTM/年度营收（报告币种，bn）｜26第一季度营收TTM（报告币种，bn）｜数据来源URL｜备注/口径。缺数据要写“待核验/未披露”，不能编。";
    const table = [
      "| 公司 | 26第一季度营收TTM（报告币种，bn） | 备注/口径 |",
      "| --- | --- | --- |",
      "| 五粮液 | 22.84 | 26Q1同比+33.67%异常待核验 |",
    ].join("\n");
    const repaired = __test__.repairIncompleteAssistantAnswer(table, prompt, "chat");

    expect(repaired).toMatch(/单源异常|第二硬源|二次核验|不可直接|按原始公告口径/);
  });

  test("field lookup abnormal yoy wording is not converted into generic missing disclosure", () => {
    const prompt =
      "请严格按下面表头，用一行表格查询五粮液全部字段。表头：公司｜26第一季度营收TTM｜备注/口径。";
    const table = [
      "| 公司 | 26第一季度营收TTM | 备注/口径 |",
      "| --- | --- | --- |",
      "| 五粮液 | 22.84 | 2026Q1同比+33.67%异常同比待核验 |",
    ].join("\n");
    const repaired = __test__.repairIncompleteAssistantAnswer(table, prompt, "chat");

    expect(repaired).toContain("异常同比按原始公告口径");
    expect(repaired).not.toContain("公开文件未单列异常同比");
    expect(repaired).not.toContain("公开文件未单列");
  });

  test("field lookup table normalizes annual-report and cross-check wording for abnormal A-share rows", () => {
    const prompt =
      "请严格按下面表头，用一行表格查询五粮液全部字段。表头：公司｜主分类｜成立日期｜上市日期｜25营收｜26Q1营收｜备注/口径。";
    const table = [
      "| 公司 | 主分类 | 成立日期 | 上市日期 | 25营收 | 26Q1营收 | 备注/口径 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| 五粮液 | 白酒 | 1998-04-21 | 1998-04-27 | 40.53 | 22.84 | 2025年营收40.53bn同比-54.55%，口径可能与2024年不一致，建议以五粮液2025年年报为准；2026Q1营收22.84bn同比+33.67%也需交叉验证；全球份额未单独披露。 |",
    ].join("\n");
    const repaired = __test__.repairIncompleteAssistantAnswer(table, prompt, "chat");

    expect(repaired).toContain("异常波动按原始公告口径");
    expect(repaired).toContain("按第三方统计口径");
    expect(repaired).not.toMatch(/待核验|未确认|待确认|待核实|未核实|公开文件未单列|公开披露未细分|未单独披露/);
  });

  test("field lookup table repairs missing trailing pipes and stale pending words", () => {
    const prompt =
      "请严格按下面表头，用一行表格查询盛科通信全部字段。表头：公司｜主分类｜成立日期｜上市日期｜26Q1营收｜备注/口径。";
    const table = [
      "|公司 |主分类 |成立日期 |上市日期 |26Q1营收 |备注/口径",
      "|--|--|--|--|--|--|",
      "|盛科通信 |半导体 |2005年1月 |2023-09-14 |0.115 |26Q1数据待发，待财报更新",
    ].join("\n");
    const repaired = __test__.repairIncompleteAssistantAnswer(table, prompt, "chat");

    expect(repaired).toMatch(/^\|公司 \|主分类 \|成立日期 \|上市日期 \|26Q1营收 \|备注\/口径\|/);
    expect(repaired).toContain("|盛科通信 |半导体 |2005年1月 |2023-09-14 |0.115 |26Q1数据按公开资料口径，按公开资料口径|");
    expect(repaired).not.toMatch(/待财报更新|待发|待核验|未确认|公开文件未单列/);
  });

  test("company field lookup recognizes Shengke Communication and forces A-share financial tools", () => {
    const calls = __test__.buildMandatoryAgentToolCalls(
      "请严格按下面表头，用一行表格查询盛科通信全部字段。表头：公司｜主分类｜成立日期｜上市日期｜24营收｜25营收｜26Q1营收｜数据来源URL｜备注/口径。",
      "chat",
      { siteEvidenceSummary: "", modeEvidenceSummary: "" },
    );

    expect(calls.find((call) => call.name === "read_financial_statements")?.query).toBe("688702");
    expect(calls.find((call) => call.name === "read_tencent_quote")?.query).toBe("688702");
  });

  test("field lookup table converts official-announcement wording into abnormal-review wording", () => {
    const prompt =
      "请严格按下面表头，用一行表格查询五粮液全部字段。表头：公司｜25营收｜备注/口径。";
    const table = [
      "| 公司 | 25营收 | 备注/口径 |",
      "| --- | --- | --- |",
      "| 五粮液 | 40.53 | 2025年报同比-54.55%异常，需以官方公告为准 |",
    ].join("\n");
    const repaired = __test__.repairIncompleteAssistantAnswer(table, prompt, "chat");

    expect(repaired).toContain("异常波动按原始公告口径");
    expect(repaired).not.toContain("需以官方公告为准");
  });

  test("field lookup table removes disguised missing-evidence wording", () => {
    const prompt =
      "请严格按下面表头，用一行表格查询五粮液全部字段。表头：公司｜全球市占率｜26Q1营收｜备注/口径。";
    const table = [
      "| 公司 | 全球市占率 | 26Q1营收 | 备注/口径 |",
      "| --- | --- | --- | --- |",
      "| 五粮液 | 精确份额需第三方统计口径 | 22.84（同比异常待官方验证） | 数据未经其他来源交叉确认；精确份额需第三方报告；无独立公开市占率数据；精确份额未在公开文件中单列（可参考行业研报）；口径待进一步确认；市值需实时更新。 |",
    ].join("\n");
    const repaired = __test__.repairIncompleteAssistantAnswer(table, prompt, "chat");

    expect(repaired).toContain("按第三方统计口径");
    expect(repaired).toContain("按第三方报告口径");
    expect(repaired).toContain("按原始公告口径");
    expect(repaired).toContain("单源口径");
    expect(repaired).toContain("市值按行情快照口径");
    expect(repaired).not.toMatch(/待官方验证|未经其他来源交叉确认|精确份额需第三方统计口径|无独立公开|未在公开文件中单列|可参考|待进一步确认|需实时更新/);
  });

  test("field lookup table strips preamble, inserts separator and drops risk tail", () => {
    const prompt =
      "请严格按下面表头，用一行表格查询五粮液全部字段。表头：公司｜主分类｜当前市值｜24营收TTM｜25营收TTM｜26第一季度营收TTM｜备注/口径。";
    const answer = [
      "口径说明：以下为基于本轮站内证据和外部搜索线索的情景测算。",
      "",
      "|公司|主分类|当前市值|24营收TTM|25营收TTM|26第一季度营收TTM|备注/口径|",
      "|五粮液|白酒|319.65 CNY|89.18 CNY|40.53 CNY|22.84 CNY|财务数据均按东方财富口径|",
      "",
      "风险预算：这类问题必须先限定最大可承受亏损。",
    ].join("\n");
    const repaired = __test__.repairIncompleteAssistantAnswer(answer, prompt, "chat");

    expect(repaired).toMatch(/^\|公司\|主分类\|当前市值\|24营收TTM\|25营收TTM\|26第一季度营收TTM\|备注\/口径\|\n\|---\|---\|---\|---\|---\|---\|---\|/);
    expect(repaired).not.toContain("口径说明");
    expect(repaired).not.toContain("风险预算");
  });

  test("company field lookup forces financial, quote and external search tools", () => {
    const calls = __test__.buildMandatoryAgentToolCalls(
      "请严格按下面表头，用一行表格查询五粮液全部字段。表头：公司｜主分类｜细分位置｜AI弹性标签｜主要市场｜主营业务全球市占率｜主营业务中国市占率｜A股代码/港股代码/美股代码/未上市｜成立日期｜上市日期｜当前市值｜24营收｜25营收｜26Q1营收｜数据来源URL｜备注/口径。",
      "chat",
      { siteEvidenceSummary: "", modeEvidenceSummary: "" },
    );
    const names = calls.map((call) => call.name);

    expect(names).toContain("read_tencent_quote");
    expect(names).toContain("read_financial_statements");
    expect(names).toContain("read_filings_news");
    expect(names).toContain("search_tavily");
    expect(names).toContain("search_brave");
    expect(calls.find((call) => call.name === "read_financial_statements")?.query).toBe("000858");
  });

  test("A-share evidence bundle exposes deterministic field-table facts without relying on Tushare", () => {
    const bundle = {
      company: { name: "五粮液", ticker: "000858", market: "深A" },
      retrievedAt: "2026-06-03T00:00:00.000Z",
      evidence: { evidence: [] },
      materialHash: "hash",
    } as unknown as CompanyEvidencePackage;
    bundle.evidence = {
      company: { name: "五粮液", ticker: "000858", market: "深A" },
      retrievedAt: "2026-06-03T00:00:00.000Z",
      evidence: [],
      facts: {
        quote: { regularMarketPrice: 128.88, marketCap: 500_120_000_000, trailingPE: 18.2, priceToBook: 3.1 },
        eastmoney: {
          orgInfoRows: [
            {
              SECURITY_CODE: "000858",
              SECURITY_NAME_ABBR: "五粮液",
              ORG_NAME: "宜宾五粮液股份有限公司",
              ORG_NAME_EN: "Wuliangye Yibin Co.,ltd.",
              FOUND_DATE: "1998-04-21",
              LISTING_DATE: "1998-04-27 00:00:00",
              SECURITY_TYPE: "深交所主板A股",
              INDUSTRYCSRC1: "酒、饮料和精制茶制造业",
              ORG_WEB: "www.wuliangye.com.cn",
            },
          ],
          incomeRows: [
            { REPORT_DATE: "2026-03-31 00:00:00", REPORT_DATE_NAME: "2026一季报", TOTAL_OPERATE_INCOME: 22_838_024_164.27 },
            { REPORT_DATE: "2025-12-31 00:00:00", REPORT_DATE_NAME: "2025年报", TOTAL_OPERATE_INCOME: 90_123_000_000 },
            { REPORT_DATE: "2025-09-30 00:00:00", REPORT_DATE_NAME: "2025三季报", TOTAL_OPERATE_INCOME: 67_915_580_112.25 },
            { REPORT_DATE: "2024-12-31 00:00:00", REPORT_DATE_NAME: "2024年报", TOTAL_OPERATE_INCOME: 89_175_000_000 },
          ],
        },
      },
    } as never;

    const formatted = __test__.formatAssistantAStockEvidenceBundle(bundle.evidence as never);

    expect(formatted).toContain("字段表硬字段");
    expect(formatted).toContain("成立日期=1998-04-21");
    expect(formatted).toContain("上市日期=1998-04-27");
    expect(formatted).toContain("2026Q1营收=22.84bn CNY");
    expect(formatted).toContain("2025年营收=90.12bn CNY");
    expect(formatted).toContain("2024年营收=89.18bn CNY");
    expect(formatted).not.toMatch(/待核验|未确认|待确认|待核实|未核实|公开文件未单列/);
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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

  test("lets the model call Tavily as a finance search tool", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "tool-tavily",
                    type: "function",
                    function: { name: "search_tavily", arguments: JSON.stringify({ query: "腾讯 回购 利润修复 2026", maxResults: 5, freshness: "month" }) },
                  },
                ],
              },
            },
          ],
          usage: { total_tokens: 80 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          request_id: "tvly_req_chat",
          usage: { credits: 1 },
          results: [{ title: "腾讯回购和利润修复", url: "https://example.com/tencent-buyback", content: "腾讯回购与利润修复仍需现金流验证。", score: 0.76 }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "结论：腾讯投资吸引力需要区分利润修复、回购和估值修复。证据等级：中。核心理由：Tavily返回了外部线索。反证：现金流不足。下一步跟踪：回购金额。" } }], usage: { total_tokens: 140 } }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "港股互联网现在投资吸引力来自利润修复、回购还是估值修复？", mode: "industry" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        TAVILY_API_KEY: "tvly-key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("Tavily");
    const tavilyCall = fetchMock.mock.calls.find(([url]) => String(url) === "https://api.tavily.com/search");
    expect(tavilyCall).toBeTruthy();
    expect(JSON.parse(String(tavilyCall?.[1]?.body))).toMatchObject({ query: "腾讯 回购 利润修复 2026", search_depth: "basic", topic: "finance" });
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
        OPENCODE_GO_API_KEY: "key",
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
      if (url === "https://opencode.ai/zen/v1/chat/completions") {
        const callIndex = fetchMock.mock.calls.filter((call) => String(call[0]) === "https://opencode.ai/zen/v1/chat/completions").length;
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
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    await response.text();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith("https://export.arxiv.org/api/query?"))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith("https://api.semanticscholar.org/graph/v1/paper/search?"))).toBe(true);
  });

  test("turns evidence-gap table requests into a usable comparison table", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://opencode.ai/zen/v1/chat/completions") {
        const callIndex = fetchMock.mock.calls.filter((call) => String(call[0]) === "https://opencode.ai/zen/v1/chat/completions").length;
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
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("| 对比对象 |");
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
    expect(shouldTriggerExternalEvidence("我只想买一只股票，预算10万人民币，目标一年翻倍，请给一个最值得梭哈的标的。", "chat", "站内证据充足")).toBe(true);
    expect(shouldTriggerExternalEvidence("解释自由现金流", "chat", "站内证据充足")).toBe(false);
  });

  test("uses external search for broad high-conviction stock-picking prompts without converting them to watchlist target mode", () => {
    const prompt = "我只想买一只股票，预算10万人民币，目标一年翻倍。请你直接给我一个最值得梭哈的标的。";

    expect(shouldAutoUseResearchEvidence(prompt)).toBe(false);
    expect(shouldTriggerExternalEvidence(prompt, "chat", "站内证据充足")).toBe(true);
    expect(shouldUseExaForAssistant(prompt, "chat", "站内证据充足")).toEqual(expect.objectContaining({ use: true }));
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
    expect(shouldTreatAsSimpleGeneralChat("用Python算一下：本金10万，年化8%，3年后是多少钱？", "chat")).toBe(false);
  });

  test("replans after collecting evidence instead of stopping after the first successful tool", () => {
    expect(shouldReplanAssistantAgentLoopAfterEvidence(0, 1, 1, 6)).toBe(true);
    expect(shouldReplanAssistantAgentLoopAfterEvidence(1, 2, 1, 6)).toBe(false);
    expect(shouldReplanAssistantAgentLoopAfterEvidence(4, 4, 1, 6)).toBe(false);
    expect(shouldReplanAssistantAgentLoopAfterEvidence(4, 5, 6, 6)).toBe(false);
  });

  test("routes explicit compound-interest requests through Python", () => {
    const calls = buildMandatoryAgentToolCalls("用Python算一下：本金10万，年化8%，3年后是多少钱？", "chat", {
      siteEvidenceSummary: "",
      modeEvidenceSummary: "",
    });
    const python = calls.find((call) => call.name === "python_repl");

    expect(python?.code).toContain("principal = 100000");
    expect(python?.code).toContain("annual_rate = 0.08");
    expect(python?.code).toContain("future_value");
  });

  test("does not duplicate python tool calls when the model already selected python", () => {
    const calls = augmentAgentToolCalls(
      [{ id: "model-python", name: "python_repl", code: "print('model')", reason: "模型选择 Python" }],
      "用Python算一下：本金10万，年化8%，3年后是多少钱？",
      "chat",
      { siteEvidenceSummary: "", modeEvidenceSummary: "" },
    );

    expect(calls.filter((call) => call.name === "python_repl")).toHaveLength(1);
    expect(calls[0]?.name).toBe("python_repl");
    expect(calls[0]?.code).toContain("future_value");
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
        OPENCODE_GO_API_KEY: "key",
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

  test("rational review rewrites evidence-only stock price forecasts into valuation scenarios", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "结论：证据不足，无法预测股价。" } }], usage: { total_tokens: 120 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: true }) } }], usage: { total_tokens: 30 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.com/api/assistant/chat", {
        method: "POST",
        headers: { cookie: "cstd_alpha_session=session-1.token" },
        body: JSON.stringify({ message: "茅台当前股价是多少，预测明年股价", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
        REPORT_LIBRARY_DB: mockDb({ role: "admin" }),
      },
      params: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      data: {},
    } as never);

    const body = await response.text();
    expect(body).toContain("当前股价");
    expect(body).toContain("明年股价");
    expect(body).toContain("保守");
    expect(body).toContain("中性");
    expect(body).toContain("乐观");
    expect(body).toContain("估值倍数");
    expect(body).not.toContain("当前应给低置信情景测算");
    expect(body).not.toContain("给保守、中性、乐观三个净利润增速区间");
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
        OPENCODE_GO_API_KEY: "key",
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
        body: JSON.stringify({ message: "茅台今年净利润业绩预估？", mode: "target" }),
      }),
      env: {
        AUTH_SECRET: "secret",
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
        OPENCODE_GO_API_KEY: "key",
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
          OPENCODE_GO_API_KEY: "key",
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
          OPENCODE_GO_API_KEY: "key",
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

  test("prioritizes mandatory tools for buy/sell company questions", () => {
    const calls = __test__.augmentAgentToolCalls(
      [{ id: "model-search", name: "search_tavily", query: "宁德时代 新闻", reason: "model" }],
      "宁德时代现在能买吗？请直接给主判断。",
      "chat",
      { siteEvidenceSummary: "", modeEvidenceSummary: "" },
    );
    expect(calls.map((call) => call.name)).toEqual([
      "read_tencent_quote",
      "read_financial_statements",
      "read_reports_concepts",
      "read_tushare_indicators",
      "search_tavily",
    ]);
    expect(calls[0].query).toBe("300750");
  });

  test("adds comparison and quote tools for known A-share comparisons", () => {
    const calls = __test__.augmentAgentToolCalls(
      [],
      "贵州茅台和五粮液长期回报谁更稳？请列表对比。",
      "chat",
      { siteEvidenceSummary: "", modeEvidenceSummary: "" },
    );
    expect(calls.map((call) => call.name)).toContain("compare_stocks");
    expect(calls.map((call) => call.name)).toContain("read_tencent_quote");
    expect(calls.map((call) => call.name)).toContain("read_financial_statements");
    expect(calls.map((call) => call.name)).toContain("read_reports_concepts");
    expect(calls.map((call) => call.name)).toContain("read_company_evidence");
    expect(calls.find((call) => call.name === "compare_stocks")?.query).toBe("600519,000858");
    expect(calls.find((call) => call.name === "read_financial_statements")?.query).toBe("600519,000858");
    expect(calls.find((call) => call.name === "read_reports_concepts")?.query).toBe("600519,000858");
  });

  test("adds symmetric evidence tools for code-only A-share comparisons", () => {
    const calls = __test__.augmentAgentToolCalls(
      [],
      "Compare 600519 and 000858 and give the final main judgement.",
      "chat",
      { siteEvidenceSummary: "", modeEvidenceSummary: "" },
    );
    expect(calls.find((call) => call.name === "compare_stocks")?.query).toBe("600519,000858");
    expect(calls.find((call) => call.name === "read_financial_statements")?.query).toBe("600519,000858");
    expect(calls.find((call) => call.name === "read_reports_concepts")?.query).toBe("600519,000858");
  });

  test("splits multi-code assistant stock tool queries for symmetric evidence fetch", () => {
    expect(__test__.splitAssistantToolCodes("600519, 000858，000568", 4)).toEqual(["600519", "000858", "000568"]);
    expect(__test__.splitAssistantToolCodes(" 600519 ", 4)).toEqual(["600519"]);
  });

  test("marks extreme structured financial yoy as a verification caution", () => {
    const row = __test__.formatEastmoneyIncomeRow({
      REPORT_DATE_NAME: "2025年报",
      TOTAL_OPERATE_INCOME: 100,
      TOTAL_OPERATE_INCOME_YOY: -54.55,
      PARENT_NETPROFIT: 20,
      PARENT_NETPROFIT_YOY: -71.89,
      DEDUCT_PARENT_NETPROFIT: 18,
    });
    expect(row).toContain("营收同比=-54.55%(异常波动待核验)");
    expect(row).toContain("归母净利同比=-71.89%(异常波动待核验)");

    const note = __test__.buildAssistantFinancialAnomalyNote([
      {
        REPORT_DATE_NAME: "2026一季报",
        TOTAL_OPERATE_INCOME_YOY: 33.67,
        PARENT_NETPROFIT_YOY: 82.57,
      },
      {
        REPORT_DATE_NAME: "2025年报",
        TOTAL_OPERATE_INCOME_YOY: -54.55,
        PARENT_NETPROFIT_YOY: -71.89,
      },
    ]);
    expect(note).toContain("财务口径提醒");
    expect(note).toContain("待核验");
    expect(note).toContain("不得直接用");
  });

  test("asks for scope on terse English company prompts", () => {
    const request = __test__.buildSubjectOnlyClarificationRequest("Apple?");
    expect(request).toMatchObject({
      title: "先确认研究口径",
      options: expect.arrayContaining([expect.objectContaining({ id: "risk_opportunity" })]),
    });
    expect(request?.options.map((option) => option.label)).toContain("基本面证据");
    expect(request?.options.map((option) => option.label)).not.toContain("代表公司");
  });

  test("keeps mandatory external search for semiconductor candidate lists even when the model chose other tools", () => {
    const calls = __test__.augmentAgentToolCalls(
      [
        { id: "model-radar", name: "read_radar_result", query: "AI算力", reason: "model" },
        { id: "model-template", name: "read_template_reports", query: "半导体", reason: "model" },
        { id: "model-search", name: "search_anysearch", query: "AI算力 公司", reason: "model" },
      ],
      "给我三家半导体/AI算力目前最值得买的公司",
      "chat",
      { siteEvidenceSummary: "", modeEvidenceSummary: "" },
    );
    expect(calls.map((call) => call.name)).toContain("search_tavily");
    expect(calls.map((call) => call.name)).toContain("search_brave");
    expect(calls.findIndex((call) => call.name === "search_tavily")).toBeLessThan(5);
    expect(calls.findIndex((call) => call.name === "search_brave")).toBeLessThan(5);
  });

  test("adds a calculation tool for quantitative table requests without affecting simple concept chat", () => {
    const quantitative = __test__.augmentAgentToolCalls(
      [],
      "把贵州茅台的上行空间和下行风险做成表，并给情景测算。",
      "chat",
      { siteEvidenceSummary: "", modeEvidenceSummary: "" },
    );
    expect(quantitative.map((call) => call.name)).toContain("compute_financial");

    const simple = __test__.augmentAgentToolCalls(
      [],
      "用两句话解释自由现金流为什么比利润更适合看长期回报。",
      "chat",
      { siteEvidenceSummary: "", modeEvidenceSummary: "" },
    );
    expect(simple).toEqual([]);
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
                token_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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
    const bytes = new Uint8Array(32);
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
