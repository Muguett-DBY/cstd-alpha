import type { InvestmentReport } from "../../src/shared/report";
import {
  buildCompanyNewsQuery,
  buildIndustryNewsQuery,
  decorateNewsSentiment,
  filterRecentNews,
  parseGoogleNewsRss,
  summarizeNewsSentiment,
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

  const [companyNewsResult, industryNewsResult] = await Promise.allSettled([
    fetchNewsWithFallback(companyQuery, request.signal),
    fetchNewsWithFallback(industryQuery, request.signal),
  ]);

  const companyNews = newsItemsFromResult(companyNewsResult);
  const industryNews = newsItemsFromResult(industryNewsResult);
  const bundle: CompanyNewsBundle = {
    company: item.company,
    companyNews,
    industryNews,
    companySummary: summarizeNewsSentiment(companyNews),
    industrySummary: summarizeNewsSentiment(industryNews),
    companyQuery,
    industryQuery,
    industryLabel,
    fetchedAt: new Date().toISOString(),
    companyNewsError: errorFromResult(companyNewsResult),
    industryNewsError: errorFromResult(industryNewsResult),
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

async function fetchNewsWithFallback(query: string, signal: AbortSignal) {
  const errors: string[] = [];
  for (const variant of newsQueryVariants(query)) {
    for (const source of [fetchGoogleNews, fetchBaiduNews]) {
      try {
        const items = await source(variant, signal);
        if (items.length) return items;
        errors.push(`${source === fetchGoogleNews ? "Google News" : "百度新闻"} 返回空列表：${variant}`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error ?? ""));
      }
    }
  }
  throw new Error(uniqueMessages(errors).join("；") || "新闻源暂时不可用。");
}

async function fetchGoogleNews(query: string, signal: AbortSignal) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:180d`)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  const response = await fetch(rssUrl, {
    headers: {
      "user-agent": "CSTDAlpha/1.0 (+https://alpha.custard.top)",
      accept: "application/rss+xml, application/xml, text/xml",
    },
    signal,
  });
  if (!response.ok) throw new Error(`Google News 读取失败：${response.status}`);
  return decorateNewsSentiment(selectRecentOrBestEffort(parseGoogleNewsRss(await response.text(), 16)));
}

async function fetchBaiduNews(query: string, signal: AbortSignal) {
  const rssUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(`${plainNewsQuery(query)} 近三个月`)}&tn=newsrss&ie=utf-8`;
  const response = await fetch(rssUrl, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; CSTDAlpha/1.0; +https://alpha.custard.top)",
      accept: "application/rss+xml, application/xml, text/xml,*/*",
    },
    signal,
  });
  if (!response.ok) throw new Error(`百度新闻读取失败：${response.status}`);
  const xml = decodeNewsResponse(await response.arrayBuffer(), response.headers.get("content-type"));
  if (/百度安全验证|网络不给力|请输入验证码/.test(xml)) throw new Error("百度新闻触发安全验证");
  return decorateNewsSentiment(selectRecentOrBestEffort(parseGoogleNewsRss(xml, 16, "百度新闻")));
}

function selectRecentOrBestEffort<T extends { publishedAt?: string }>(items: T[]) {
  const recent = filterRecentNews(items, 180, 8);
  return recent.length ? recent : items.slice(0, 8);
}

function decodeNewsResponse(buffer: ArrayBuffer, contentType: string | null) {
  const encoding = /gbk|gb2312|gb18030/i.test(contentType || "") ? "gb18030" : "utf-8";
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return new TextDecoder().decode(buffer);
  }
}

function plainNewsQuery(query: string) {
  return query.replace(/\s+OR\s+/gi, " ").replace(/[;；:：]/g, " ").replace(/\s+/g, " ").trim();
}

function newsQueryVariants(query: string) {
  const plain = plainNewsQuery(query);
  const compact = plain
    .replace(/近三个月/g, "")
    .replace(/上市公司/g, "")
    .replace(/景气度/g, "")
    .replace(/政策/g, "")
    .replace(/价格/g, "")
    .replace(/业绩/g, "")
    .replace(/公告/g, "")
    .replace(/股价/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const industryCore = compact.match(/^(.+?)\s+行业\b/)?.[1]?.trim();
  return uniqueMessages([query, plain, compact, industryCore ? `${industryCore} 行业 新闻` : ""]).filter((item) => item.length > 1);
}

function uniqueMessages(messages: string[]) {
  return Array.from(new Set(messages.filter(Boolean)));
}

function newsItemsFromResult(result: PromiseSettledResult<Awaited<ReturnType<typeof fetchNewsWithFallback>>>) {
  return result.status === "fulfilled" ? result.value : [];
}

function errorFromResult(result: PromiseSettledResult<Awaited<ReturnType<typeof fetchNewsWithFallback>>>) {
  if (result.status === "fulfilled") return undefined;
  const message = result.reason instanceof Error ? result.reason.message : String(result.reason ?? "");
  return message || "新闻源暂时不可用。";
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
