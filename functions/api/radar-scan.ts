import { jsonrepair } from "jsonrepair";
import { verifySessionCookie } from "../_shared/auth";
import { decorateNewsSentiment, filterRecentNews, parseGoogleNewsRss, type NewsItem } from "../../src/shared/news";
import type { RadarItem, RadarList, RadarScan, RadarSource } from "../../src/shared/radar";

type Env = {
  AUTH_SECRET: string;
  DEEPSEEK_API_KEY?: string;
  REPORT_CACHE?: KVNamespace;
};

type RadarModel = typeof FREE_MODEL | typeof PAID_MODEL;
type RadarRoute = { model: RadarModel; url: string; apiKey?: string; isFree: boolean };

export type RadarCachePayload = {
  version: typeof RADAR_CACHE_VERSION;
  cachedAt: string;
  radar: RadarScan;
};

export const RADAR_CACHE_VERSION = "v1";
export const RADAR_CACHE_KEY = `radar-scan:${RADAR_CACHE_VERSION}:latest`;

const FREE_MODEL = "deepseek-v4-flash-free";
const PAID_MODEL = "deepseek-v4-flash";
const OPENCODE_ZEN_CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/v1/chat/completions";
const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const RADAR_VALID_HOURS = 12;
const RADAR_SOURCE_TIMEOUT_MS = 18_000;

const RADAR_QUERIES = [
  "A股 细分行业 业绩增长 景气度",
  "A股 行业 增长 可持续 需求 扩张",
  "A股 产能过剩 泡沫 股价 估值",
  "中国 半导体 设备 算力 电网 创新药 业绩 增长",
  "中国 消费 出海 高端制造 周期复苏 行业",
  "港股 互联网 创新药 高股息 行业 景气",
  "美股 AI 半导体 云计算 电力 数据中心 增长",
  "行业 衰退 技术替代 需求萎缩 产能过剩 公司",
];

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const cached = await readRadarCache(env);
  if (cached) return json({ radar: markCached(cached.radar) });

  const radar = await generateRadarScan(env, request.signal);
  await writeRadarCache(env, radar);
  return json({ radar });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const radar = await generateRadarScan(env, request.signal);
  await writeRadarCache(env, radar);
  return json({ radar });
};

export function radarModelRoutes(apiKey: string | undefined): RadarRoute[] {
  return [
    { model: FREE_MODEL, url: OPENCODE_ZEN_CHAT_COMPLETIONS_URL, isFree: true },
    ...(apiKey?.trim() ? [{ model: PAID_MODEL, url: DEEPSEEK_CHAT_COMPLETIONS_URL, apiKey: apiKey.trim(), isFree: false } as const] : []),
  ];
}

export function buildRadarRequest(route: RadarRoute, sources: RadarSource[], signal: AbortSignal): RequestInit {
  const asOfDate = new Date().toISOString().slice(0, 10);
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) },
    signal,
    body: JSON.stringify({
      model: route.model,
      reasoning_effort: "max",
      ...(route.isFree ? { thinking: { type: "enabled" } } : {}),
      response_format: { type: "json_object" },
      stream: false,
      temperature: 0.1,
      max_tokens: 14000,
      messages: [
        {
          role: "system",
          content:
            "你是 CSTD Alpha 的行业雷达分析师。只输出 JSON。必须基于证据包和长期产业逻辑，不要编造具体数据。短时间内不要因为单条新闻改变结论；只有当多源证据或长期基本面支持时才改变行业归类。区分业绩增长、股价泡沫、产业泡沫、周期复苏和长期衰退。证据不足时必须明确写入 limitations。",
        },
        {
          role: "user",
          content: JSON.stringify({
            asOfDate,
            task: RADAR_PROMPT,
            evidenceRules: [
              "先按公开信息源归纳，再做模型自己的投资分析。",
              "优先使用多源交叉验证，避免只凭单条新闻判断。",
              "增长判断至少说明需求扩张、技术突破、价格提升、市占率提升、政策推动中的主要驱动。",
              "泡沫判断必须同时说明原因、当前证据和潜在拐点。",
              "输出应稳定：如果只是短期新闻扰动，不要改变产业阶段判断。",
            ],
            expectedJsonShape: RADAR_JSON_SHAPE,
            sources,
          }),
        },
      ],
    }),
  };
}

async function generateRadarScan(env: Env, signal: AbortSignal): Promise<RadarScan> {
  const sources = await fetchRadarSources(signal);
  let lastError: unknown;
  for (const route of radarModelRoutes(env.DEEPSEEK_API_KEY)) {
    try {
      const response = await fetch(route.url, buildRadarRequest(route, sources, signal));
      const text = await response.text();
      if (!response.ok) {
        lastError = new Error(`雷达扫描失败：${route.model} ${response.status} ${text.slice(0, 400)}`);
        continue;
      }
      return normalizeRadarScan(JSON.parse(jsonrepair(contentFromModelResponse(text))), route.model, sources);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : "雷达扫描失败。");
}

async function fetchRadarSources(signal: AbortSignal): Promise<RadarSource[]> {
  const results = await Promise.allSettled(
    RADAR_QUERIES.flatMap((query) => [
      fetchGoogleNewsSources(query, signal),
      fetchBaiduNewsSources(query, signal),
      fetchEastmoneySources(query, signal),
    ]),
  );
  const items = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const deduped = dedupeSources(items);
  return deduped.slice(0, 72);
}

async function fetchGoogleNewsSources(query: string, signal: AbortSignal): Promise<RadarSource[]> {
  const timeout = timeoutSignal(signal, RADAR_SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:365d`)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`, {
      headers: {
        "user-agent": "CSTDAlpha/1.0 (+https://alpha.custard.top)",
        accept: "application/rss+xml, application/xml, text/xml",
      },
      signal: timeout.signal,
    });
    if (!response.ok) throw new Error(`Google News 读取失败：${response.status}`);
    const news = decorateNewsSentiment(filterRecentNews(parseGoogleNewsRss(await response.text(), 20), 365, 12));
    return news.map((item) => sourceFromNews(query, item));
  } catch {
    return [];
  } finally {
    timeout.cleanup();
  }
}

async function fetchBaiduNewsSources(query: string, signal: AbortSignal): Promise<RadarSource[]> {
  const timeout = timeoutSignal(signal, RADAR_SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(`https://www.baidu.com/s?wd=${encodeURIComponent(`${plainNewsQuery(query)} 近一年`)}&tn=newsrss&ie=utf-8`, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; CSTDAlpha/1.0; +https://alpha.custard.top)",
        accept: "application/rss+xml, application/xml, text/xml,*/*",
      },
      signal: timeout.signal,
    });
    if (!response.ok) throw new Error(`百度新闻读取失败：${response.status}`);
    const xml = decodeNewsResponse(await response.arrayBuffer(), response.headers.get("content-type"));
    if (/百度安全验证|网络不给力|请输入验证码/.test(xml)) throw new Error("百度新闻触发安全验证");
    const news = decorateNewsSentiment(filterRecentNews(parseGoogleNewsRss(xml, 20, "百度新闻"), 365, 12));
    return news.map((item) => sourceFromNews(query, item));
  } catch {
    return [];
  } finally {
    timeout.cleanup();
  }
}

async function fetchEastmoneySources(query: string, signal: AbortSignal): Promise<RadarSource[]> {
  const timeout = timeoutSignal(signal, RADAR_SOURCE_TIMEOUT_MS);
  try {
    const param = JSON.stringify({
      keyword: plainNewsQuery(query),
      type: ["cmsTopicWebHome"],
      client: "web",
      clientVersion: "curr",
      clientType: "web",
      param: { cmsTopicWebHome: { pageSize: 16, pageIndex: 1, postTag: "", preTag: "" } },
    });
    const response = await fetch(`https://search-api-web.eastmoney.com/search/jsonp?cb=cstd&param=${encodeURIComponent(param)}`, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; CSTDAlpha/1.0; +https://alpha.custard.top)",
        accept: "application/javascript, application/json, text/plain,*/*",
        referer: "https://so.eastmoney.com/",
      },
      signal: timeout.signal,
    });
    if (!response.ok) throw new Error(`东方财富搜索失败：${response.status}`);
    const text = await response.text();
    const jsonText = text.replace(/^[^(]*\(/, "").replace(/\);\s*$/, "");
    const data = JSON.parse(jsonText) as { result?: { cmsTopicWebHome?: Array<{ id?: string; name?: string; url?: string; introduction?: string }> } };
    return (data.result?.cmsTopicWebHome ?? [])
      .map((item) => ({
        source: "东方财富",
        query,
        title: stripSearchHtml(item.name || ""),
        url: item.url || "",
        summary: stripSearchHtml(item.introduction || ""),
      }))
      .filter((item) => item.title && item.url)
      .slice(0, 12);
  } catch {
    return [];
  } finally {
    timeout.cleanup();
  }
}

function sourceFromNews(query: string, item: NewsItem): RadarSource {
  return {
    source: item.source,
    query,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    summary: item.summary,
  };
}

function normalizeRadarScan(value: unknown, model: string, sources: RadarSource[]): RadarScan {
  const record = isRecord(value) ? value : {};
  const now = new Date();
  const generatedAt = now.toISOString();
  const validUntil = new Date(now.getTime() + RADAR_VALID_HOURS * 60 * 60 * 1000).toISOString();
  return {
    id: stringValue(record.id) || `radar-${generatedAt}`,
    title: stringValue(record.title) || "行业雷达扫描",
    generatedAt,
    asOfDate: stringValue(record.asOfDate) || generatedAt.slice(0, 10),
    validUntil,
    model,
    sourceCount: sources.length,
    sourceQueries: RADAR_QUERIES,
    fromCache: false,
    executiveSummary: stringArray(record.executiveSummary).slice(0, 8),
    solidGrowth: radarItems(record.solidGrowth),
    sustainability: radarItems(record.sustainability),
    bubbleRisks: radarItems(record.bubbleRisks),
    upcomingGrowth: radarItems(record.upcomingGrowth),
    decliningIndustries: radarItems(record.decliningIndustries),
    representativeCompanies: radarLists(record.representativeCompanies),
    stageCompanies: radarLists(record.stageCompanies),
    limitations: stringArray(record.limitations).slice(0, 8),
  };
}

async function readRadarCache(env: Env): Promise<RadarCachePayload | null> {
  const value = await env.REPORT_CACHE?.get<RadarCachePayload>(RADAR_CACHE_KEY, "json").catch(() => null);
  if (!value || value.version !== RADAR_CACHE_VERSION || !value.radar) return null;
  return value;
}

async function writeRadarCache(env: Env, radar: RadarScan) {
  const payload: RadarCachePayload = { version: RADAR_CACHE_VERSION, cachedAt: new Date().toISOString(), radar };
  await env.REPORT_CACHE?.put(RADAR_CACHE_KEY, JSON.stringify(payload));
}

function markCached(radar: RadarScan, reuseReason?: string): RadarScan {
  return { ...radar, fromCache: true, ...(reuseReason ? { reuseReason } : {}) };
}

function contentFromModelResponse(text: string) {
  const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new Error("雷达扫描模型未返回内容。");
  return content;
}

function radarItems(value: unknown): RadarItem[] {
  return arrayValue(value).map((item) => {
    const record = isRecord(item) ? item : {};
    return {
      title: stringValue(record.title),
      industries: stringArray(record.industries).slice(0, 6),
      companies: stringArray(record.companies).slice(0, 8),
      thesis: stringValue(record.thesis),
      drivers: stringArray(record.drivers).slice(0, 8),
      evidence: stringArray(record.evidence).slice(0, 8),
      durability: enumValue(record.durability, ["短期", "中期", "长期", "不确定"], "不确定"),
      riskLevel: enumValue(record.riskLevel, ["低", "中", "高"], "中"),
      turningPoints: stringArray(record.turningPoints).slice(0, 6),
    };
  });
}

function radarLists(value: unknown): RadarList[] {
  return arrayValue(value).map((item) => {
    const record = isRecord(item) ? item : {};
    return {
      label: stringValue(record.label),
      companies: stringArray(record.companies).slice(0, 12),
      note: stringValue(record.note),
    };
  });
}

function dedupeSources(items: RadarSource[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.url || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function timeoutSignal(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  const timeout = setTimeout(() => controller.abort("radar-source-timeout"), timeoutMs);
  parent.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abort);
    },
  };
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

function stripSearchHtml(value: string) {
  return value
    .replace(/<em>|<\/em>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown) {
  return arrayValue(value)
    .map((item) => stringValue(item))
    .filter(Boolean);
}

function enumValue<T extends string>(value: unknown, values: T[], fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

const RADAR_PROMPT = `一、当前扎实增长的细分产业
当前哪些细分产业里的公司，处于扎实的业绩增长当中？这些增长的主要驱动因素是什么？增长来自需求扩张、技术突破、价格提升、市占率提升，还是政策推动？

二、增长可持续性
分析业绩增长的可持续性，区分短期、长期、一次性因素，以及建立在长期护城河、需求扩张或技术升级之上的增长。

三、高增长陷阱与泡沫风险
分别指出可能存在股价泡沫和产业泡沫的行业及代表公司，说明泡沫形成原因、当前证据和潜在拐点。

四、即将进入增长期的产业和公司
判断哪些产业和公司可能即将进入增长期，增长启动信号是什么，属于产业突破期、爆发期、利润爆发期还是周期复苏期。

五、衰退产业识别
识别已经或即将步入长期或短期严重衰退的细分产业，说明技术替代、需求萎缩、政策压制、产能过剩、人口结构变化或商业模式颠覆原因，并指出衰退产业中的沙漠之花。

六、代表性公司清单
列出扎实增长、短期增长但可持续性弱、存在泡沫、即将进入增长期、已经或即将严重衰退的代表公司。

七、不同产业阶段中的典型公司
列出衰落产业中的沙漠之花、平稳产业中的杰出经营者、上升产业中的领军人物、细分产业初期的风险投资标的。`;

const RADAR_JSON_SHAPE = {
  title: "行业雷达扫描",
  asOfDate: "YYYY-MM-DD",
  executiveSummary: ["3-8 条核心结论"],
  solidGrowth: [{ title: "细分产业", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["驱动"], evidence: ["证据"], durability: "长期", riskLevel: "中", turningPoints: ["拐点"] }],
  sustainability: [{ title: "增长类型", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["驱动"], evidence: ["证据"], durability: "长期", riskLevel: "中", turningPoints: ["拐点"] }],
  bubbleRisks: [{ title: "泡沫类型", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["成因"], evidence: ["证据"], durability: "短期", riskLevel: "高", turningPoints: ["拐点"] }],
  upcomingGrowth: [{ title: "即将增长", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["信号"], evidence: ["证据"], durability: "中期", riskLevel: "中", turningPoints: ["拐点"] }],
  decliningIndustries: [{ title: "衰退产业", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["衰退原因"], evidence: ["证据"], durability: "长期", riskLevel: "高", turningPoints: ["拐点"] }],
  representativeCompanies: [{ label: "扎实增长产业中的代表公司", companies: ["公司"], note: "说明" }],
  stageCompanies: [{ label: "上升产业中的领军人物", companies: ["公司"], note: "说明" }],
  limitations: ["信息不足或需后续验证的地方"],
};
