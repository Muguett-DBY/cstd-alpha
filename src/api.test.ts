import { afterEach, describe, expect, test, vi } from "vitest";
import {
  completeResearchTemplateDraft,
  fetchChartData,
  fetchRadarScan,
  fetchReportLibrary,
  fetchResearchTemplates,
  generateReport,
  login,
  resetResearchTemplatesToDefault,
  saveResearchTemplates,
  saveResearchTemplatesAsDefault,
  searchCompanies,
  refreshRadarScan,
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

  test("rejects login responses that omit the user payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true }))));

    await expect(login("pw", "admin")).rejects.toThrow("服务端未返回账号信息");
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

    await expect(fetchRadarScan()).resolves.toEqual({ radar, job: null, warning: undefined });
    await expect(refreshRadarScan()).resolves.toEqual({ radar: { ...radar, fromCache: true }, job: null, warning: undefined });

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
