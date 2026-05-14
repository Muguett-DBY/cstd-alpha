import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchChartData, fetchReportLibrary, generateReport, searchCompanies } from "./api";

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
});
