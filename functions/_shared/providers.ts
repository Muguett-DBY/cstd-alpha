import type { CompanyIdentity, EvidenceItem } from "../../src/shared/report";

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
  fetchImpl?: FetchLike;
};

export async function fetchPublicCompanyEvidence({
  companyName,
  ticker,
  market,
  fetchImpl = fetch,
}: FetchEvidenceInput): Promise<EvidenceBundle> {
  const retrievedAt = new Date().toISOString();
  const searchQuote = await searchYahooQuote(ticker || companyName, fetchImpl);
  const symbol = ticker || stringValue(searchQuote?.symbol);

  if (!symbol) {
    return unavailableBundle(companyName, market, retrievedAt, "Could not resolve a public market ticker.");
  }

  const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const summaryUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    symbol,
  )}?modules=assetProfile,summaryDetail,financialData,defaultKeyStatistics,price,calendarEvents,earnings`;
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const fundamentalsUrl = buildFundamentalsUrl(symbol);

  const quoteJson = await fetchJson(quoteUrl, fetchImpl);
  const quote = firstArrayItem(recordPath(quoteJson, ["quoteResponse", "result"]));
  const summaryJson = await fetchJson(summaryUrl, fetchImpl);
  const summary = firstArrayItem(recordPath(summaryJson, ["quoteSummary", "result"]));
  const chartJson = await fetchJson(chartUrl, fetchImpl);
  const chart = firstArrayItem(recordPath(chartJson, ["chart", "result"]));
  const chartMeta = isRecord(chart?.meta) ? chart.meta : undefined;
  const fundamentalsJson = await fetchJson(fundamentalsUrl, fetchImpl);
  const fundamentals = Array.isArray(recordPath(fundamentalsJson, ["timeseries", "result"]))
    ? (recordPath(fundamentalsJson, ["timeseries", "result"]) as unknown[])
    : undefined;

  if (!quote && !summary && !chartMeta && !searchQuote && !fundamentals) {
    return unavailableBundle(companyName, market, retrievedAt, "Public financial endpoints returned no usable data.");
  }

  const profile = isRecord(summary?.assetProfile) ? summary.assetProfile : undefined;
  const price = isRecord(summary?.price) ? summary.price : undefined;
  const mergedQuote = {
    ...(searchQuote ?? {}),
    ...(chartMeta ?? {}),
    ...(quote ?? {}),
  };
  const name =
    stringValue(quote?.longName) ||
    stringValue(price?.longName) ||
    stringValue(chartMeta?.longName) ||
    stringValue(searchQuote?.longname) ||
    stringValue(searchQuote?.shortname) ||
    companyName;

  return {
    company: {
      name,
      ticker: stringValue(quote?.symbol) || stringValue(chartMeta?.symbol) || stringValue(searchQuote?.symbol) || symbol,
      market: stringValue(quote?.market) || stringValue(searchQuote?.exchDisp) || stringValue(chartMeta?.exchangeName) || market,
      industry: stringValue(profile?.industry) || stringValue(searchQuote?.industry) || stringValue(searchQuote?.industryDisp),
      sector: stringValue(profile?.sector) || stringValue(searchQuote?.sector) || stringValue(searchQuote?.sectorDisp),
    },
    retrievedAt,
    evidence: [
      {
        title: `${symbol} symbol search`,
        source: "Yahoo Finance public search endpoint",
        url: `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker || companyName)}&quotesCount=1&newsCount=0`,
        retrievedAt,
        freshness: searchQuote ? "latest-public" : "unavailable",
        notes: searchQuote ? "Public company identity, exchange, sector and industry match." : "Search endpoint returned no data.",
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
      search: searchQuote ?? undefined,
      chart: chart ?? undefined,
      fundamentals: normalizeFundamentals(fundamentals),
    },
  };
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

function firstArrayItem(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
