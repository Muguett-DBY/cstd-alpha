import { describe, expect, test, vi } from "vitest";
import { fetchPublicCompanyEvidence, searchCompanyCandidates } from "./providers";

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
