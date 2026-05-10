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
  const symbol = ticker || (await findYahooSymbol(companyName, fetchImpl));

  if (!symbol) {
    return unavailableBundle(companyName, market, retrievedAt, "Could not resolve a public market ticker.");
  }

  const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const summaryUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    symbol,
  )}?modules=assetProfile,summaryDetail,financialData,defaultKeyStatistics,price,calendarEvents,earnings`;

  const quoteJson = await fetchJson(quoteUrl, fetchImpl);
  const quote = firstArrayItem(recordPath(quoteJson, ["quoteResponse", "result"]));
  const summaryJson = await fetchJson(summaryUrl, fetchImpl);
  const summary = firstArrayItem(recordPath(summaryJson, ["quoteSummary", "result"]));

  if (!quote && !summary) {
    return unavailableBundle(companyName, market, retrievedAt, "Public financial endpoints returned no usable data.");
  }

  const profile = isRecord(summary?.assetProfile) ? summary.assetProfile : undefined;
  const price = isRecord(summary?.price) ? summary.price : undefined;
  const name = stringValue(quote?.longName) || stringValue(price?.longName) || companyName;

  return {
    company: {
      name,
      ticker: stringValue(quote?.symbol) || symbol,
      market: stringValue(quote?.market) || market,
      industry: stringValue(profile?.industry),
      sector: stringValue(profile?.sector),
    },
    retrievedAt,
    evidence: [
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
    ],
    facts: {
      quote: quote ?? undefined,
      summary: summary ?? undefined,
    },
  };
}

async function findYahooSymbol(companyName: string, fetchImpl: FetchLike) {
  const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    companyName,
  )}&quotesCount=1&newsCount=0`;
  const json = await fetchJson(searchUrl, fetchImpl);
  const quote = firstArrayItem(recordPath(json, ["quotes"]));
  return stringValue(quote?.symbol);
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
