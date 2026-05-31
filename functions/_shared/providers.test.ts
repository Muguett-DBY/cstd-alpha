import { describe, expect, test, vi } from "vitest";
import { buildFinancialTenYearFromEastmoney, buildFinancialTenYearFromSecFacts, fetchChartBundle, fetchPublicCompanyEvidence, searchCompanyCandidates } from "./providers";

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

  test("keeps Yahoo global candidates when Eastmoney also returns local matches", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          QuotationCodeTable: {
            Data: [
              {
                Code: "000001",
                Name: "平安银行",
                JYS: "6",
                Classify: "AStock",
                SecurityTypeName: "深A",
                QuoteID: "0.000001",
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quotes: [
            {
              symbol: "NVDA",
              shortname: "NVIDIA Corporation",
              longname: "NVIDIA Corporation",
              quoteType: "EQUITY",
              exchange: "NMS",
              exchDisp: "NASDAQ",
            },
          ],
        }),
      });

    const result = await searchCompanyCandidates("NVDA", fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "000001", source: "eastmoney" }),
        expect.objectContaining({ code: "NVDA", source: "yahoo" }),
      ]),
    );
  });

  test("passes an abort signal to provider fetch requests", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        QuotationCodeTable: {
          Data: [{ Code: "000002", Name: "万科A", JYS: "6", Classify: "AStock", SecurityTypeName: "深A", QuoteID: "0.000002" }],
        },
      }),
    });

    await searchCompanyCandidates("万科A", fetchMock, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
  });

  test("normalizes common Chinese company searches across A/H/US markets", async () => {
    const responses: Record<string, Array<Record<string, string>>> = {
      苹果: [{ Code: "AAPL", Name: "苹果", JYS: "NASDAQ", Classify: "UsStock", SecurityTypeName: "美股", QuoteID: "105.AAPL" }],
      腾讯: [{ Code: "00700", Name: "腾讯控股", JYS: "HK", Classify: "HK", SecurityTypeName: "港股", QuoteID: "116.00700" }],
      贵州茅台: [{ Code: "600519", Name: "贵州茅台", JYS: "2", Classify: "AStock", SecurityTypeName: "沪A", QuoteID: "1.600519" }],
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("query2.finance.yahoo.com")) {
        return Promise.resolve({ ok: true, json: async () => ({ quotes: [] }) });
      }
      const input = decodeURIComponent(new URL(url).searchParams.get("input") || "");
      const Data = responses[input] ?? [];
      return Promise.resolve({
        ok: true,
        json: async () => ({ QuotationCodeTable: { Data } }),
      });
    });

    await expect(searchCompanyCandidates("苹果", fetchMock)).resolves.toMatchObject([{ code: "AAPL", listingPlace: "美股" }]);
    await expect(searchCompanyCandidates("腾讯", fetchMock)).resolves.toMatchObject([{ code: "00700", listingPlace: "港股", yahooSymbol: "0700.HK" }]);
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

  test("falls back to a derived Eastmoney quote id for A-share quote snapshots", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            f57: "601600",
            f58: "中国铝业",
            f43: 1178,
            f116: 202085562232.06,
            f162: 914,
            f167: 251,
          },
        }),
      })
      .mockResolvedValue({ ok: true, json: async () => ({ result: { data: [] } }) });

    const result = await fetchPublicCompanyEvidence({
      companyName: "中国铝业",
      company: {
        id: "eastmoney:bad-601600",
        name: "中国铝业",
        code: "601600",
        exchange: "上海证券交易所",
        listingPlace: "沪A",
        marketType: "AStock",
        quoteId: "bad-601600",
        source: "eastmoney",
      },
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining("secid=1.601600"), expect.any(Object));
    expect(result.facts.quote).toMatchObject({
      symbol: "601600",
      regularMarketPrice: 11.78,
      trailingPE: 9.14,
      priceToBook: 2.51,
    });
    expect(result.evidence.find((item) => item.title.includes("Eastmoney quote snapshot"))).toMatchObject({
      freshness: "latest-public",
    });
  });

  test("falls back to Eastmoney kline for A-share price when quote snapshot is unavailable", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("push2.eastmoney.com")) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      }
      if (url.includes("push2his.eastmoney.com")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: {
              code: "605287",
              name: "德才股份",
              klines: [
                "2026-05-11,63.77,62.26,66.21,60.35,119153,750558124.00,9.27,-1.49,-0.94,8.51",
                "2026-05-12,61.14,56.03,62.30,56.03,78947,456639793.00,10.07,-10.01,-6.23,5.64",
              ],
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ result: { data: [] } }) });
    });

    const result = await fetchPublicCompanyEvidence({
      companyName: "德才股份",
      company: {
        id: "eastmoney:1.605287",
        name: "德才股份",
        code: "605287",
        exchange: "上海证券交易所",
        listingPlace: "沪A",
        marketType: "AStock",
        quoteId: "1.605287",
        source: "eastmoney",
      },
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("push2his.eastmoney.com"), expect.any(Object));
    expect(result.facts.quote).toMatchObject({
      symbol: "605287",
      longName: "德才股份",
      regularMarketPrice: 56.03,
      regularMarketDayHigh: 62.3,
      regularMarketDayLow: 56.03,
      regularMarketOpen: 61.14,
      regularMarketPreviousClose: 62.26,
      regularMarketChange: -6.23,
      regularMarketChangePercent: -10.01,
    });
    expect(result.evidence.find((item) => item.title.includes("Eastmoney quote snapshot"))).toMatchObject({
      freshness: "latest-public",
      notes: expect.stringContaining("kline fallback"),
    });
    expect(result.evidence).not.toEqual(expect.arrayContaining([expect.objectContaining({ source: "Yahoo Finance public quote endpoint" })]));
  });

  test("derives Shanghai secucode for legacy SH-A watchlist rows", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("push2.eastmoney.com")) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      }
      if (url.includes("push2his.eastmoney.com")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: {
              code: "600519",
              name: "贵州茅台",
              klines: ["2026-05-22,1500.00,1510.00,1520.00,1490.00,10000,1510000000.00,2.00,0.67,10.00,0.1"],
            },
          }),
        });
      }
      if (url.includes("datacenter.eastmoney.com") && url.includes("600519.SH")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            result: {
              data: [{ REPORT_DATE: "2025-12-31 00:00:00", TOTAL_OPERATE_INCOME: 180000000000, PARENT_NETPROFIT: 82000000000 }],
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ result: { data: [] } }) });
    });

    const result = await fetchPublicCompanyEvidence({
      companyName: "贵州茅台",
      company: {
        id: "watchlist:SH-A:600519",
        name: "贵州茅台",
        code: "600519",
        exchange: "SH-A",
        listingPlace: "SH-A",
        marketType: "Library",
        source: "eastmoney",
      },
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("600519.SH"), expect.any(Object));
    expect(result.evidence.find((item) => item.title.includes("Eastmoney financial statements"))).toMatchObject({
      freshness: "latest-public",
    });
  });

  test("falls back to Tencent A-share quote when Eastmoney quote and kline are unavailable", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("push2.eastmoney.com") || url.includes("push2his.eastmoney.com")) {
        return Promise.resolve({ ok: false, status: 502, json: async () => ({}) });
      }
      if (url.includes("qt.gtimg.cn")) {
        return Promise.resolve({
          ok: true,
          text: async () =>
            'v_sz002001="51~XHC~002001~32.92~33.50~33.20~333367~~~~~~~~~~~~~~~~~~~~~~~20260513161427~-0.58~-1.73~33.63~32.60~32.92/333367/1099587354~333367~109959~1.10~15.08~~~~~999.73~1011.77~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~CNY~0~~33.02~-270~";',
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ result: { data: [] } }) });
    });

    const result = await fetchPublicCompanyEvidence({
      companyName: "新和成",
      company: {
        id: "eastmoney:0.002001",
        name: "新和成",
        code: "002001",
        exchange: "深圳证券交易所",
        listingPlace: "深A",
        marketType: "AStock",
        quoteId: "0.002001",
        source: "eastmoney",
      },
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("qt.gtimg.cn/q=sz002001"), expect.any(Object));
    expect(result.facts.quote).toMatchObject({
      symbol: "002001",
      longName: "新和成",
      regularMarketPrice: 32.92,
      regularMarketPreviousClose: 33.5,
      regularMarketOpen: 33.2,
      currency: "CNY",
      quoteSourceName: "Tencent",
    });
    expect(result.evidence.find((item) => item.title.includes("Tencent quote fallback"))).toMatchObject({
      freshness: "latest-public",
    });
  });

  test("does not treat all-zero Eastmoney A-share quotes as usable prices", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("push2.eastmoney.com")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { f57: "688635", f58: "长进光子", f43: 0, f44: 0, f45: 0, f46: 0, f60: 0, f116: 0 } }),
        });
      }
      if (url.includes("push2his.eastmoney.com")) {
        return Promise.resolve({ ok: true, json: async () => ({ data: { klines: [] } }) });
      }
      if (url.includes("qt.gtimg.cn")) {
        return Promise.resolve({ ok: true, text: async () => 'v_sh688635="1~CJGZ~688635~0.00~0.00~0.00~0";' });
      }
      return Promise.resolve({ ok: true, json: async () => ({ result: { data: [] } }) });
    });

    const result = await fetchPublicCompanyEvidence({
      companyName: "长进光子",
      company: {
        id: "eastmoney:1.688635",
        name: "长进光子",
        code: "688635",
        exchange: "上海证券交易所",
        listingPlace: "科创板",
        marketType: "AStock",
        quoteId: "1.688635",
        source: "eastmoney",
      },
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.facts.quote).toBeUndefined();
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

  test("uses raw Eastmoney closing prices for drawdown when displaying adjusted charts", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => ({
        data: {
          name: "贵州茅台",
          code: "600519",
          klines: url.includes("fqt=0")
            ? ["2024-01-01,10,10,10,10,100,1000,0,0,0,0", "2024-01-02,8,8,8,8,100,800,0,-20,0,0"]
            : ["2024-01-01,1,1,1,1,100,1000,0,0,0,0", "2024-01-02,8,8,8,8,100,800,0,700,0,0"],
        },
      }),
    }));

    const result = await fetchChartBundle({
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
      priceMode: "adjusted",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("fqt=1"), expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("fqt=0"), expect.any(Object));
    expect(result.priceSeries).toEqual([
      expect.objectContaining({ close: 1, rawClose: 10 }),
      expect.objectContaining({ close: 8, rawClose: 8 }),
    ]);
    expect(result.marketSnapshot.maxDrawdown).toBe(-20);
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

  test("falls back to Yahoo history when Eastmoney kline returns no usable price points", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { name: "万科A", code: "000002", klines: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chart: {
            result: [
              {
                meta: { symbol: "000002.SZ", currency: "CNY", exchangeName: "SHZ" },
                timestamp: [1464753600, 1496289600],
                indicators: { quote: [{ close: [20, 10], volume: [1000, 1200] }] },
              },
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
        yahooSymbol: "000002.SZ",
        source: "eastmoney",
      },
      priceMode: "raw",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.priceSeries).toHaveLength(2);
    expect(result.evidence[0].source).toContain("Yahoo");
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

  test("normalizes Eastmoney statement rows into named ten-year financial metrics", () => {
    const financialTenYear = buildFinancialTenYearFromEastmoney(
      [
        {
          REPORT_DATE: "2025-12-31 00:00:00",
          REPORT_DATE_NAME: "2025年报",
          TOTAL_OPERATE_INCOME: 170000000000,
          PARENT_NETPROFIT: 85000000000,
          DEDUCT_PARENT_NETPROFIT: 83000000000,
          TOTAL_OPERATE_COST: 18000000000,
        },
        {
          REPORT_DATE: "2024-12-31 00:00:00",
          REPORT_DATE_NAME: "2024年报",
          TOTAL_OPERATE_INCOME: 160000000000,
          PARENT_NETPROFIT: 80000000000,
          DEDUCT_PARENT_NETPROFIT: 79000000000,
          TOTAL_OPERATE_COST: 17000000000,
        },
        {
          REPORT_DATE: "2026-03-31 00:00:00",
          REPORT_DATE_NAME: "2026一季度",
          TOTAL_OPERATE_INCOME: 54000000000,
          PARENT_NETPROFIT: 27000000000,
        },
      ],
      [
        { REPORT_DATE: "2025-12-31 00:00:00", REPORT_DATE_NAME: "2025年报", NETCASH_OPERATE: 61000000000, END_CCE: 126000000000 },
        { REPORT_DATE: "2024-12-31 00:00:00", REPORT_DATE_NAME: "2024年报", NETCASH_OPERATE: 82000000000, END_CCE: 120000000000 },
      ],
      [
        {
          REPORT_DATE: "2025-12-31 00:00:00",
          REPORT_DATE_NAME: "2025年报",
          TOTAL_ASSETS: 300000000000,
          TOTAL_LIABILITIES: 50000000000,
          TOTAL_EQUITY: 250000000000,
          MONETARYFUNDS: 126000000000,
        },
        {
          REPORT_DATE: "2024-12-31 00:00:00",
          REPORT_DATE_NAME: "2024年报",
          TOTAL_ASSETS: 280000000000,
          TOTAL_LIABILITIES: 45000000000,
          TOTAL_EQUITY: 235000000000,
          MONETARYFUNDS: 120000000000,
        },
      ],
    );

    expect(financialTenYear.rows.map((row) => row.metric)).toEqual(
      expect.arrayContaining(["营业收入", "归母净利润", "扣非归母净利润", "经营现金流", "货币资金", "总资产", "总负债", "资产负债率", "净利率"]),
    );
    expect(financialTenYear.rows.some((row) => row.metric === "未命名指标")).toBe(false);
    expect(financialTenYear.rows.find((row) => row.metric === "营业收入")?.values).toMatchObject({
      "2024": "1600.00亿",
      "2025": "1700.00亿",
    });
    expect(financialTenYear.rows.find((row) => row.metric === "资产负债率")?.values["2025"]).toBe("16.67%");
    expect(financialTenYear.latestPeriod).toContain("2026一季度");
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

  test("normalizes SEC company facts into named USD financial rows", () => {
    const financialTenYear = buildFinancialTenYearFromSecFacts(secAppleFacts());

    expect(financialTenYear.rows.map((row) => row.metric)).toEqual(
      expect.arrayContaining(["营业收入", "净利润", "经营现金流", "总资产", "总负债", "股东权益", "摊薄每股收益", "股票回购支出"]),
    );
    expect(financialTenYear.rows.some((row) => row.metric === "未命名指标")).toBe(false);
    expect(financialTenYear.rows.find((row) => row.metric === "营业收入")?.values).toMatchObject({
      "2024": "3910.35亿美元",
      "2025": "4161.61亿美元",
    });
    expect(financialTenYear.rows.find((row) => row.metric === "资产负债率")?.values["2025"]).toBe("81.57%");
    expect(financialTenYear.latestPeriod).toBe("FY2025 10-K");
  });

  test("uses SEC fallback for AAPL when Yahoo is unavailable and fixes US quote scaling", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("push2.eastmoney.com")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: {
              f57: "AAPL",
              f58: "苹果",
              f43: 293320,
              f44: 294710,
              f45: 289110,
              f46: 291000,
              f47: 52690000,
              f60: 287440,
              f116: 4308095261920,
              f162: 0,
              f167: 4046,
              f169: 5880,
              f170: 205,
            },
          }),
        });
      }
      if (url.includes("company_tickers.json")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }),
        });
      }
      if (url.includes("companyfacts/CIK0000320193.json")) {
        return Promise.resolve({ ok: true, json: async () => secAppleFacts() });
      }
      return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
    });

    const result = await fetchPublicCompanyEvidence({
      companyName: "苹果",
      company: {
        id: "eastmoney:105.AAPL",
        name: "苹果",
        code: "AAPL",
        exchange: "美国市场",
        listingPlace: "美股",
        marketType: "UsStock",
        quoteId: "105.AAPL",
        secid: "105.AAPL",
        yahooSymbol: "AAPL",
        source: "eastmoney",
      },
      fetchImpl: fetchMock,
    });

    expect(result.company).toMatchObject({ name: "苹果", ticker: "AAPL", market: "美股" });
    expect(result.facts.quote).toMatchObject({
      regularMarketPrice: 293.32,
      regularMarketDayHigh: 294.71,
      regularMarketPreviousClose: 287.44,
      regularMarketChange: 5.88,
      regularMarketChangePercent: 2.05,
      priceToBook: 40.46,
    });
    expect((result.facts.quote as Record<string, unknown>).trailingPE).toBe(39.64);
    expect(result.facts.financialTenYear).toMatchObject({
      latestPeriod: "FY2025 10-K",
      rows: expect.arrayContaining([expect.objectContaining({ metric: "营业收入" }), expect.objectContaining({ metric: "股票回购支出" })]),
    });
    expect(result.facts.sec).toMatchObject({
      cik: "0000320193",
      latestAnnual: expect.objectContaining({ form: "10-K", fiscalYear: 2025 }),
    });
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: "SEC EDGAR companyfacts endpoint", freshness: "latest-public" })]));
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: "Apple Investor Relations", freshness: "latest-public" })]));
    expect(result.evidence.find((item) => item.source === "Eastmoney public financial statement endpoints")?.notes).toContain("SEC fallback");
  });

  test("uses Hong Kong quote scaling and Yahoo fundamentals fallback for HK stocks", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("push2.eastmoney.com")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: {
              f57: "00700",
              f58: "腾讯控股",
              f43: 464400,
              f44: 471200,
              f45: 463600,
              f46: 465000,
              f47: 27814648,
              f60: 471400,
              f116: 4234395315758.4,
              f167: 331,
              f169: -7000,
              f170: -148,
            },
          }),
        });
      }
      if (url.includes("datacenter.eastmoney.com")) {
        return Promise.resolve({ ok: true, json: async () => ({ result: { data: [] } }) });
      }
      if (url.includes("/v7/finance/quote")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            quoteResponse: {
              result: [{ symbol: "0700.HK", regularMarketPrice: 464.4, currency: "HKD", marketCap: 4234395315758 }],
            },
          }),
        });
      }
      if (url.includes("/v10/finance/quoteSummary")) {
        return Promise.resolve({ ok: true, json: async () => ({ quoteSummary: { result: [{ assetProfile: { industry: "Internet Content", sector: "Communication Services" } }] } }) });
      }
      if (url.includes("/v8/finance/chart")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ chart: { result: [{ meta: { symbol: "0700.HK", regularMarketPrice: 464.4, currency: "HKD", exchangeName: "HKG" } }] } }),
        });
      }
      if (url.includes("fundamentals-timeseries")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            timeseries: {
              result: [
                { meta: { type: ["trailingTotalRevenue"] }, trailingTotalRevenue: [{ raw: 660257000000, asOfDate: "2025-12-31" }] },
                { meta: { type: ["trailingNetIncome"] }, trailingNetIncome: [{ raw: 194073000000, asOfDate: "2025-12-31" }] },
                { meta: { type: ["trailingOperatingCashFlow"] }, trailingOperatingCashFlow: [{ raw: 260000000000, asOfDate: "2025-12-31" }] },
                { meta: { type: ["quarterlyTotalAssets"] }, quarterlyTotalAssets: [{ raw: 1830000000000, asOfDate: "2025-12-31" }] },
                { meta: { type: ["quarterlyTotalDebt"] }, quarterlyTotalDebt: [{ raw: 380000000000, asOfDate: "2025-12-31" }] },
                { meta: { type: ["quarterlyStockholdersEquity"] }, quarterlyStockholdersEquity: [{ raw: 980000000000, asOfDate: "2025-12-31" }] },
              ],
            },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    });

    const result = await fetchPublicCompanyEvidence({
      companyName: "腾讯控股",
      company: {
        id: "eastmoney:116.00700",
        name: "腾讯控股",
        code: "00700",
        exchange: "香港交易所",
        listingPlace: "港股",
        marketType: "HK",
        quoteId: "116.00700",
        secid: "116.00700",
        yahooSymbol: "00700.HK",
        source: "eastmoney",
      },
      fetchImpl: fetchMock,
    });

    expect(result.facts.quote).toMatchObject({
      regularMarketPrice: 464.4,
      regularMarketDayHigh: 471.2,
      regularMarketPreviousClose: 471.4,
      regularMarketChange: -7,
      priceToBook: 3.31,
    });
    expect(result.facts.financialTenYear).toMatchObject({
      latestPeriod: "2025",
      rows: expect.arrayContaining([expect.objectContaining({ metric: "营业收入" }), expect.objectContaining({ metric: "总资产" })]),
    });
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: "Yahoo Finance public fundamentals-timeseries endpoint", freshness: "latest-public" })]));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("0700.HK"))).toBe(true);
    expect(
      fetchMock.mock.calls
        .filter(([url]) => String(url).includes("yahoo.com"))
        .some(([url]) => String(url).includes("00700.HK")),
    ).toBe(false);
  });

  test("marks Yahoo fundamentals unavailable when the response has no usable financial metrics", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quotes: [{ symbol: "0700.HK", longname: "Tencent Holdings Limited", exchDisp: "HKSE" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quoteResponse: { result: [{ symbol: "0700.HK", regularMarketPrice: 464.4, currency: "HKD" }] },
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ chart: { result: [{ meta: { symbol: "0700.HK", regularMarketPrice: 464.4, currency: "HKD", exchangeName: "HKG" } }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          timeseries: {
            result: [{ meta: { symbol: ["0700.HK"], type: ["unrequestedMetric"] }, unrequestedMetric: [] }],
          },
        }),
      });

    const result = await fetchPublicCompanyEvidence({ companyName: "Tencent", ticker: "0700.HK", fetchImpl: fetchMock });

    expect(result.facts.fundamentals).toBeUndefined();
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: "Yahoo Finance public fundamentals-timeseries endpoint", freshness: "unavailable" })]));
  });

  test("falls back to Yahoo chart quote and SEC override for MSFT selected from Eastmoney", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("push2.eastmoney.com") || url.includes("datacenter.eastmoney.com")) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      }
      if (url.includes("company_tickers.json")) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      }
      if (url.includes("companyfacts/CIK0000789019.json")) {
        return Promise.resolve({ ok: true, json: async () => secMicrosoftFacts() });
      }
      if (url.includes("/v8/finance/chart/MSFT")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "MSFT",
                    longName: "Microsoft Corporation",
                    currency: "USD",
                    exchangeName: "NMS",
                    regularMarketPrice: 415.06,
                    fiftyTwoWeekHigh: 555.45,
                    fiftyTwoWeekLow: 356.28,
                  },
                },
              ],
            },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
    });

    const result = await fetchPublicCompanyEvidence({
      companyName: "微软",
      company: {
        id: "eastmoney:105.MSFT",
        name: "微软",
        code: "MSFT",
        exchange: "美国市场",
        listingPlace: "美股",
        marketType: "UsStock",
        quoteId: "105.MSFT",
        secid: "105.MSFT",
        yahooSymbol: "MSFT",
        source: "eastmoney",
      },
      fetchImpl: fetchMock,
    });

    expect(result.company).toMatchObject({ name: "微软", ticker: "MSFT", market: "美股" });
    expect(result.facts.quote).toMatchObject({ regularMarketPrice: 415.06, currency: "USD" });
    expect(result.facts.financialTenYear).toMatchObject({
      latestPeriod: "FY2025 10-K",
      rows: expect.arrayContaining([expect.objectContaining({ metric: "营业收入" }), expect.objectContaining({ metric: "摊薄每股收益" })]),
    });
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: "Yahoo Finance public chart endpoint", freshness: "latest-public" })]));
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: "SEC EDGAR companyfacts endpoint", freshness: "latest-public" })]));
  });

  test("falls back to Stooq quote when Eastmoney and Yahoo quote sources are unavailable for US stocks", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("companyfacts/CIK0000789019.json")) {
        return Promise.resolve({ ok: true, json: async () => secMicrosoftFacts() });
      }
      if (url.includes("stooq.com")) {
        return Promise.resolve({
          ok: true,
          text: async () => "Symbol,Date,Time,Open,High,Low,Close,Volume\nMSFT.US,2026-05-08,22:00:21,417.385,418.63,414,415.12,33383790\n",
        });
      }
      return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    });

    const result = await fetchPublicCompanyEvidence({
      companyName: "微软",
      company: {
        id: "eastmoney:105.MSFT",
        name: "微软",
        code: "MSFT",
        exchange: "美国市场",
        listingPlace: "美股",
        marketType: "UsStock",
        quoteId: "105.MSFT",
        yahooSymbol: "MSFT",
        source: "eastmoney",
      },
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.facts.quote).toMatchObject({ regularMarketPrice: 415.12, currency: "USD" });
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: "Stooq public quote CSV endpoint", freshness: "latest-public" })]));
  });

  test("adds Tushare structured A-share evidence when a token is available", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("push2.eastmoney.com")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: { f57: "300750", f58: "宁德时代", f43: 41116, f116: 1902228788282.36, f162: 2293, f167: 582 },
          }),
        });
      }
      if (url.includes("datacenter-web.eastmoney.com")) {
        return Promise.resolve({ ok: true, json: async () => ({ result: { data: [] } }) });
      }
      if (url.includes("api.tushare.pro")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { api_name?: string };
        const fields = {
          daily_basic: ["ts_code", "trade_date", "pe_ttm", "pb", "total_mv"],
          income: ["ts_code", "end_date", "revenue", "n_income_attr_p"],
          cashflow: ["ts_code", "end_date", "n_cashflow_act"],
          fina_indicator: ["ts_code", "end_date", "grossprofit_margin", "roe"],
          dividend: ["ts_code", "end_date", "cash_div_tax"],
          anns_d: ["ts_code", "ann_date", "title"],
        }[body.api_name || ""] ?? ["ts_code"];
        const items = {
          daily_basic: [["300750.SZ", "20260525", 22.93, 5.82, 190222878.88]],
          income: [["300750.SZ", "20260331", 84704630000, 13963180000]],
          cashflow: [["300750.SZ", "20260331", 5875900000]],
          fina_indicator: [["300750.SZ", "20260331", 25.6, 4.1]],
          dividend: [["300750.SZ", "20251231", 12.3]],
          anns_d: [["300750.SZ", "20260428", "宁德时代2026年第一季度报告"]],
        }[body.api_name || ""] ?? [];
        return Promise.resolve({ ok: true, json: async () => ({ code: 0, data: { fields, items } }) });
      }
      return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    });

    const result = await fetchPublicCompanyEvidence({
      companyName: "宁德时代",
      company: {
        id: "eastmoney:0.300750",
        name: "宁德时代",
        code: "300750",
        exchange: "深圳证券交易所",
        listingPlace: "深A",
        marketType: "AStock",
        quoteId: "0.300750",
        source: "eastmoney",
      },
      fetchImpl: fetchMock as typeof fetch,
      tushareToken: "test-token",
    });

    expect(fetchMock).toHaveBeenCalledWith("http://api.tushare.pro", expect.objectContaining({ method: "POST" }));
    expect(result.facts.tushare).toMatchObject({
      tsCode: "300750.SZ",
      dailyBasic: [expect.objectContaining({ pe_ttm: 22.93 })],
      income: [expect.objectContaining({ n_income_attr_p: 13963180000 })],
      cashflow: [expect.objectContaining({ n_cashflow_act: 5875900000 })],
      indicators: [expect.objectContaining({ grossprofit_margin: 25.6 })],
      dividend: [expect.objectContaining({ cash_div_tax: 12.3 })],
      announcements: [expect.objectContaining({ title: "宁德时代2026年第一季度报告" })],
    });
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "Tushare Pro API", freshness: "latest-public", title: expect.stringContaining("valuation") }),
        expect.objectContaining({ source: "Tushare Pro API", freshness: "latest-public", title: expect.stringContaining("financial statements") }),
      ]),
    );
  });
});

function secAppleFacts() {
  return {
    cik: 320193,
    entityName: "Apple Inc.",
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01", end: "2024-09-28", val: 391_035_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31", end: "2025-09-27", val: 416_161_000_000 },
            ],
          },
        },
        NetIncomeLoss: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01", end: "2024-09-28", val: 93_736_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31", end: "2025-09-27", val: 112_010_000_000 },
            ],
          },
        },
        NetCashProvidedByUsedInOperatingActivities: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01", end: "2024-09-28", val: 118_254_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31", end: "2025-09-27", val: 132_451_000_000 },
            ],
          },
        },
        Assets: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01", end: "2024-09-28", val: 364_980_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31", end: "2025-09-27", val: 359_241_000_000 },
            ],
          },
        },
        Liabilities: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01", end: "2024-09-28", val: 308_030_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31", end: "2025-09-27", val: 293_021_000_000 },
            ],
          },
        },
        StockholdersEquity: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01", end: "2024-09-28", val: 56_950_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31", end: "2025-09-27", val: 66_220_000_000 },
            ],
          },
        },
        EarningsPerShareDiluted: {
          units: {
            "USD/shares": [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01", end: "2024-09-28", val: 6.08 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31", end: "2025-09-27", val: 7.4 },
            ],
          },
        },
        PaymentsForRepurchaseOfCommonStock: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01", end: "2024-09-28", val: 94_949_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31", end: "2025-09-27", val: 89_402_000_000 },
            ],
          },
        },
        PaymentsOfDividends: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01", end: "2024-09-28", val: 15_234_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31", end: "2025-09-27", val: 15_638_000_000 },
            ],
          },
        },
      },
    },
  };
}

function secMicrosoftFacts() {
  return {
    cik: 789019,
    entityName: "Microsoft Corporation",
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-07-30", end: "2024-06-30", val: 245_122_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-07-30", end: "2025-06-30", val: 281_724_000_000 },
            ],
          },
        },
        NetIncomeLoss: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-07-30", end: "2024-06-30", val: 88_136_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-07-30", end: "2025-06-30", val: 101_832_000_000 },
            ],
          },
        },
        NetCashProvidedByUsedInOperatingActivities: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-07-30", end: "2024-06-30", val: 118_548_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-07-30", end: "2025-06-30", val: 136_214_000_000 },
            ],
          },
        },
        Assets: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-07-30", end: "2024-06-30", val: 512_163_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-07-30", end: "2025-06-30", val: 619_003_000_000 },
            ],
          },
        },
        Liabilities: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-07-30", end: "2024-06-30", val: 243_686_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-07-30", end: "2025-06-30", val: 285_421_000_000 },
            ],
          },
        },
        StockholdersEquity: {
          units: {
            USD: [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-07-30", end: "2024-06-30", val: 268_477_000_000 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-07-30", end: "2025-06-30", val: 333_582_000_000 },
            ],
          },
        },
        EarningsPerShareDiluted: {
          units: {
            "USD/shares": [
              { fy: 2024, fp: "FY", form: "10-K", filed: "2024-07-30", end: "2024-06-30", val: 11.8 },
              { fy: 2025, fp: "FY", form: "10-K", filed: "2025-07-30", end: "2025-06-30", val: 13.64 },
            ],
          },
        },
      },
    },
  };
}
