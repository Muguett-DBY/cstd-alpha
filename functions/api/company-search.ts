import { verifySessionCookie } from "../_shared/auth";
import { searchCompanyCandidates } from "../_shared/providers";
import type { CompanyCandidate } from "../../src/shared/report";

type Env = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "未登录。" }, 401);

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  if (!query) return json({ candidates: [] });
  if (query.length > 80) return json({ error: "搜索词过长，请缩短后重试。" }, 400);

  const localCandidates = await searchLocalCompanyUniverse(env.REPORT_LIBRARY_DB, query);
  if (localCandidates.length >= 5) return json({ candidates: localCandidates });

  const externalCandidates = await searchCompanyCandidates(query, fetch, request.signal);
  return json({ candidates: mergeCandidates(localCandidates, externalCandidates) });
};

export async function searchLocalCompanyUniverse(db: D1Database | undefined, query: string): Promise<CompanyCandidate[]> {
  const trimmed = query.trim();
  if (!db || !trimmed) return [];
  const like = `%${escapeSqlLike(trimmed)}%`;
  const rows = await db
    .prepare(
      `SELECT
        c.id AS company_id,
        c.name_cn AS name_cn,
        c.name_en AS name_en,
        c.country AS country,
        c.exchange AS company_exchange,
        c.main_business AS main_business,
        s.ticker AS ticker,
        s.market AS market,
        s.currency AS currency
      FROM companies c
      JOIN securities s ON s.company_id = c.id
      WHERE s.listing_status = 'listed'
        AND (
          c.name_cn LIKE ? ESCAPE '\\'
          OR c.name_en LIKE ? ESCAPE '\\'
          OR s.ticker LIKE ? ESCAPE '\\'
          OR s.market LIKE ? ESCAPE '\\'
          OR c.exchange LIKE ? ESCAPE '\\'
        )
      ORDER BY
        CASE
          WHEN s.ticker = ? THEN 0
          WHEN c.name_cn = ? THEN 1
          WHEN c.name_en = ? THEN 2
          WHEN s.ticker LIKE ? ESCAPE '\\' THEN 3
          WHEN c.name_cn LIKE ? ESCAPE '\\' THEN 4
          ELSE 9
        END,
        c.name_cn ASC
      LIMIT 12`,
    )
    .bind(like, like, like, like, like, trimmed.toUpperCase(), trimmed, trimmed, `${escapeSqlLike(trimmed)}%`, `${escapeSqlLike(trimmed)}%`)
    .all<LocalCompanyRow>()
    .catch(() => ({ results: [] as LocalCompanyRow[] }));

  return (rows.results ?? []).map(localRowToCandidate).filter((candidate): candidate is CompanyCandidate => Boolean(candidate));
}

type LocalCompanyRow = {
  company_id: string;
  name_cn: string;
  name_en?: string | null;
  country?: string | null;
  company_exchange?: string | null;
  main_business?: string | null;
  ticker: string;
  market: string;
  currency?: string | null;
};

function localRowToCandidate(row: LocalCompanyRow): CompanyCandidate | null {
  const ticker = String(row.ticker || "").trim();
  const name = String(row.name_cn || row.name_en || "").trim();
  if (!ticker || !name) return null;
  const market = String(row.market || row.company_exchange || "").trim();
  const exchange = normalizeLocalExchange(row.company_exchange || market, market);
  const listingPlace = normalizeListingPlace(market, exchange);
  const source = listingPlace.includes("美") ? "yahoo" : "eastmoney";
  const quoteId = source === "eastmoney" ? localEastmoneyQuoteId(ticker, listingPlace, exchange) : undefined;
  return {
    id: `local:${row.company_id}:${ticker}`,
    name,
    code: ticker,
    exchange,
    listingPlace,
    marketType: normalizeMarketType(market, listingPlace),
    industry: row.main_business || undefined,
    quoteId,
    secid: quoteId,
    yahooSymbol: localYahooSymbol(ticker, listingPlace),
    source,
  };
}

function mergeCandidates(localCandidates: CompanyCandidate[], externalCandidates: CompanyCandidate[]) {
  const seen = new Set<string>();
  const merged: CompanyCandidate[] = [];
  for (const candidate of [...localCandidates, ...externalCandidates]) {
    const key = `${candidate.source}:${candidate.code.toUpperCase()}:${candidate.listingPlace}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged.slice(0, 12);
}

function normalizeLocalExchange(exchange: string, market: string) {
  const text = `${exchange} ${market}`.toUpperCase();
  if (text.includes("SSE") || text.includes("SH") || text.includes("上海")) return "上海证券交易所";
  if (text.includes("SZSE") || text.includes("SZ") || text.includes("深圳")) return "深圳证券交易所";
  if (text.includes("HKEX") || text.includes("HK") || text.includes("香港")) return "香港交易所";
  if (text.includes("NASDAQ") || text.includes("NYSE") || text.includes("AMEX") || text.includes("US")) return exchange || "美国市场";
  return exchange || market || "未知市场";
}

function normalizeListingPlace(market: string, exchange: string) {
  const text = `${market} ${exchange}`.toUpperCase();
  if (text.includes("SSE") || text.includes("SH") || exchange.includes("上海")) return "沪A";
  if (text.includes("SZSE") || text.includes("SZ") || exchange.includes("深圳")) return "深A";
  if (text.includes("HKEX") || text.includes("HK") || exchange.includes("香港")) return "港股";
  if (text.includes("NASDAQ") || text.includes("NYSE") || text.includes("AMEX") || text.includes("US") || exchange.includes("美国")) return "美股";
  return market || exchange || "未知市场";
}

function normalizeMarketType(market: string, listingPlace: string) {
  if (listingPlace === "沪A" || listingPlace === "深A") return "AStock";
  if (listingPlace === "港股") return "HK";
  if (listingPlace === "美股") return "UsStock";
  return market || listingPlace;
}

function localEastmoneyQuoteId(ticker: string, listingPlace: string, exchange: string) {
  if (listingPlace === "深A" || exchange.includes("深圳")) return `0.${ticker}`;
  if (listingPlace === "沪A" || exchange.includes("上海")) return `1.${ticker}`;
  if (listingPlace === "港股" || exchange.includes("香港")) return `116.${ticker.replace(/^0+/, "") || ticker}`;
  return undefined;
}

function localYahooSymbol(ticker: string, listingPlace: string) {
  if (listingPlace === "深A") return `${ticker}.SZ`;
  if (listingPlace === "沪A") return `${ticker}.SS`;
  if (listingPlace === "港股") return `${ticker.replace(/^0+/, "").padStart(4, "0")}.HK`;
  return ticker;
}

function escapeSqlLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
