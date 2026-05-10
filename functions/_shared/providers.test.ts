import { describe, expect, test, vi } from "vitest";
import { fetchPublicCompanyEvidence } from "./providers";

describe("public data providers", () => {
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
});
