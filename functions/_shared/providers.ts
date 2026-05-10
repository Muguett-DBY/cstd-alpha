import type { CompanyCandidate, CompanyIdentity, EvidenceItem } from "../../src/shared/report";
import { buildDrawdownSeries, normalizeChartBundle, type ChartBundle, type PriceMode, type PricePoint } from "../../src/shared/chart";

export type EvidenceBundle = {
  company: CompanyIdentity;
  retrievedAt: string;
  evidence: EvidenceItem[];
  facts: Record<string, unknown>;
};

type FetchLike = typeof fetch;

type FetchEvidenceInput = {
  companyName: string;
  ticker?: string;
  market?: string;
  company?: CompanyCandidate;
  fetchImpl?: FetchLike;
};

type FetchChartInput = {
  company: CompanyCandidate;
  priceMode: PriceMode;
  fetchImpl?: FetchLike;
};

export async function fetchPublicCompanyEvidence({
  companyName,
  ticker,
  market,
  company,
  fetchImpl = fetch,
}: FetchEvidenceInput): Promise<EvidenceBundle> {
  const retrievedAt = new Date().toISOString();
  const selectedCompany = company;
  const searchQuote = selectedCompany ? undefined : await searchYahooQuote(ticker || companyName, fetchImpl);
  const symbol = selectedCompany?.yahooSymbol || selectedCompany?.code || ticker || stringValue(searchQuote?.symbol);

  if (!symbol) {
    return unavailableBundle(companyName, market, retrievedAt, "Could not resolve a public market ticker.");
  }

  const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const summaryUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    symbol,
  )}?modules=assetProfile,summaryDetail,financialData,defaultKeyStatistics,price,calendarEvents,earnings`;
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const fundamentalsUrl = buildFundamentalsUrl(symbol);
  const eastmoneyQuoteUrl = selectedCompany?.quoteId
    ? `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(
        selectedCompany.quoteId,
      )}&fields=f57,f58,f43,f44,f45,f46,f47,f48,f60,f116,f162,f167,f168,f169,f170`
    : "";
  const secucode = selectedCompany ? eastmoneySecucode(selectedCompany) : undefined;
  const incomeUrl = secucode ? eastmoneyFinanceUrl("RPT_F10_FINANCE_GINCOMEQC", "APP_F10_GINCOMEQC", secucode) : "";
  const cashflowUrl = secucode ? eastmoneyFinanceUrl("RPT_F10_FINANCE_GCASHFLOW", "APP_F10_GCASHFLOW", secucode) : "";
  const balanceUrl = secucode ? eastmoneyFinanceUrl("RPT_F10_FINANCE_GBALANCE", "APP_F10_GBALANCE", secucode) : "";

  const eastmoneyQuoteJson = eastmoneyQuoteUrl ? await fetchJson(eastmoneyQuoteUrl, fetchImpl) : null;
  const eastmoneyQuote = isRecord(recordPath(eastmoneyQuoteJson, ["data"])) ? (recordPath(eastmoneyQuoteJson, ["data"]) as Record<string, unknown>) : undefined;
  const incomeJson = incomeUrl ? await fetchJson(incomeUrl, fetchImpl) : null;
  const cashflowJson = cashflowUrl ? await fetchJson(cashflowUrl, fetchImpl) : null;
  const balanceJson = balanceUrl ? await fetchJson(balanceUrl, fetchImpl) : null;
  const incomeRows = arrayPath(incomeJson, ["result", "data"]);
  const cashflowRows = arrayPath(cashflowJson, ["result", "data"]);
  const balanceRows = arrayPath(balanceJson, ["result", "data"]);

  const quoteJson = selectedCompany?.source === "eastmoney" ? null : await fetchJson(quoteUrl, fetchImpl);
  const quote = firstArrayItem(recordPath(quoteJson, ["quoteResponse", "result"]));
  const summaryJson = selectedCompany?.source === "eastmoney" ? null : await fetchJson(summaryUrl, fetchImpl);
  const summary = firstArrayItem(recordPath(summaryJson, ["quoteSummary", "result"]));
  const chartJson = selectedCompany?.source === "eastmoney" ? null : await fetchJson(chartUrl, fetchImpl);
  const chart = firstArrayItem(recordPath(chartJson, ["chart", "result"]));
  const chartMeta = isRecord(chart?.meta) ? chart.meta : undefined;
  const fundamentalsJson = selectedCompany?.source === "eastmoney" ? null : await fetchJson(fundamentalsUrl, fetchImpl);
  const fundamentals = Array.isArray(recordPath(fundamentalsJson, ["timeseries", "result"]))
    ? (recordPath(fundamentalsJson, ["timeseries", "result"]) as unknown[])
    : undefined;

  const hasEastmoneyFinancials = incomeRows.length > 0 || cashflowRows.length > 0 || balanceRows.length > 0;

  if (!quote && !summary && !chartMeta && !searchQuote && !fundamentals && !eastmoneyQuote && !hasEastmoneyFinancials) {
    return unavailableBundle(companyName, market, retrievedAt, "Public financial endpoints returned no usable data.");
  }

  const profile = isRecord(summary?.assetProfile) ? summary.assetProfile : undefined;
  const price = isRecord(summary?.price) ? summary.price : undefined;
  const mergedQuote = {
    ...(eastmoneyQuote ? normalizeEastmoneyQuote(eastmoneyQuote) : {}),
    ...(searchQuote ?? {}),
    ...(chartMeta ?? {}),
    ...(quote ?? {}),
  };
  const name =
    selectedCompany?.name ||
    stringValue(quote?.longName) ||
    stringValue(price?.longName) ||
    stringValue(chartMeta?.longName) ||
    stringValue(searchQuote?.longname) ||
    stringValue(searchQuote?.shortname) ||
    companyName;

  return {
    company: {
      name,
      ticker: selectedCompany?.code || stringValue(quote?.symbol) || stringValue(chartMeta?.symbol) || stringValue(searchQuote?.symbol) || symbol,
      market:
        selectedCompany?.listingPlace ||
        stringValue(quote?.market) ||
        stringValue(searchQuote?.exchDisp) ||
        stringValue(chartMeta?.exchangeName) ||
        market,
      industry: stringValue(profile?.industry) || stringValue(searchQuote?.industry) || stringValue(searchQuote?.industryDisp),
      sector: selectedCompany?.marketType || stringValue(profile?.sector) || stringValue(searchQuote?.sector) || stringValue(searchQuote?.sectorDisp),
    },
    retrievedAt,
    evidence: [
      {
        title: `${symbol} symbol search`,
        source: selectedCompany ? "Eastmoney public suggest endpoint" : "Yahoo Finance public search endpoint",
        url: selectedCompany
          ? `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(companyName)}&type=14&count=5`
          : `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker || companyName)}&quotesCount=1&newsCount=0`,
        retrievedAt,
        freshness: selectedCompany || searchQuote ? "latest-public" : "unavailable",
        notes: selectedCompany || searchQuote ? "Public company identity, exchange, sector and industry match." : "Search endpoint returned no data.",
      },
      {
        title: `${symbol} Eastmoney quote snapshot`,
        source: "Eastmoney public quote endpoint",
        url: eastmoneyQuoteUrl,
        retrievedAt,
        freshness: eastmoneyQuote ? "latest-public" : "unavailable",
        notes: eastmoneyQuote ? "Latest public market price, volume, market cap and valuation snapshot." : "Eastmoney quote unavailable.",
      },
      {
        title: `${symbol} Eastmoney financial statements`,
        source: "Eastmoney public financial statement endpoints",
        url: incomeUrl || cashflowUrl || balanceUrl,
        retrievedAt,
        freshness: hasEastmoneyFinancials ? "latest-public" : "unavailable",
        notes: "Income statement, cash flow statement and balance sheet rows where available.",
      },
      {
        title: `${symbol} latest quote`,
        source: "Yahoo Finance public quote endpoint",
        url: quoteUrl,
        retrievedAt,
        freshness: quote ? "latest-public" : "unavailable",
        notes: quote ? "Latest public quote snapshot returned by Yahoo Finance." : "Quote endpoint returned no data.",
      },
      {
        title: `${symbol} company summary`,
        source: "Yahoo Finance public quoteSummary endpoint",
        url: summaryUrl,
        retrievedAt,
        freshness: summary ? "latest-public" : "unavailable",
        notes: summary ? "Public profile, financialData, summaryDetail and key statistics modules." : "Summary unavailable.",
      },
      {
        title: `${symbol} price chart snapshot`,
        source: "Yahoo Finance public chart endpoint",
        url: chartUrl,
        retrievedAt,
        freshness: chartMeta ? "latest-public" : "unavailable",
        notes: chartMeta ? "Latest market price, volume, exchange, and 52-week range metadata." : "Chart endpoint returned no data.",
      },
      {
        title: `${symbol} public fundamentals time series`,
        source: "Yahoo Finance public fundamentals-timeseries endpoint",
        url: fundamentalsUrl,
        retrievedAt,
        freshness: fundamentals ? "latest-public" : "unavailable",
        notes: fundamentals ? "Trailing and quarterly public financial statement metrics." : "Fundamentals time series unavailable.",
      },
    ],
    facts: {
      quote: Object.keys(mergedQuote).length ? mergedQuote : undefined,
      summary:
        summary ??
        ({
          assetProfile: pickDefined({
            industry: stringValue(searchQuote?.industry) || stringValue(searchQuote?.industryDisp),
            sector: stringValue(searchQuote?.sector) || stringValue(searchQuote?.sectorDisp),
          }),
          price: chartMeta,
          financialData: normalizeFundamentals(fundamentals),
        } satisfies Record<string, unknown>),
      selectedCompany,
      eastmoney: {
        quote: eastmoneyQuote,
        incomeRows,
        cashflowRows,
        balanceRows,
      },
      search: searchQuote ?? undefined,
      chart: chart ?? undefined,
      fundamentals: normalizeFundamentals(fundamentals),
    },
  };
}

export async function fetchChartBundle({ company, priceMode, fetchImpl = fetch }: FetchChartInput): Promise<ChartBundle> {
  const asOf = new Date().toISOString();
  const useEastmoney = Boolean(company.quoteId && (company.listingPlace.includes("A") || company.listingPlace.includes("港") || company.quoteId.startsWith("0.") || company.quoteId.startsWith("1.") || company.quoteId.startsWith("116.")));
  let url = useEastmoney ? eastmoneyKlineUrl(company.quoteId || company.secid || company.code, priceMode) : yahooTenYearChartUrl(company.yahooSymbol || company.code);
  let sourceName = useEastmoney ? "Eastmoney" : "Yahoo Finance";
  let json = await fetchJson(url, fetchImpl);
  let priceSeries = useEastmoney ? normalizeEastmoneyKlines(json, priceMode) : normalizeYahooChart(json, priceMode);

  if (useEastmoney && priceSeries.length === 0 && company.yahooSymbol) {
    url = yahooTenYearChartUrl(company.yahooSymbol);
    sourceName = "Yahoo Finance fallback";
    json = await fetchJson(url, fetchImpl);
    priceSeries = normalizeYahooChart(json, priceMode);
  }

  const drawdownSeries = buildDrawdownSeries(priceSeries);
  const latest = priceSeries.at(-1);
  const meta = isRecord(firstArrayItem(recordPath(json, ["chart", "result"]))?.meta)
    ? (firstArrayItem(recordPath(json, ["chart", "result"]))?.meta as Record<string, unknown>)
    : undefined;

  return normalizeChartBundle({
    company: {
      name: company.name,
      ticker: company.code,
      market: company.listingPlace,
      sector: company.marketType,
    },
    asOf,
    priceMode,
    priceSeries,
    drawdownSeries,
    marketSnapshot: {
      currentPrice: latest?.close,
      latestDate: latest?.date,
      currency: stringValue(meta?.currency),
      exchangeName: company.exchange || stringValue(meta?.exchangeName),
      source: sourceName,
    },
    evidence: [
      {
        title: `${company.code} 十年股价数据`,
        source: sourceName === "Eastmoney" ? "Eastmoney public kline endpoint" : `${sourceName} public chart endpoint`,
        url,
        retrievedAt: asOf,
        freshness: priceSeries.length ? "latest-public" : "unavailable",
        notes: priceSeries.length
          ? `${priceMode === "adjusted" ? "前复权/调整价" : "原始收盘价"}口径，返回 ${priceSeries.length} 个价格点。`
          : "公开历史价格接口未返回可用数据。",
      },
    ],
  });
}

export async function searchCompanyCandidates(query: string, fetchImpl: FetchLike = fetch): Promise<CompanyCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const eastmoneyUrl = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(
    trimmed,
  )}&type=14&token=D43BF722C8E33BD61D078A2FA2B7E485&count=8`;
  const eastmoneyJson = await fetchJson(eastmoneyUrl, fetchImpl);
  const eastmoneyCandidates = arrayPath(eastmoneyJson, ["QuotationCodeTable", "Data"])
    .map(normalizeEastmoneyCandidate)
    .filter((item): item is CompanyCandidate => Boolean(item));

  if (eastmoneyCandidates.length > 0) return dedupeCandidates(eastmoneyCandidates);

  const yahooJson = await fetchJson(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(trimmed)}&quotesCount=8&newsCount=0`,
    fetchImpl,
  );
  const yahooCandidates = arrayPath(yahooJson, ["quotes"])
    .map(normalizeYahooCandidate)
    .filter((item): item is CompanyCandidate => Boolean(item));

  return dedupeCandidates(yahooCandidates);
}

async function searchYahooQuote(companyName: string, fetchImpl: FetchLike) {
  const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    companyName,
  )}&quotesCount=1&newsCount=0`;
  const json = await fetchJson(searchUrl, fetchImpl);
  return firstArrayItem(recordPath(json, ["quotes"]));
}

function buildFundamentalsUrl(symbol: string) {
  const now = Math.floor(Date.now() / 1000);
  const fiveYearsAgo = now - 60 * 60 * 24 * 365 * 5;
  const types = [
    "trailingTotalRevenue",
    "trailingNetIncome",
    "trailingOperatingIncome",
    "trailingGrossProfit",
    "trailingOperatingCashFlow",
    "trailingFreeCashFlow",
    "trailingDilutedEPS",
    "quarterlyTotalAssets",
    "quarterlyTotalDebt",
    "quarterlyStockholdersEquity",
  ];
  return `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(
    symbol,
  )}?type=${types.join(",")}&merge=false&period1=${fiveYearsAgo}&period2=${now}`;
}

function eastmoneyKlineUrl(secid: string, priceMode: PriceMode) {
  const now = new Date();
  const begin = `${now.getUTCFullYear() - 10}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  const fqt = priceMode === "adjusted" ? "1" : "0";
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(
    secid,
  )}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=${fqt}&beg=${begin}&end=20500101`;
}

function yahooTenYearChartUrl(symbol: string) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1mo&events=history&includeAdjustedClose=true`;
}

function eastmoneyFinanceUrl(type: string, style: string, secucode: string) {
  return `https://datacenter.eastmoney.com/securities/api/data/get?type=${type}&sty=${style}&filter=(SECUCODE%3D%22${encodeURIComponent(
    secucode,
  )}%22)&p=1&ps=10&sr=-1&st=REPORT_DATE`;
}

function eastmoneySecucode(candidate: CompanyCandidate) {
  if (candidate.marketType === "AStock" || candidate.listingPlace.includes("A")) {
    const suffix = candidate.quoteId?.startsWith("1.") || candidate.listingPlace.includes("沪") ? "SH" : "SZ";
    return `${candidate.code}.${suffix}`;
  }
  if (candidate.marketType === "HK" || candidate.listingPlace.includes("港")) return `${candidate.code}.HK`;
  return undefined;
}

function normalizeEastmoneyCandidate(value: unknown): CompanyCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const code = stringValue(value.Code);
  const name = stringValue(value.Name);
  if (!code || !name) return undefined;
  const listingPlace = stringValue(value.SecurityTypeName) || stringValue(value.JYS) || "未知市场";
  const quoteId = stringValue(value.QuoteID);
  return {
    id: `eastmoney:${quoteId || code}`,
    name,
    code,
    exchange: eastmoneyExchangeName(stringValue(value.JYS), quoteId, listingPlace),
    listingPlace,
    marketType: stringValue(value.Classify) || listingPlace,
    quoteId,
    secid: quoteId,
    yahooSymbol: eastmoneyYahooSymbol(code, listingPlace),
    source: "eastmoney",
  };
}

function eastmoneyExchangeName(rawExchange: string | undefined, quoteId: string | undefined, listingPlace: string) {
  if (listingPlace.includes("深") || quoteId?.startsWith("0.") || rawExchange === "0") return "深圳证券交易所";
  if (listingPlace.includes("沪") || quoteId?.startsWith("1.") || rawExchange === "1") return "上海证券交易所";
  if (listingPlace.includes("港") || quoteId?.startsWith("116.") || rawExchange === "116") return "香港交易所";
  if (listingPlace.includes("美")) return "美国市场";
  return rawExchange && !/^\d+$/.test(rawExchange) ? rawExchange : listingPlace;
}

function normalizeYahooCandidate(value: unknown): CompanyCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const code = stringValue(value.symbol);
  const name = stringValue(value.longname) || stringValue(value.shortname);
  if (!code || !name) return undefined;
  const exchange = stringValue(value.exchDisp) || stringValue(value.exchange) || "海外市场";
  return {
    id: `yahoo:${code}`,
    name,
    code,
    exchange,
    listingPlace: exchange,
    marketType: stringValue(value.quoteType) || stringValue(value.typeDisp) || "Equity",
    yahooSymbol: code,
    source: "yahoo",
  };
}

function eastmoneyYahooSymbol(code: string, listingPlace: string) {
  if (listingPlace.includes("深")) return `${code}.SZ`;
  if (listingPlace.includes("沪")) return `${code}.SS`;
  if (listingPlace.includes("港")) return `${code}.HK`;
  return code;
}

function normalizeEastmoneyQuote(quote: Record<string, unknown>) {
  return {
    symbol: stringValue(quote.f57),
    longName: stringValue(quote.f58),
    regularMarketPrice: eastmoneyScaledNumber(quote.f43),
    regularMarketDayHigh: eastmoneyScaledNumber(quote.f44),
    regularMarketDayLow: eastmoneyScaledNumber(quote.f45),
    regularMarketOpen: eastmoneyScaledNumber(quote.f46),
    regularMarketVolume: numberValue(quote.f47),
    regularMarketPreviousClose: eastmoneyScaledNumber(quote.f60),
    marketCap: numberValue(quote.f116),
    trailingPE: eastmoneyScaledNumber(quote.f162),
    priceToBook: eastmoneyScaledNumber(quote.f167),
    regularMarketChange: eastmoneyScaledNumber(quote.f169),
    regularMarketChangePercent: eastmoneyScaledNumber(quote.f170),
  };
}

function normalizeEastmoneyKlines(value: unknown, priceMode: PriceMode): PricePoint[] {
  const rows = arrayPath(value, ["data", "klines"]);
  return rows.reduce<PricePoint[]>((points, row) => {
      if (typeof row !== "string") return points;
      const [date, open, close, high, low, volume, amount, , changePercent] = row.split(",");
      const closeValue = numberFromString(close);
      if (!date || closeValue === undefined) return points;
      points.push({
        date,
        open: numberFromString(open),
        close: closeValue,
        adjustedClose: priceMode === "adjusted" ? closeValue : closeValue,
        rawClose: priceMode === "raw" ? closeValue : undefined,
        high: numberFromString(high),
        low: numberFromString(low),
        volume: numberFromString(volume) ?? 0,
        amount: numberFromString(amount),
        changePercent: numberFromString(changePercent),
      });
      return points;
    }, []);
}

function normalizeYahooChart(value: unknown, priceMode: PriceMode): PricePoint[] {
  const chart = firstArrayItem(recordPath(value, ["chart", "result"]));
  const timestamps = Array.isArray(chart?.timestamp) ? chart.timestamp : [];
  const quote = firstArrayItem(recordPath(chart, ["indicators", "quote"]));
  const adjusted = firstArrayItem(recordPath(chart, ["indicators", "adjclose"]));
  const closes = Array.isArray(quote?.close) ? quote.close : [];
  const adjustedCloses = Array.isArray(adjusted?.adjclose) ? adjusted.adjclose : [];
  const opens = Array.isArray(quote?.open) ? quote.open : [];
  const highs = Array.isArray(quote?.high) ? quote.high : [];
  const lows = Array.isArray(quote?.low) ? quote.low : [];
  const volumes = Array.isArray(quote?.volume) ? quote.volume : [];

  return timestamps.reduce<PricePoint[]>((points, timestamp, index) => {
      const rawClose = numberValue(closes[index]);
      const adjustedClose = numberValue(adjustedCloses[index]) ?? rawClose;
      const close = priceMode === "adjusted" ? adjustedClose : rawClose;
      if (typeof timestamp !== "number" || close === undefined) return points;
      points.push({
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        open: numberValue(opens[index]),
        close,
        adjustedClose: adjustedClose ?? close,
        rawClose,
        high: numberValue(highs[index]),
        low: numberValue(lows[index]),
        volume: numberValue(volumes[index]) ?? 0,
      });
      return points;
    }, []);
}

function normalizeFundamentals(items: unknown[] | undefined) {
  if (!items) return undefined;
  const result: Record<string, unknown> = {};
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.meta) || !Array.isArray(item.meta.type)) continue;
    const type = item.meta.type.find(stringValue);
    if (!type) continue;
    result[type] = item[type];
  }
  return Object.keys(result).length ? result : undefined;
}

function pickDefined(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function dedupeCandidates(candidates: CompanyCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}:${candidate.code}:${candidate.listingPlace}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchJson(url: string, fetchImpl: FetchLike): Promise<unknown> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        "user-agent": "CSTD Alpha/1.0",
      },
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

function unavailableBundle(companyName: string, market: string | undefined, retrievedAt: string, notes: string): EvidenceBundle {
  return {
    company: { name: companyName, market },
    retrievedAt,
    evidence: [
      {
        title: "Public financial data unavailable",
        source: "CSTD Alpha data provider",
        url: "",
        retrievedAt,
        freshness: "unavailable",
        notes,
      },
    ],
    facts: {},
  };
}

function recordPath(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

function arrayPath(value: unknown, path: string[]): unknown[] {
  const result = recordPath(value, path);
  return Array.isArray(result) ? result : [];
}

function firstArrayItem(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberFromString(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function eastmoneyScaledNumber(value: unknown) {
  const number = numberValue(value);
  if (number === undefined || number === -100 || number === 0) return number;
  return Math.round((number / 100) * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
