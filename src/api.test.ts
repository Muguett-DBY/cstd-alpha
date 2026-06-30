import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addResearchItem,
  addWatchlistItem,
  checkSession,
  completeResearchTemplateDraft,
  createValuationRun,
  fetchActivityEvents,
  fetchChartData,
  fetchCompanyNews,
  fetchOpportunities,
  fetchQuantitativeValuationWorkspace,
  fetchRadarScan,
  fetchReportLibrary,
  fetchReportLibraryRecord,
  fetchTemplateAnalyses,
  fetchWatchlist,
  fetchWatchlistRanking,
  importReportLibraryReports,
  fetchResearchCatalysts,
  fetchResearchItems,
  fetchResearchTemplates,
  fetchResearchTheses,
  fetchValuations,
  generateReport,
  login,
  refreshResearchThesis,
  resetResearchTemplatesToDefault,
  saveResearchTemplates,
  saveResearchTemplatesAsDefault,
  saveQuantitativeValuationWorkspace,
  searchCompanies,
  refreshRadarScan,
  refreshWatchlistRanking,
  sendAssistantMessage,
  fetchAssistantThread,
  fetchAssistantDeepResearchJob,
  stopAssistantDeepResearchJob,
  listAssistantThreads,
  createAssistantThread,
  syncResearchCatalystsFromThesis,
  updateResearchCatalystStatus,
  updateResearchItemStage,
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

  test("rejects malformed assistant SSE event payloads before callbacks consume them", async () => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start", threadId: "t1", messageId: "m1" })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "deep_research_job",
          job: {
            id: "deep-1",
            threadId: "t1",
            query: "茅台明年利润预测",
            mode: "target",
            researchKind: "forecast",
            status: "paused",
            progressTitle: "处理中",
            progressStage: "collect",
            progressCurrent: 1,
            progressTotal: 4,
            stopRequested: false,
            createdAt: "2026-06-30T00:00:00.000Z",
            updatedAt: "2026-06-30T00:00:00.000Z",
          },
        })}\n\n`));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    const events: string[] = [];

    await expect(sendAssistantMessage("宁德时代怎么看？", (event) => events.push(event.type))).rejects.toThrow("助手响应不完整，请重试。");
    expect(events).toEqual(["start"]);
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

  test("rejects malformed assistant thread responses before UI state consumes them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      thread: {
        id: "thread-1",
        title: "坏会话",
        summary: "missing arrays",
        updatedAt: "2026-06-30T00:00:00.000Z",
        messages: [{ id: "m1", threadId: "thread-1", role: "robot", content: "bad", createdAt: "2026-06-30T00:00:00.000Z" }],
        memories: "broken",
        memoryCandidates: [],
      },
    })));

    await expect(fetchAssistantThread("thread-1")).rejects.toThrow("助手线程读取失败。");
  });

  test("rejects malformed assistant deep research jobs before progress cards render them", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        job: {
          id: "deep-1",
          threadId: "thread-1",
          query: "茅台预测",
          mode: "target",
          researchKind: "forecast",
          status: "running",
          progressTitle: "处理中",
          progressStage: "collect",
          progressCurrent: 2,
          progressTotal: "4",
          stopRequested: false,
          createdAt: "2026-06-30T00:00:00.000Z",
          updatedAt: "2026-06-30T00:00:00.000Z",
        },
      }))
      .mockResolvedValueOnce(Response.json({
        job: {
          id: "deep-1",
          threadId: "thread-1",
          query: "茅台预测",
          mode: "target",
          researchKind: "forecast",
          status: "paused",
          progressTitle: "处理中",
          progressStage: "collect",
          progressCurrent: 2,
          progressTotal: 4,
          stopRequested: true,
          createdAt: "2026-06-30T00:00:00.000Z",
          updatedAt: "2026-06-30T00:00:00.000Z",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAssistantDeepResearchJob("deep-1")).rejects.toThrow("深度研究状态读取失败。");
    await expect(stopAssistantDeepResearchJob("deep-1")).rejects.toThrow("深度研究停止失败。");
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

  test("rejects malformed quantitative valuation workspace payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspace: { versions: { not: "an array" }, actualReviews: [] } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchQuantitativeValuationWorkspace("run-1")).rejects.toThrow("估值工作区读取失败。");
  });

  test("rejects malformed quantitative valuation save workspace payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      workspace: { versions: [], actualReviews: { not: "an array" } },
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

    await expect(saveQuantitativeValuationWorkspace({
      runId: "run-1",
      parentVersionId: "version-1",
      assumptions: [],
    })).rejects.toThrow("估值保存失败。");
  });

  test("rejects malformed quantitative valuation save version payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      workspace: { versions: [], actualReviews: [] },
      version: { id: "broken" },
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveQuantitativeValuationWorkspace({
      runId: "run-1",
      parentVersionId: "version-1",
      assumptions: [],
    })).rejects.toThrow("估值保存失败。");
  });

  test("rejects login responses that omit the user payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true }))));

    await expect(login("pw", "admin")).rejects.toThrow("服务端未返回账号信息");
  });

  test("rejects malformed session users during startup checks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { userId: "user-admin", role: "admin" } }))));

    await expect(checkSession()).rejects.toThrow("登录状态读取失败");
  });

  test("rejects login responses with invalid user roles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      user: {
        userId: "user-admin",
        username: "admin",
        displayName: "Admin",
        role: "superadmin",
      },
    }))));

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
    const entry = {
      id: "report-1",
      companyName: "微软",
      ticker: "MSFT",
      market: "美股",
      industry: "软件",
      sector: "信息技术",
      cqs: 80,
      ias: 70,
      conclusion: "观察",
      qualitativeBand: "良好",
      positionAdvice: "观察仓",
      valuationView: "合理",
      asOf: "2026-05-10T00:00:00.000Z",
      importedAt: "2026-05-10T00:00:00.000Z",
      evidenceCount: 0,
      scoreItemCount: 0,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ entry, report })));
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

  test("filters malformed report library entries before ranking consumers render them", async () => {
    const entry = {
      id: "report-msft",
      companyName: "微软",
      ticker: "MSFT",
      market: "美股",
      industry: "软件",
      sector: "信息技术",
      cqs: 88,
      ias: 82,
      conclusion: "买入" as const,
      qualitativeBand: "优秀",
      positionAdvice: "标准仓 8-15%",
      valuationView: "合理偏低",
      asOf: "2026-06-30T00:00:00.000Z",
      importedAt: "2026-07-01T00:00:00.000Z",
      evidenceCount: 12,
      scoreItemCount: 20,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [{ id: "broken" }, entry], total: 2, matchedTickers: [1, "MSFT"] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entry: { id: "broken" }, report: { company: { name: "微软" } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ imported: [{ id: "broken" }] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReportLibrary()).resolves.toEqual({
      entries: [entry],
      total: 2,
      limit: undefined,
      offset: undefined,
      matchedTickers: ["MSFT"],
      skippedEntries: 1,
    });
    await expect(fetchReportLibraryRecord("broken")).rejects.toThrow("报告读取失败。");
    await expect(importReportLibraryReports([])).rejects.toThrow("报告导入失败。");
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

  test("filters malformed radar scan payloads before the radar view renders them", async () => {
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
      .mockResolvedValueOnce(new Response(JSON.stringify({
        radar: { id: "broken-radar", executiveSummary: "not-array" },
        job: { id: "broken-job", status: "lost" },
        diagnostics: { jobStatus: "lost" },
        warning: 404,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        radar,
        job: { id: "job-1", status: "running", createdAt: "2026-05-17T00:00:00.000Z", updatedAt: "2026-05-17T00:01:00.000Z" },
        diagnostics: { jobStatus: "running", sourceCount: 12 },
        warning: "模型限流，已保留上次扫描。",
      })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRadarScan()).resolves.toEqual({ radar: null, job: null, diagnostics: null, warning: undefined });
    await expect(refreshRadarScan()).resolves.toMatchObject({
      radar: { id: "radar-1", refreshWarning: "模型限流，已保留上次扫描。" },
      job: { id: "job-1", status: "running" },
      diagnostics: { jobStatus: "running", sourceCount: 12 },
      warning: "模型限流，已保留上次扫描。",
    });
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

  test("reports malformed research queue records that were skipped", async () => {
    const item = {
      id: "research-1",
      userKey: "user-1",
      entityType: "company" as const,
      entityId: "eastmoney:1.600519",
      title: "贵州茅台",
      stage: "deepResearch" as const,
      status: "active",
      source: "eastmoney",
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ id: "broken" }, null, item] }))));

    await expect(fetchResearchItems()).resolves.toEqual({
      items: [item],
      skippedItems: 2,
      totalItems: 3,
    });
  });

  test("guards malformed research detail records before workspace consumers render them", async () => {
    const activity = {
      id: "activity-1",
      itemId: "research-1",
      eventType: "created",
      title: "研究项创建",
      description: null,
      metadata: { source: "eastmoney" },
      createdAt: "2026-06-30T00:00:00.000Z",
    };
    const thesis = {
      id: "thesis-1",
      itemId: "research-1",
      version: 1,
      thesisMarkdown: "## 论点",
      coreCitations: ["E1"],
      counterEvidence: [],
      createdBy: "assistant",
      createdAt: "2026-06-30T00:00:00.000Z",
    };
    const catalyst = {
      id: "catalyst-1",
      itemId: "research-1",
      title: "销量确认",
      status: "open" as const,
      evidenceRefs: ["E1"],
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    };
    const item = {
      id: "research-1",
      userKey: "user-1",
      entityType: "company" as const,
      entityId: "eastmoney:1.600519",
      title: "贵州茅台",
      stage: "deepResearch" as const,
      status: "active",
      source: "eastmoney",
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    };
    const malformed = { id: "broken" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [malformed, activity] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ current: malformed, versions: [malformed, thesis] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ catalysts: [malformed, catalyst] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ catalysts: [malformed, catalyst], created: "2" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ thesis: malformed, item })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ catalyst: malformed })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchActivityEvents("research-1")).resolves.toEqual([activity]);
    await expect(fetchResearchTheses("research-1")).resolves.toEqual({ current: null, versions: [thesis] });
    await expect(fetchResearchCatalysts("research-1")).resolves.toEqual({ catalysts: [catalyst] });
    await expect(syncResearchCatalystsFromThesis("research-1")).resolves.toEqual({ catalysts: [catalyst] });
    await expect(refreshResearchThesis("research-1")).rejects.toThrow("研究论点生成失败。");
    await expect(updateResearchCatalystStatus("research-1", "catalyst-1", "confirmed")).rejects.toThrow("研究跟踪项状态更新失败。");
  });

  test("normalizes incomplete valuations payloads to an empty run list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({})));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchValuations()).resolves.toEqual({ runs: [] });

    expect(fetchMock).toHaveBeenCalledWith("/api/valuations", expect.objectContaining({ credentials: "include" }));
  });

  test("filters malformed valuation run records before UI consumers render them", async () => {
    const run = {
      id: "valuation-1",
      researchItemId: "research-1",
      entityType: "company" as const,
      entityId: "eastmoney:1.600519",
      title: "贵州茅台",
      status: "queued" as const,
      method: "dcf_3_statement" as const,
      archetype: "operating" as const,
      currency: "CNY",
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ runs: [{ id: "broken" }, run] }))));

    await expect(fetchValuations()).resolves.toEqual({ runs: [run] });
  });

  test("rejects malformed research stage mutation payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ item: { id: "broken" } }))));

    await expect(updateResearchItemStage("research-1", "deepResearch")).rejects.toThrow("研究阶段更新失败。");
  });

  test("rejects malformed valuation creation payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ run: { id: "broken" } }), { status: 202 })));

    await expect(createValuationRun({
      researchItemId: "research-1",
      entityType: "company",
      entityId: "eastmoney:1.600519",
      title: "贵州茅台",
      currency: "CNY",
    })).rejects.toThrow("估值任务创建失败。");
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

  test("normalizes malformed list envelopes before UI consumers iterate them", async () => {
    const user = { userId: "user-admin", username: "admin", displayName: "Admin", role: "admin" as const };
    const malformedList = { not: "an array" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: malformedList })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: malformedList })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: malformedList, total: "many", limit: "20", offset: "0", matchedTickers: malformedList })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ imported: malformedList })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: malformedList, user })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: malformedList, watchlist: malformedList })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: malformedList, queued: malformedList, reused: malformedList })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ analyses: malformedList, templates: malformedList })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ templates: malformedList })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ templates: malformedList })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ templates: malformedList })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ templates: malformedList })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchCompanies("茅台")).resolves.toEqual([]);
    await expect(fetchActivityEvents("research-1")).resolves.toEqual([]);
    await expect(fetchReportLibrary()).resolves.toEqual({ entries: [], total: 0, limit: undefined, offset: undefined, matchedTickers: [] });
    await expect(importReportLibraryReports([])).resolves.toEqual([]);
    await expect(fetchWatchlist()).resolves.toEqual({ items: [], user });
    await expect(fetchWatchlistRanking()).resolves.toEqual({ entries: [], watchlist: [] });
    await expect(refreshWatchlistRanking()).resolves.toEqual({ entries: [], queued: [], reused: [] });
    await expect(fetchTemplateAnalyses()).resolves.toEqual({ analyses: [], templates: [] });
    await expect(fetchResearchTemplates()).resolves.toEqual([]);
    await expect(saveResearchTemplates([])).resolves.toEqual([]);
    await expect(saveResearchTemplatesAsDefault()).resolves.toEqual([]);
    await expect(resetResearchTemplatesToDefault()).resolves.toEqual([]);
  });

  test("filters malformed watchlist records before research views render them", async () => {
    const company = {
      id: "eastmoney:1.600519",
      name: "贵州茅台",
      code: "600519",
      exchange: "上海证券交易所",
      listingPlace: "A股",
      marketType: "AStock",
      source: "eastmoney" as const,
    };
    const watchlistItem = {
      id: "watch-1",
      userId: "user-admin",
      company,
      addedAt: "2026-06-30T00:00:00.000Z",
    };
    const rankingEntry = {
      watchlistId: "watch-1",
      companyName: "贵州茅台",
      ticker: "600519",
      market: "A股",
      status: "completed" as const,
      overallScore: 86,
      keyPoints: ["现金流稳健"],
      riskFlags: [],
    };
    const user = { userId: "user-admin", username: "admin", displayName: "Admin", role: "admin" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "broken" }, watchlistItem], user })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ item: { id: "broken" }, status: "updated" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [{ watchlistId: "broken" }, rankingEntry], watchlist: [{ id: "broken" }, watchlistItem] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [{ watchlistId: "broken" }, rankingEntry], queued: [1, "watch-1"], reused: [null, "watch-2"] }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWatchlist()).resolves.toEqual({ items: [watchlistItem], user });
    await expect(addWatchlistItem({ company })).rejects.toThrow("加入自选失败。");
    await expect(fetchWatchlistRanking()).resolves.toEqual({ entries: [rankingEntry], watchlist: [watchlistItem] });
    await expect(refreshWatchlistRanking()).resolves.toEqual({ entries: [rankingEntry], queued: ["watch-1"], reused: ["watch-2"] });
  });

  test("filters malformed company candidates and returns research upsert status", async () => {
    const company = {
      id: "eastmoney:1.600519",
      name: "贵州茅台",
      code: "600519",
      exchange: "上海证券交易所",
      listingPlace: "A股",
      marketType: "AStock",
      source: "eastmoney" as const,
    };
    const item = {
      id: "research-row-1",
      userKey: "user-1",
      entityType: "company" as const,
      entityId: company.id,
      title: company.name,
      stage: "screening" as const,
      status: "active",
      source: company.source,
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ name: "坏数据" }, company, null] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ item, status: "updated" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchCompanies("茅台")).resolves.toEqual([company]);
    await expect(addResearchItem({
      entityType: "company",
      entityId: company.id,
      title: company.name,
      source: company.source,
    })).resolves.toEqual({ item, status: "updated" });
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
