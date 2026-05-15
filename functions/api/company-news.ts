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
    fetchNewsWithFallback(companyQuery, { days: 180, baiduWindow: "近六个月", limit: 12, variantLimit: 5, requiredAny: [item.company.name, item.company.code] }, request.signal),
    fetchNewsWithFallback(
      industryQuery,
      {
        days: 1095,
        baiduWindow: "近三年",
        limit: 16,
        variantLimit: 7,
        requiredAny: industryRelevanceTerms(industryQuery),
        titleRequiredAny: industryRelevanceTerms(industryQuery),
      },
      request.signal,
    ),
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

type NewsWindow = {
  days: number;
  baiduWindow: string;
  limit: number;
  variantLimit: number;
  requiredAny: string[];
  titleRequiredAny?: string[];
};

async function fetchNewsWithFallback(query: string, window: NewsWindow, signal: AbortSignal) {
  const errors: string[] = [];
  const variants = newsQueryVariants(query).slice(0, window.variantLimit);
  const requests = variants.flatMap((variant) =>
    [
      { name: "Google News", run: fetchGoogleNews },
      { name: "百度新闻", run: fetchBaiduNews },
    ].map(async (source) => {
      try {
        const items = await source.run(variant, window, signal);
        if (!items.length) errors.push(`${source.name} 返回空列表：${variant}`);
        return { source: source.name, variant, items };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error ?? ""));
        return { source: source.name, variant, items: [] };
      }
    }),
  );
  const results = await Promise.all(requests);
  const items = selectNewsPortfolio(
    results.flatMap((result) => result.items),
    window.days,
    window.limit,
    window.requiredAny,
    window.titleRequiredAny,
  );
  if (items.length) return items;
  throw new Error(uniqueMessages(errors).slice(0, 6).join("；") || "新闻源暂时不可用。");
}

async function fetchGoogleNews(query: string, window: NewsWindow, signal: AbortSignal) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${window.days}d`)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  const response = await fetch(rssUrl, {
    headers: {
      "user-agent": "CSTDAlpha/1.0 (+https://alpha.custard.top)",
      accept: "application/rss+xml, application/xml, text/xml",
    },
    signal,
  });
  if (!response.ok) throw new Error(`Google News 读取失败：${response.status}`);
  return decorateNewsSentiment(selectRecentOrBestEffort(parseGoogleNewsRss(await response.text(), 32), window.days, window.limit * 2));
}

async function fetchBaiduNews(query: string, window: NewsWindow, signal: AbortSignal) {
  const rssUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(`${plainNewsQuery(query)} ${window.baiduWindow}`)}&tn=newsrss&ie=utf-8`;
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
  return decorateNewsSentiment(selectRecentOrBestEffort(parseGoogleNewsRss(xml, 32, "百度新闻"), window.days, window.limit * 2));
}

function selectRecentOrBestEffort<T extends { publishedAt?: string }>(items: T[], days: number, limit: number) {
  const recent = filterRecentNews(items, days, limit);
  return recent.length ? recent : items.slice(0, limit);
}

function selectNewsPortfolio<T extends { id: string; publishedAt?: string; source?: string; title?: string; summary?: string }>(
  items: T[],
  days: number,
  limit: number,
  requiredAny: string[],
  titleRequiredAny: string[] = [],
) {
  const textRelevantItems = items.filter((item) => isRelevantNewsItem(item, requiredAny));
  const titleRelevantItems = titleRequiredAny.length ? items.filter((item) => isRelevantNewsItem(item, requiredAny, titleRequiredAny)) : [];
  const relevantItems = titleRelevantItems.length >= Math.min(2, limit) ? titleRelevantItems : textRelevantItems;
  const relevancePool = relevantItems.length ? relevantItems : items;
  const strictQualityItems = relevancePool.filter((item) => isUsefulNewsItem(item) && isNotConflictingIndustryResearch(item, titleRequiredAny));
  const looseQualityItems = relevancePool.filter((item) => isUsefulNewsItem(item) && (!titleRequiredAny.length || isNotConflictingIndustryResearch(item, titleRequiredAny)));
  const qualityItems = strictQualityItems.length >= Math.min(3, limit) ? strictQualityItems : looseQualityItems.length ? looseQualityItems : relevancePool;
  const deduped = dedupeNewsItems(qualityItems);
  const recent = filterRecentNews(deduped, days, limit * 3);
  const candidates = sortNewsByDate(recent.length ? recent : deduped);
  return diversifyBySource(candidates, limit);
}

function isRelevantNewsItem(item: { title?: string; summary?: string }, requiredAny: string[], titleRequiredAny: string[] = []) {
  const terms = requiredAny.map((term) => normalizeRelevanceTerm(term)).filter((term) => term.length >= 2);
  const titleTerms = titleRequiredAny.map((term) => normalizeRelevanceTerm(term)).filter((term) => term.length >= 2);
  const title = normalizeRelevanceTerm(item.title || "");
  if (titleTerms.length && !titleTerms.some((term) => title.includes(term))) return false;
  if (!terms.length) return true;
  const text = normalizeRelevanceTerm(`${item.title || ""} ${item.summary || ""}`);
  return terms.some((term) => text.includes(term));
}

function isUsefulNewsItem(item: { title?: string; summary?: string; source?: string }) {
  const text = `${item.title || ""} ${item.summary || ""}`.trim();
  const source = item.source || "";
  if (/百度文库|股吧|问答|百科/.test(source)) return false;
  return !/最新价格|走势图|历史数据|股票行情|股票吧|行情首页|盘口|资金流向|主力资金|个股资料|个股分析|牛叉诊股|F10|实时行情|手机东方财富|手机同花顺财经|历史市盈率|历次上榜后表现|营业部买卖统计|股价行情|行情_市值|财报研报数据|数据报告|估值——|技术分析/.test(text);
}

function isNotConflictingIndustryResearch(item: { title?: string }, titleRequiredAny: string[]) {
  const terms = titleRequiredAny.map((term) => normalizeRelevanceTerm(term)).filter((term) => term.length >= 2);
  if (!terms.length) return true;
  const title = normalizeRelevanceTerm(item.title || "");
  if (!/行业|产业|市场|竞争格局|供需|产量|发展趋势|现状/.test(item.title || "")) return true;
  return terms.some((term) => title.includes(term));
}

function dedupeNewsItems<T extends { id: string; title?: string; url?: string }>(items: T[]) {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const item of items) {
    const key = (item.url || item.id || item.title || "").replace(/[?#].*$/, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(item);
  }
  return rows;
}

function sortNewsByDate<T extends { publishedAt?: string }>(items: T[]) {
  return [...items].sort((left, right) => {
    const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });
}

function diversifyBySource<T extends { source?: string }>(items: T[], limit: number) {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const source = item.source || "未知来源";
    const bucket = buckets.get(source) || [];
    bucket.push(item);
    buckets.set(source, bucket);
  }

  const selected: T[] = [];
  while (selected.length < limit && buckets.size) {
    for (const [source, bucket] of Array.from(buckets.entries())) {
      const item = bucket.shift();
      if (item) selected.push(item);
      if (!bucket.length) buckets.delete(source);
      if (selected.length >= limit) break;
    }
  }
  return selected;
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
    .replace(/近六个月/g, "")
    .replace(/近三年/g, "")
    .replace(/上市公司/g, "")
    .replace(/景气度/g, "")
    .replace(/政策/g, "")
    .replace(/监管/g, "")
    .replace(/回购/g, "")
    .replace(/事故/g, "")
    .replace(/周期/g, "")
    .replace(/供需/g, "")
    .replace(/竞争格局/g, "")
    .replace(/价格/g, "")
    .replace(/业绩/g, "")
    .replace(/公告/g, "")
    .replace(/股价/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const industryCore = compact.match(/^(.+?)\s+行业\b/)?.[1]?.trim();
  const tokens = compact.split(/\s+/).filter(Boolean);
  const companyName = tokens[0] || "";
  const companyCode = /\d|[A-Z]{1,6}/i.test(tokens[1] || "") ? tokens[1] : "";
  const companyCore = [companyName, companyCode].filter(Boolean).join(" ");
  return uniqueMessages([
    query,
    plain,
    compact,
    industryCore ? `${industryCore} 行业 新闻` : "",
    industryCore ? `${industryCore} 行业 竞争格局 市场规模 政策` : "",
    industryCore ? `${industryCore} 产业 发展趋势 供需 价格` : "",
    companyCore ? `${companyCore} 新闻` : "",
    companyName ? `${companyName} 业绩 公告 股价` : "",
  ]).filter((item) => item.length > 1);
}

function industryRelevanceTerms(query: string) {
  const scope = query.split(/\s+行业\b/)[0] || query;
  const parts = scope
    .split(/[\s/／]+/)
    .map((part) => part.trim())
    .filter((part) => part && !/^(所属行业|未分类|行业待验证|近三年)$/.test(part));
  const broadTerms = new Set(["食品饮料", "消费", "大消费", "制造业", "工业", "服务业"]);
  const specificTerms = parts.filter((part) => !broadTerms.has(part));
  const primary = specificTerms.at(-1);
  if (!primary) return parts;
  return uniqueMessages([primary, ...specificTerms.filter((part) => part.length >= 4)]);
}

function normalizeRelevanceTerm(value: string) {
  return value.toLowerCase().replace(/\s+/g, "");
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
