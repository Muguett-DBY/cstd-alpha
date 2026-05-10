import { describe, expect, test, vi } from "vitest";
import { fetchChartBundle, fetchPublicCompanyEvidence, searchCompanyCandidates } from "./providers";

describe("public data providers", () => {
  test("prioritizes Eastmoney Chinese market candidates before Yahoo fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        QuotationCodeTable: {
          Data: [
            {
              Code: "000002",
              Name: "万科A",
              JYS: "6",
              Classify: "AStock",
              SecurityTypeName: "深A",
              QuoteID: "0.000002",
            },
          ],
        },
      }),
    });

    const result = await searchCompanyCandidates("万科A", fetchMock);

    expect(result[0]).toMatchObject({
      name: "万科A",
      code: "000002",
      listingPlace: "深A",
      quoteId: "0.000002",
      source: "eastmoney",
    });
    expect(result[0].name).not.toContain("Agilent");
  });

  test("normalizes common Chinese company searches across A/H/US markets", async () => {
    const responses = [
      [{ Code: "AAPL", Name: "苹果", JYS: "NASDAQ", Classify: "UsStock", SecurityTypeName: "美股", QuoteID: "105.AAPL" }],
      [{ Code: "00700", Name: "腾讯控股", JYS: "HK", Classify: "HK", SecurityTypeName: "港股", QuoteID: "116.00700" }],
      [{ Code: "600519", Name: "贵州茅台", JYS: "2", Classify: "AStock", SecurityTypeName: "沪A", QuoteID: "1.600519" }],
    ];
    const fetchMock = vi.fn().mockImplementation(() => {
      const Data = responses.shift() ?? [];
      return Promise.resolve({
        ok: true,
        json: async () => ({ QuotationCodeTable: { Data } }),
      });
    });

    await expect(searchCompanyCandidates("苹果", fetchMock)).resolves.toMatchObject([{ code: "AAPL", listingPlace: "美股" }]);
    await expect(searchCompanyCandidates("腾讯", fetchMock)).resolves.toMatchObject([{ code: "00700", listingPlace: "港股" }]);
    await expect(searchCompanyCandidates("贵州茅台", fetchMock)).resolves.toMatchObject([{ code: "600519", listingPlace: "沪A" }]);
  });

  test("normalizes Yahoo quote and summary data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quotes: [{ symbol: "AAPL", longname: "Apple Inc.", quoteType: "EQUITY" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quoteResponse: {
            result: [{ symbol: "AAPL", regularMarketPrice: 190, marketCap: 2900000000000 }],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quoteSummary: {
            result: [
              {
                assetProfile: { industry: "Consumer Electronics", sector: "Technology" },
                financialData: { returnOnEquity: { raw: 1.2 } },
              },
            ],
          },
        }),
      });

    const result = await fetchPublicCompanyEvidence({ companyName: "Apple", fetchImpl: fetchMock });

    expect(result.company.ticker).toBe("AAPL");
    expect(result.facts.quote.regularMarketPrice).toBe(190);
    expect(result.evidence.some((item) => item.freshness === "latest-public")).toBe(true);
  });

  test("records unavailable evidence instead of inventing facts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const result = await fetchPublicCompanyEvidence({ companyName: "Unknown Co", fetchImpl: fetchMock });

    expect(result.company.name).toBe("Unknown Co");
    expect(result.evidence[0].freshness).toBe("unavailable");
    expect(result.facts.quote).toBeUndefined();
  });

  test("fetches Eastmoney ten-year price points with requested price mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          name: "万  科Ａ",
          code: "000002",
          klines: [
            "2016-07-04,14.61,14.61,14.61,14.61,42663,93815937.00,0.00,-14.31,-2.44,0.04",
            "2026-05-08,3.97,4.00,4.03,3.95,1109767,443314476.00,2.01,0.50,0.02,1.14",
          ],
        },
      }),
    });

    const result = await fetchChartBundle({
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
      priceMode: "adjusted",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("fqt=1"), expect.any(Object));
    expect(result.priceSeries).toHaveLength(2);
    expect(result.drawdownSeries.at(-1)?.drawdown).toBeLessThan(0);
    expect(result.evidence[0]).toMatchObject({ freshness: "latest-public" });
  });

  test("fetches Yahoo ten-year monthly price points for overseas companies", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: { symbol: "AAPL", currency: "USD", exchangeName: "NMS", regularMarketPrice: 200 },
              timestamp: [1464753600, 1496289600],
              indicators: { quote: [{ close: [90, 120], open: [88, 118], high: [92, 122], low: [86, 116], volume: [1000, 1200] }] },
            },
          ],
        },
      }),
    });

    const result = await fetchChartBundle({
      company: {
        id: "yahoo:AAPL",
        name: "Apple Inc.",
        code: "AAPL",
        exchange: "NASDAQ",
        listingPlace: "NASDAQ",
        marketType: "EQUITY",
        yahooSymbol: "AAPL",
        source: "yahoo",
      },
      priceMode: "raw",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("range=10y&interval=1mo"), expect.any(Object));
    expect(result.company.ticker).toBe("AAPL");
    expect(result.priceSeries).toEqual([
      expect.objectContaining({ date: "2016-06-01", close: 90 }),
      expect.objectContaining({ date: "2017-06-01", close: 120 }),
    ]);
  });

  test("records unavailable chart evidence instead of fabricating price points", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const result = await fetchChartBundle({
      company: {
        id: "yahoo:BAD",
        name: "Bad Data",
        code: "BAD",
        exchange: "NYSE",
        listingPlace: "NYSE",
        marketType: "EQUITY",
        yahooSymbol: "BAD",
        source: "yahoo",
      },
      priceMode: "raw",
      fetchImpl: fetchMock,
    });

    expect(result.priceSeries).toEqual([]);
    expect(result.evidence[0].freshness).toBe("unavailable");
  });

  test("falls back to chart and fundamentals when quoteSummary endpoints are unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quotes: [
            {
              symbol: "AAPL",
              longname: "Apple Inc.",
              exchDisp: "NASDAQ",
              sector: "Technology",
              industry: "Consumer Electronics",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chart: {
            result: [
              {
                meta: {
                  symbol: "AAPL",
                  longName: "Apple Inc.",
                  regularMarketPrice: 293.32,
                  exchangeName: "NMS",
                },
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          timeseries: {
            result: [
              {
                meta: { type: ["trailingTotalRevenue"] },
                trailingTotalRevenue: [{ raw: 391000000000, asOfDate: "2025-09-30" }],
              },
            ],
          },
        }),
      });

    const result = await fetchPublicCompanyEvidence({ companyName: "Apple", fetchImpl: fetchMock });

    expect(result.company.ticker).toBe("AAPL");
    expect(result.company.sector).toBe("Technology");
    expect(result.facts.quote.regularMarketPrice).toBe(293.32);
    expect(result.facts.fundamentals.trailingTotalRevenue).toEqual([{ raw: 391000000000, asOfDate: "2025-09-30" }]);
    expect(result.evidence.filter((item) => item.freshness === "latest-public")).toHaveLength(3);
  });
});
