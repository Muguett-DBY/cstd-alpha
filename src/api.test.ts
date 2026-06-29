import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addWatchlistItem,
  completeResearchTemplateDraft,
  fetchChartData,
  fetchCompanyNews,
  fetchOpportunities,
  fetchRadarScan,
  fetchReportLibrary,
  fetchReportLibraryRecord,
  fetchResearchCatalysts,
  fetchResearchItems,
  fetchResearchTemplates,
  fetchResearchTheses,
  fetchValuations,
  generateReport,
  login,
  resetResearchTemplatesToDefault,
  saveResearchTemplates,
  saveResearchTemplatesAsDefault,
  saveQuantitativeValuationWorkspace,
  searchCompanies,
  refreshRadarScan,
  sendAssistantMessage,
  fetchAssistantDeepResearchJob,
  stopAssistantDeepResearchJob,
  listAssistantThreads,
  createAssistantThread,
  syncResearchCatalystsFromThesis,
} from "./api";

describe("API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("treats streamed NDJSON error payloads as failed report generation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(`${JSON.stringify({ type: "error", error: "DeepSeek request failed." })}\n`, { status: 200 })),
    );

    await expect(
      generateReport({
        company: {
          id: "eastmoney:105.AAPL",
          name: "苹果",
          code: "AAPL",
          exchange: "NASDAQ",
          listingPlace: "美股",
          marketType: "UsStock",
          quoteId: "105.AAPL",
          source: "eastmoney",
        },
      }),
    ).rejects.toThrow("DeepSeek request failed.");
  });

  test("maps malformed streamed NDJSON to a Chinese incomplete-response error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `${JSON.stringify({ type: "progress", stage: "deepseek_scoring", label: "DeepSeek 评分生成", detail: "处理中", percent: 62, at: "2026-05-10T00:00:00.000Z" })}\n{"type":"error"`,
          { status: 200 },
        ),
      ),
    );

    await expect(
      generateReport({
        company: {
          id: "eastmoney:1.600519",
          name: "贵州茅台",
          code: "600519",
          exchange: "上海证券交易所",
          listingPlace: "沪A",
          marketType: "AStock",
          quoteId: "1.600519",
          source: "eastmoney",
        },
      }),
    ).rejects.toThrow("报告响应不完整，请重试。");
  });

  test("maps interrupted report streams to a Chinese network error", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "progress", stage: "deepseek_scoring", label: "DeepSeek 评分生成", detail: "处理中", percent: 62, at: "2026-05-10T00:00:00.000Z" })}\n`));
        controller.error(new TypeError("network error"));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    await expect(
      generateReport({
        company: {
          id: "eastmoney:0.000002",
          name: "万科A",
          code: "000002",
          exchange: "深圳证券交易所",
          listingPlace: "深A",
          marketType: "AStock",
          quoteId: "0.000002",
          source: "eastmoney",
        },
      }),
    ).rejects.toThrow("报告连接中断，后台会继续生成");
  });

  test("maps failed report fetches to a Chinese network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));

    await expect(
      generateReport({
        company: {
          id: "eastmoney:0.000002",
          name: "万科A",
          code: "000002",
          exchange: "深圳证券交易所",
          listingPlace: "深A",
          marketType: "AStock",
          quoteId: "0.000002",
          source: "eastmoney",
        },
      }),
    ).rejects.toThrow("报告连接中断，后台会继续生成");
  });

  test("returns candidates from company search API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ id: "eastmoney:0.000002", name: "万科A", code: "000002", exchange: "6", listingPlace: "深A", marketType: "AStock", source: "eastmoney" }],
          }),
        ),
      ),
    );

    await expect(searchCompanies("万科A")).resolves.toMatchObject([{ name: "万科A", code: "000002", listingPlace: "深A" }]);
  });

  test("reads assistant SSE chat events", async () => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start", threadId: "t1", messageId: "m1" })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text: "结论：" })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text: "先观察" })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "usage", usage: { model: "deepseek-v4-flash", reasoningEffort: "high", promptCacheHitTokens: 80 } })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", message: { id: "m1", threadId: "t1", role: "assistant", content: "结论：先观察", createdAt: "2026-05-24T00:00:00.000Z" } })}\n\n`));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream));
    vi.stubGlobal("fetch", fetchMock);
    const events: string[] = [];

    const result = await sendAssistantMessage("宁德时代怎么看？", "target", (event) => events.push(event.type));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assistant/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "宁德时代怎么看？", mode: "target" }),
      }),
    );
    expect(events).toEqual(["start", "delta", "delta", "usage", "done"]);
    expect(result.content).toBe("结论：先观察");
  });

  test("sends default assistant chat with thread id and abort signal", async () => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start", threadId: "t1", messageId: "m1" })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", message: { id: "m1", threadId: "t1", role: "assistant", content: "结论：可观察", createdAt: "2026-05-24T00:00:00.000Z" } })}\n\n`));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const result = await sendAssistantMessage("宁德时代怎么看？", () => undefined, undefined, "thread-1", controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assistant/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "宁德时代怎么看？", mode: "chat", threadId: "thread-1" }),
        signal: controller.signal,
      }),
    );
    expect(result?.content).toBe("结论：可观察");
  });

  test("maps interrupted assistant streams to a Chinese incomplete-response error", async () => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start", threadId: "t1", messageId: "m1" })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text: "结论：先观察" })}\n\n`));
        controller.error(new TypeError("network error"));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));

    await expect(sendAssistantMessage("宁德时代怎么看？")).rejects.toThrow("助手连接中断，已保留当前已显示内容，请重试。");
  });

  test("maps malformed assistant SSE payloads to a Chinese incomplete-response error", async () => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start", threadId: "t1", messageId: "m1" })}\n\n`));
        controller.enqueue(encoder.encode(`data: {"type":"done"`));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));

    await expect(sendAssistantMessage("宁德时代怎么看？")).rejects.toThrow("助手响应不完整，请重试。");
  });


  test("returns null when assistant stream asks for a clarification choice", async () => {
    const request = {
      id: "cr-1",
      title: "先确认分析口径",
      question: "你希望我优先按哪种口径分析？",
      reason: "问题有多个合理方向，直接回答容易误导。",
      customPlaceholder: "也可以写你的具体口径。",
      options: [
        { id: "long-term", label: "长期投资视角", description: "看商业质量、现金流和估值。", recommended: true },
        { id: "risk", label: "先排雷", description: "先找财务和行业风险。" },
        { id: "short-term", label: "短期催化", description: "看近期财报、订单和资金。" },
      ],
    };
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start", threadId: "t1", messageId: "m1" })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "choice_request", request })}\n\n`));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    const events: string[] = [];

    const result = await sendAssistantMessage("宁德时代能买吗？", (event) => events.push(event.type));

    expect(result).toBeNull();
    expect(events).toEqual(["start", "choice_request"]);
  });

  test("reads and stops assistant deep research jobs", async () => {
    const job = {
      id: "deep-1",
      threadId: "t1",
      query: "茅台明年利润预测",
      mode: "target",
      researchKind: "forecast",
      status: "running",
      progressTitle: "正在查财报...",
      progressStage: "collect",
      progressCurrent: 2,
      progressTotal: 4,
      stopRequested: false,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ job }))
      .mockResolvedValueOnce(Response.json({ job: { ...job, status: "stopping", stopRequested: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAssistantDeepResearchJob("deep-1")).resolves.toMatchObject({ id: "deep-1", status: "running" });
    await expect(stopAssistantDeepResearchJob("deep-1")).resolves.toMatchObject({ id: "deep-1", status: "stopping", stopRequested: true });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/assistant/deep-research/deep-1", { credentials: "include", cache: "no-store" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/assistant/deep-research/deep-1/stop", { method: "POST", credentials: "include" });
  });

  test("rejects malformed assistant thread list responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ thread: { id: "wrong-shape" } })));

    await expect(listAssistantThreads()).rejects.toThrow("线程列表读取失败。");
  });

  test("rejects malformed assistant thread creation responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ threads: [] })));

    await expect(createAssistantThread("临时线程")).rejects.toThrow("线程创建失败。");
  });

  test("sends valuation version decision notes with manual saves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      workspace: { versions: [], actualReviews: [] },
      version: {
        id: "version-2",
        runId: "run-1",
        sourceSnapshotId: "snapshot-1",
        version: 2,
        status: "saved",
        archetype: "operating",
        method: "dcf_3_statement",
        horizonYears: 5,
        createdBy: "user",
        createdAt: "2026-06-22T00:00:00.000Z",
        decisionNote: "上调收入增速，跟踪订单兑现。",
      },
    })));
    vi.stubGlobal("fetch", fetchMock);

    await saveQuantitativeValuationWorkspace({
      runId: "run-1",
      parentVersionId: "version-1",
      assumptions: [],
      decisionNote: "上调收入增速，跟踪订单兑现。",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/valuation-workspace",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          runId: "run-1",
          parentVersionId: "version-1",
          assumptions: [],
          decisionNote: "上调收入增速，跟踪订单兑现。",
        }),
      }),
    );
  });

  test("sends valuation presets with manual saves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      workspace: { versions: [], actualReviews: [] },
      version: {
        id: "version-2",
        runId: "run-1",
        sourceSnapshotId: "snapshot-1",
        version: 2,
        status: "saved",
        archetype: "operating",
        method: "dcf_3_statement",
        horizonYears: 5,
        createdBy: "user",
        createdAt: "2026-06-22T00:00:00.000Z",
      },
    })));
    vi.stubGlobal("fetch", fetchMock);

    await saveQuantitativeValuationWorkspace({
      runId: "run-1",
      parentVersionId: "version-1",
      assumptions: [],
      presets: [{
        id: "preset-1",
        name: "压力测试",
        createdAt: "2026-06-26T00:00:00.000Z",
        assumptions: [{ key: "revenueGrowth", label: "收入增速", bear: 0, base: 2, bull: 5, unit: "%", origin: "user", locked: true }],
      }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/valuation-workspace",
      expect.objectContaining({
        body: JSON.stringify({
          runId: "run-1",
          parentVersionId: "version-1",
          assumptions: [],
          presets: [{
            id: "preset-1",
            name: "压力测试",
            createdAt: "2026-06-26T00:00:00.000Z",
            assumptions: [{ key: "revenueGrowth", label: "收入增速", bear: 0, base: 2, bull: 5, unit: "%", origin: "user", locked: true }],
          }],
        }),
      }),
    );
  });

  test("sends restored preset source metadata with manual valuation saves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      workspace: { versions: [], actualReviews: [] },
      version: {
        id: "version-2",
        runId: "run-1",
        sourceSnapshotId: "snapshot-1",
        version: 2,
        status: "saved",
        archetype: "operating",
        method: "dcf_3_statement",
        horizonYears: 5,
        createdBy: "user",
        createdAt: "2026-06-22T00:00:00.000Z",
      },
    })));
    vi.stubGlobal("fetch", fetchMock);

    await saveQuantitativeValuationWorkspace({
      runId: "run-1",
      parentVersionId: "version-1",
      assumptions: [],
      restoredPresetLibrary: {
        version: 4,
        restoredAt: "2026-06-26T00:20:00.000Z",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/valuation-workspace",
      expect.objectContaining({
        body: JSON.stringify({
          runId: "run-1",
          parentVersionId: "version-1",
          assumptions: [],
          restoredPresetLibrary: {
            version: 4,
            restoredAt: "2026-06-26T00:20:00.000Z",
          },
        }),
      }),
    );
  });

  test("rejects login responses that omit the user payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true }))));

    await expect(login("pw", "admin")).rejects.toThrow("服务端未返回账号信息");
  });

  test("returns watchlist add status with the stored item", async () => {
    const item = {
      id: "watch-1",
      userId: "user-1",
      company: {
        id: "eastmoney:1.600519",
        name: "贵州茅台",
        code: "600519",
        exchange: "上海证券交易所",
        listingPlace: "A股",
        marketType: "AStock",
        source: "eastmoney",
      },
      addedAt: "2026-06-30T00:00:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ item, status: "updated" })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await addWatchlistItem({ company: item.company });

    expect(result).toEqual({ item, status: "updated" });
  });

  test("sends cache mode and force refresh flags when generating reports", async () => {
    const report = {
      company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "观察",
      oneSentence: "报告完成",
      scoreItems20: [],
      evidence: [],
      sections: { companyOverview: "概况" },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(`${JSON.stringify({ type: "final", report })}\n`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const company = {
      id: "eastmoney:1.600519",
      name: "贵州茅台",
      code: "600519",
      exchange: "上海证券交易所",
      listingPlace: "沪A",
      marketType: "AStock",
      quoteId: "1.600519",
      source: "eastmoney" as const,
    };

    await generateReport({ company, forceRefresh: true, cacheMode: "refresh" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/report",
      expect.objectContaining({
        body: JSON.stringify({ company, forceRefresh: true, cacheMode: "refresh" }),
      }),
    );
  });

  test("normalizes streamed final reports before returning them to the UI", async () => {
    const report = {
      company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "观察",
      oneSentence: "报告完成",
      scoreItems20: [],
      evidence: [],
      sections: { companyOverview: "概况", industry: "行业旧字段" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`${JSON.stringify({ type: "final", report })}\n`, { status: 200 })));

    const result = await generateReport({
      company: {
        id: "eastmoney:1.600519",
        name: "贵州茅台",
        code: "600519",
        exchange: "上海证券交易所",
        listingPlace: "沪A",
        marketType: "AStock",
        quoteId: "1.600519",
        source: "eastmoney",
      },
    });

    expect(result.report.fullSections.industryTrack).toBe("行业旧字段");
    expect(result.report.summaryDashboard.valuationView).toBe("待验证");
  });

  test("normalizes report library records before returning them to the UI", async () => {
    const report = {
      company: { name: "微软", ticker: "MSFT", market: "美股" },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "观察",
      oneSentence: "报告完成",
      scoreItems20: [],
      evidence: [],
      sections: { companyOverview: "概况", industry: "行业旧字段" },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ entry: { id: "report-1" }, report })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchReportLibraryRecord("report-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/report-library?id=report-1", expect.objectContaining({ credentials: "include" }));
    expect(result.report.fullSections.industryTrack).toBe("行业旧字段");
    expect(result.report.financialTenYear.interpretation).toContain("数据不足");
  });

  test("passes an abort signal to report generation fetches", async () => {
    const report = {
      company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "观察",
      oneSentence: "报告完成",
      scoreItems20: [],
      evidence: [],
      sections: { companyOverview: "概况" },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(`${JSON.stringify({ type: "final", report })}\n`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const company = {
      id: "eastmoney:1.600519",
      name: "贵州茅台",
      code: "600519",
      exchange: "上海证券交易所",
      listingPlace: "沪A",
      marketType: "AStock",
      quoteId: "1.600519",
      source: "eastmoney" as const,
    };

    await generateReport({ company, signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/report",
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  test("returns report generation metrics from the final stream event", async () => {
    const report = {
      company: { name: "微软", ticker: "MSFT", market: "美股" },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "观察",
      oneSentence: "报告完成",
      scoreItems20: [],
      evidence: [],
      sections: { companyOverview: "概况" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `${JSON.stringify({
            type: "progress",
            stage: "done",
            label: "报告完成",
            detail: "完成",
            percent: 100,
            at: "2026-05-10T00:00:02.000Z",
            startedAt: "2026-05-10T00:00:00.000Z",
            elapsedMs: 2000,
          })}\n${JSON.stringify({
            type: "final",
            report,
            metrics: {
              startedAt: "2026-05-10T00:00:00.000Z",
              completedAt: "2026-05-10T00:00:02.000Z",
              elapsedMs: 2000,
              modelCalls: 9,
              cacheMode: "refresh",
            },
          })}\n`,
          { status: 200 },
        ),
      ),
    );

    const result = await generateReport({
      company: {
        id: "eastmoney:105.MSFT",
        name: "微软",
        code: "MSFT",
        exchange: "美国市场",
        listingPlace: "美股",
        marketType: "UsStock",
        quoteId: "105.MSFT",
        source: "eastmoney",
      },
      forceRefresh: true,
      cacheMode: "refresh",
    });

    expect(result).toMatchObject({
      report: { company: { name: "微软" } },
      metrics: { elapsedMs: 2000, modelCalls: 9, cacheMode: "refresh" },
    });
  });

  test("requests chart data with selected company and price mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          company: { name: "万科A", ticker: "000002", market: "深A" },
          asOf: "2026-05-10T00:00:00.000Z",
          priceMode: "adjusted",
          priceSeries: [{ date: "2026-05-08", close: 4, adjustedClose: 4, volume: 100 }],
          drawdownSeries: [{ date: "2026-05-08", price: 4, peak: 4, drawdown: 0 }],
          marketSnapshot: { currentPrice: 4 },
          evidence: [],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const company = {
      id: "eastmoney:0.000002",
      name: "万科A",
      code: "000002",
      exchange: "深圳证券交易所",
      listingPlace: "深A",
      marketType: "AStock",
      quoteId: "0.000002",
      source: "eastmoney" as const,
    };

    await expect(fetchChartData({ company, priceMode: "adjusted" })).resolves.toMatchObject({ company: { name: "万科A" }, priceMode: "adjusted" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chart-data",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ company, priceMode: "adjusted" }),
      }),
    );
  });

  test("passes report-library market filters to the list endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [], total: 0, matchedTickers: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await fetchReportLibrary({ market: "us", limit: 20, offset: 40, sort: "ias", direction: "desc", tickers: ["000333", "603259"] });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("market=us"), expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("tickers=000333%2C603259"), expect.objectContaining({ credentials: "include" }));
  });

  test("reads and saves user research templates through the template API", async () => {
    const templates = [
      {
        id: "template-11-capital-allocation",
        title: "模板11：资金配置原则与公司配置分析",
        shortTitle: "资金配置",
        focus: "配置分析",
        prompt: "短提示",
        fullPrompt: "完整提示",
        enabled: true,
        sortOrder: 11,
      },
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ templates }))));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResearchTemplates()).resolves.toEqual(templates);
    await saveResearchTemplates(templates);
    await saveResearchTemplatesAsDefault();
    await resetResearchTemplatesToDefault();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/research-templates", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/research-templates",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ templates }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/research-templates",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "save-defaults" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/research-templates",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "reset-defaults" }) }),
    );
  });

  test("sends a template draft to the AI completion endpoint", async () => {
    const completion = {
      title: "模板12：实体经营者思维公司分析",
      shortTitle: "实体经营",
      focus: "把投资视为低成本开公司，检查产业、商业模式、团队、估值与非理性回报。",
      prompt: "按实体经营者思维模板输出公司分析。",
      fullPrompt: "# 模板12：实体经营者思维公司分析\n\n请分析（      ）公司。",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ completion })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeResearchTemplateDraft({
        title: "自定义模板12",
        shortTitle: "自定义",
        focus: "",
        prompt: "",
        fullPrompt: "第12模板\n\n实体经营者思维。",
      }),
    ).resolves.toEqual(completion);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/research-template-completion",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          draft: {
            title: "自定义模板12",
            shortTitle: "自定义",
            focus: "",
            prompt: "",
            fullPrompt: "第12模板\n\n实体经营者思维。",
          },
        }),
      }),
    );
  });

  test("reads and refreshes the industry radar scan", async () => {
    const radar = {
      id: "radar-1",
      title: "行业雷达扫描",
      generatedAt: "2026-05-17T00:00:00.000Z",
      asOfDate: "2026-05-17",
      validUntil: "2026-05-17T12:00:00.000Z",
      model: "deepseek-v4-flash",
      sourceCount: 12,
      sourceQueries: ["A股 行业 景气"],
      executiveSummary: ["电网设备增长扎实。"],
      solidGrowth: [],
      sustainability: [],
      bubbleRisks: [],
      upcomingGrowth: [],
      decliningIndustries: [],
      representativeCompanies: [],
      stageCompanies: [],
      limitations: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ radar })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ radar: { ...radar, fromCache: true } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRadarScan()).resolves.toEqual({ radar, job: null, diagnostics: null, warning: undefined });
    await expect(refreshRadarScan()).resolves.toEqual({ radar: { ...radar, fromCache: true }, job: null, diagnostics: null, warning: undefined });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/radar-scan", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/radar-scan",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
  });

  test("normalizes incomplete opportunities payloads to empty dashboard data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({})));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOpportunities()).resolves.toEqual({
      generatedAt: "",
      opportunities: [],
      topResearch: [],
      riskWorsening: [],
      catalysts: [],
      funnel: [],
      inbox: [],
      researchItems: [],
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/opportunities", expect.objectContaining({ credentials: "include" }));
  });

  test("normalizes incomplete research workspace payloads to empty collections", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(new Response(JSON.stringify({ current: undefined })))
      .mockResolvedValueOnce(new Response(JSON.stringify({})));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResearchItems()).resolves.toEqual({ items: [] });
    await expect(fetchResearchTheses("research-1")).resolves.toEqual({ current: null, versions: [] });
    await expect(fetchResearchCatalysts("research-1")).resolves.toEqual({ catalysts: [] });
    await expect(syncResearchCatalystsFromThesis("research-1")).resolves.toEqual({ catalysts: [] });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/research-items", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/research-items/research-1/thesis", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/research-items/research-1/catalysts", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/research-items/research-1/catalysts", expect.objectContaining({ method: "POST", credentials: "include" }));
  });

  test("normalizes incomplete valuations payloads to an empty run list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({})));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchValuations()).resolves.toEqual({ runs: [] });

    expect(fetchMock).toHaveBeenCalledWith("/api/valuations", expect.objectContaining({ credentials: "include" }));
  });

  test("normalizes incomplete chart payloads using the requested company", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({})));
    vi.stubGlobal("fetch", fetchMock);
    const company = {
      id: "eastmoney:1.600519",
      name: "贵州茅台",
      code: "600519",
      exchange: "上海证券交易所",
      listingPlace: "沪A",
      marketType: "AStock",
      quoteId: "1.600519",
      source: "eastmoney" as const,
    };

    await expect(fetchChartData({ company, priceMode: "adjusted" })).resolves.toMatchObject({
      company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
      priceMode: "adjusted",
      priceSeries: [],
      drawdownSeries: [],
      marketSnapshot: {},
      evidence: [],
    });
  });

  test("rejects incomplete company news payloads before storing them in UI state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({})));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCompanyNews("watch-1")).rejects.toThrow("新闻读取失败。");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/company-news?watchlistId=watch-1"), expect.objectContaining({ credentials: "include", cache: "no-store" }));
  });

  test("preserves radar refresh warnings returned with cached fallback data", async () => {
    const radar = {
      id: "radar-1",
      title: "行业雷达扫描",
      generatedAt: "2026-05-17T00:00:00.000Z",
      asOfDate: "2026-05-17",
      validUntil: "2026-05-17T12:00:00.000Z",
      model: "deepseek-v4-flash",
      sourceCount: 72,
      sourceQueries: ["A股 行业 景气"],
      fromCache: true,
      executiveSummary: ["旧扫描继续可用。"],
      solidGrowth: [],
      sustainability: [],
      bubbleRisks: [],
      upcomingGrowth: [],
      decliningIndustries: [],
      representativeCompanies: [],
      stageCompanies: [],
      limitations: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ radar, warning: "模型限流，已保留上次扫描。" }))));

    await expect(refreshRadarScan()).resolves.toMatchObject({
      radar: {
        id: "radar-1",
        refreshWarning: "模型限流，已保留上次扫描。",
      },
      warning: "模型限流，已保留上次扫描。",
    });
  });
});
