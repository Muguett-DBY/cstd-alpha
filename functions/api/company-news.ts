import type { InvestmentReport } from "../../src/shared/report";
import {
  buildCompanyNewsQuery,
  buildIndustryNewsQuery,
  decorateNewsSentiment,
  parseGoogleNewsRss,
  type CompanyNewsBundle,
} from "../../src/shared/news";
import { formatIndustryLabel } from "../../src/shared/industry";
import { ensureUserResearchSchema, json, requireUserSession, watchlistRowToItem, type WatchlistRow } from "../_shared/user-research-db";

type Env = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const url = new URL(request.url);
  const watchlistId = url.searchParams.get("watchlistId")?.trim();
  if (!watchlistId) return json({ error: "缺少自选股 ID。" }, 400);

  const row = await readWatchlistRow(env.REPORT_LIBRARY_DB, session.userId, watchlistId);
  if (!row) return json({ error: "自选股不存在。" }, 404);

  const item = watchlistRowToItem(row);
  const report = await readBestReport(env, row);
  const industryLabel = inferIndustryLabel(report);
  const companyQuery = buildCompanyNewsQuery(item.company);
  const industryQuery = buildIndustryNewsQuery(industryLabel, item.company);

  const [companyNews, industryNews] = await Promise.all([
    fetchGoogleNews(companyQuery, request.signal),
    fetchGoogleNews(industryQuery, request.signal),
  ]);

  const bundle: CompanyNewsBundle = {
    company: item.company,
    companyNews,
    industryNews,
    companyQuery,
    industryQuery,
    industryLabel,
    fetchedAt: new Date().toISOString(),
  };

  return new Response(JSON.stringify(bundle), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
};

async function fetchGoogleNews(query: string, signal: AbortSignal) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  const response = await fetch(rssUrl, {
    headers: {
      "user-agent": "CSTDAlpha/1.0 (+https://alpha.custard.top)",
      accept: "application/rss+xml, application/xml, text/xml",
    },
    signal,
  });
  if (!response.ok) throw new Error(`新闻读取失败：${response.status}`);
  return decorateNewsSentiment(parseGoogleNewsRss(await response.text(), 8));
}

async function readWatchlistRow(db: D1Database, userId: string, id: string) {
  return db
    .prepare(
      `SELECT id, user_id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
       FROM user_watchlist
       WHERE user_key = ?1 AND id = ?2`,
    )
    .bind(userId, id)
    .first<WatchlistRow>();
}

async function readBestReport(env: Env, watchlist: WatchlistRow): Promise<InvestmentReport | null> {
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) return null;
  try {
    const row = watchlist.report_library_id
      ? await env.REPORT_LIBRARY_DB.prepare(`SELECT object_key FROM report_library WHERE id = ?1`).bind(watchlist.report_library_id).first<{ object_key: string }>()
      : await env.REPORT_LIBRARY_DB.prepare(
          `SELECT object_key FROM report_library WHERE ticker = ?1 ORDER BY CASE WHEN market = ?2 THEN 0 ELSE 1 END, imported_at DESC LIMIT 1`,
        )
          .bind(watchlist.ticker, watchlist.market)
          .first<{ object_key: string }>();
    if (!row?.object_key) return null;
    const object = await env.REPORT_LIBRARY_BUCKET.get(row.object_key);
    return object ? ((await object.json()) as InvestmentReport) : null;
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) return null;
    throw error;
  }
}

function inferIndustryLabel(report: InvestmentReport | null) {
  const label = formatIndustryLabel(report?.company.industry, report?.company.sector);
  if (label !== "未分类") return label;
  return report?.moduleScores.find((item) => item.id === "industry")?.name || "所属行业";
}
