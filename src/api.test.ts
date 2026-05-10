import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchChartData, generateReport, searchCompanies } from "./api";

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
});
