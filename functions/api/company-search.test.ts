import { describe, expect, test, vi } from "vitest";
import { searchLocalCompanyUniverse } from "./company-search";

describe("company search local universe", () => {
  test("returns A/H candidates from D1 before external providers are needed", async () => {
    const db = fakeD1([
      {
        company_id: "company-600519",
        name_cn: "贵州茅台",
        name_en: "Kweichow Moutai",
        country: "CN",
        company_exchange: "SSE",
        main_business: "白酒",
        ticker: "600519",
        market: "A股",
      },
      {
        company_id: "company-00700",
        name_cn: "腾讯控股",
        name_en: "Tencent Holdings",
        country: "CN",
        company_exchange: "HKEX",
        main_business: "互联网平台",
        ticker: "00700",
        market: "港股",
      },
    ]);

    await expect(searchLocalCompanyUniverse(db, "腾讯")).resolves.toMatchObject([
      {
        name: "贵州茅台",
        code: "600519",
        listingPlace: "沪A",
        marketType: "AStock",
        quoteId: "1.600519",
        source: "eastmoney",
      },
      {
        name: "腾讯控股",
        code: "00700",
        listingPlace: "港股",
        marketType: "HK",
        quoteId: "116.700",
        yahooSymbol: "0700.HK",
        source: "eastmoney",
      },
    ]);
  });

  test("falls back to an empty result when D1 is unavailable or query is blank", async () => {
    await expect(searchLocalCompanyUniverse(undefined, "贵州")).resolves.toEqual([]);
    await expect(searchLocalCompanyUniverse(fakeD1([]), " ")).resolves.toEqual([]);
  });
});

function fakeD1(results: unknown[]): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results }),
      })),
    })),
  } as unknown as D1Database;
}
