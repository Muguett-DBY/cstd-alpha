import { jsonrepair } from "jsonrepair";
import { verifySessionCookie } from "../_shared/auth";
import { decorateNewsSentiment, filterRecentNews, parseGoogleNewsRss, type NewsItem } from "../../src/shared/news";
import type { RadarEvidenceBreakdown, RadarEvidenceType, RadarItem, RadarList, RadarScan, RadarSource } from "../../src/shared/radar";

type Env = {
  AUTH_SECRET: string;
  DEEPSEEK_API_KEY?: string;
  REPORT_CACHE?: KVNamespace;
};

type RadarModel = (typeof ZEN_FREE_MODELS)[number];
type RadarRoute = { model: RadarModel; url: string; apiKey?: string; isFree: boolean };

export type RadarCachePayload = {
  version: typeof RADAR_CACHE_VERSION;
  cachedAt: string;
  radar: RadarScan;
};

export const RADAR_CACHE_VERSION = "v1";
export const RADAR_CACHE_KEY = `radar-scan:${RADAR_CACHE_VERSION}:latest`;

const ZEN_FREE_MODELS = ["nemotron-3-super-free", "deepseek-v4-flash-free", "minimax-m2.5-free", "big-pickle", "qwen3.6-plus-free"] as const;
const ZEN_MODEL_REASONING: Partial<Record<RadarModel, "high" | "max">> = {
  "deepseek-v4-flash-free": "max",
  "nemotron-3-super-free": "high",
};
const OPENCODE_ZEN_CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/v1/chat/completions";
const RADAR_VALID_HOURS = 12;
const RADAR_SOURCE_TIMEOUT_MS = 18_000;
const RADAR_FREE_PLAN_SOURCE_REQUEST_BUDGET = 42;

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

const RADAR_HARD_DATA_QUERIES = [
  "碳酸锂 价格 库存 产能 锂电",
  "硅料 光伏组件 价格 产能 开工率",
  "存储芯片 DRAM NAND 价格 库存",
  "铜 钨 稀土 价格 供需 库存",
  "钢铁 水泥 价格 开工率 需求",
  "航运 运价 指数 供需",
  "猪价 产能 库存 周期",
  "汽车 销量 新能源车 出口 数据",
  "电力 发电量 装机量 数据中心 用电",
  "创新药 审批 临床 商业化 数据",
];

const RADAR_ANNOUNCEMENT_QUERIES = [
  "业绩预告 净利润 预增 订单 毛利率 现金流",
  "一季报 营收 净利润 毛利率 订单 产能",
  "年报 经营现金流 在手订单 资本开支",
];

const RADAR_RESEARCH_QUERIES = [
  "行业研报 高景气 业绩增长 细分产业",
  "券商研报 产能过剩 行业泡沫 估值",
];

type RadarSourcePlanItem =
  | { kind: "google"; tier: RadarEvidenceType; query: string }
  | { kind: "baidu"; tier: RadarEvidenceType; query: string }
  | { kind: "eastmoney"; tier: RadarEvidenceType; query: string; sourceName?: string; sourceType?: RadarEvidenceType }
  | { kind: "boards"; tier: RadarEvidenceType };

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const cached = await readRadarCache(env);
  if (cached) return json({ radar: markCached(cached.radar) });

  try {
    const radar = await generateRadarScan(env, request.signal, null);
    await writeRadarCache(env, radar);
    return json({ radar });
  } catch (error) {
    return json({ error: radarErrorMessage(error, "read") }, 502);
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const cached = await readRadarCache(env);
  try {
    const radar = await generateRadarScan(env, request.signal, cached?.radar ?? null);
    await writeRadarCache(env, radar);
    return json({ radar });
  } catch (error) {
    const warning = radarErrorMessage(error, "refresh");
    if (cached) {
      return json({
        radar: markCached(cached.radar, "本次刷新失败，已保留上次稳定扫描。", warning),
        warning,
      });
    }
    return json({ error: warning }, 502);
  }
};

export function radarModelRoutes(apiKey: string | undefined): RadarRoute[] {
  void apiKey;
  return ZEN_FREE_MODELS.map((model) => ({ model, url: OPENCODE_ZEN_CHAT_COMPLETIONS_URL, isFree: true }));
}

export function buildRadarRequest(route: RadarRoute, sources: RadarSource[], signal: AbortSignal, previousScan?: RadarScan | null): RequestInit {
  const asOfDate = new Date().toISOString().slice(0, 10);
  const evidenceBreakdown = summarizeEvidenceBreakdown(sources);
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) },
    signal,
    body: JSON.stringify({
      model: route.model,
      ...(ZEN_MODEL_REASONING[route.model] ? { reasoning_effort: ZEN_MODEL_REASONING[route.model], thinking: { type: "enabled", budget_tokens: 8192 } } : {}),
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
              "硬数据和公告证据优先于新闻与研报观点；新闻只负责发现线索，硬数据负责验证增长。",
              "增长判断至少说明需求扩张、技术突破、价格提升、市占率提升、政策推动中的主要驱动。",
              "泡沫判断必须同时说明原因、当前证据和潜在拐点。",
              "输出应稳定：如果只是短期新闻扰动，不要改变产业阶段判断；若改变归类，必须写明 changeReason。",
            ],
            evidenceBreakdown,
            evidenceWeights: {
              hard_data: 5,
              official: 4,
              announcement: 4,
              market: 3,
              news: 2,
              research: 1,
            },
            previousScan: previousScan ? summarizePreviousScan(previousScan) : null,
            expectedJsonShape: RADAR_JSON_SHAPE,
            sources,
          }),
        },
      ],
    }),
  };
}

async function generateRadarScan(env: Env, signal: AbortSignal, previousScan: RadarScan | null): Promise<RadarScan> {
  const sources = await fetchRadarSources(signal);
  let lastError: unknown;
  for (const route of radarModelRoutes(env.DEEPSEEK_API_KEY)) {
    try {
      const response = await fetch(route.url, buildRadarRequest(route, sources, signal, previousScan));
      const text = await response.text();
      if (!response.ok) {
        lastError = new Error(`雷达扫描失败：${route.model} ${response.status} ${text.slice(0, 400)}`);
        continue;
      }
      return normalizeRadarScan(JSON.parse(jsonrepair(contentFromModelResponse(text))), route.model, sources, previousScan);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : "雷达扫描失败。");
}

async function fetchRadarSources(signal: AbortSignal): Promise<RadarSource[]> {
  const results = await Promise.allSettled(createRadarSourcePlan().map((item) => fetchRadarSourcePlanItem(item, signal)));
  const items = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const deduped = dedupeSources(items);
  return deduped.sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0)).slice(0, 96);
}

export function createRadarSourcePlan(): RadarSourcePlanItem[] {
  const plan: RadarSourcePlanItem[] = [
    { kind: "boards", tier: "market" },
    ...RADAR_HARD_DATA_QUERIES.slice(0, 8).flatMap<RadarSourcePlanItem>((query) => [
      { kind: "eastmoney", tier: "hard_data", query, sourceName: "行业价格", sourceType: "hard_data" },
      { kind: "google", tier: "hard_data", query },
    ]),
    ...RADAR_ANNOUNCEMENT_QUERIES.flatMap<RadarSourcePlanItem>((query) => [
      { kind: "eastmoney", tier: "announcement", query, sourceName: "公司公告", sourceType: "announcement" },
      { kind: "google", tier: "announcement", query },
    ]),
    ...RADAR_QUERIES.slice(0, 6).flatMap<RadarSourcePlanItem>((query) => [
      { kind: "google", tier: "news", query },
      { kind: "baidu", tier: "news", query },
      { kind: "eastmoney", tier: "news", query },
    ]),
    ...RADAR_RESEARCH_QUERIES.map<RadarSourcePlanItem>((query) => ({ kind: "eastmoney", tier: "research", query, sourceName: "研报摘要", sourceType: "research" })),
  ];
  return plan.slice(0, RADAR_FREE_PLAN_SOURCE_REQUEST_BUDGET);
}

async function fetchRadarSourcePlanItem(item: RadarSourcePlanItem, signal: AbortSignal): Promise<RadarSource[]> {
  if (item.kind === "google") return fetchGoogleNewsSources(item.query, signal);
  if (item.kind === "baidu") return fetchBaiduNewsSources(item.query, signal);
  if (item.kind === "boards") return fetchEastmoneyBoardSources(signal);
  return fetchEastmoneySources(item.query, signal, item.sourceName, item.sourceType);
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

async function fetchEastmoneySources(query: string, signal: AbortSignal, sourceName = "东方财富搜索", sourceType?: RadarEvidenceType): Promise<RadarSource[]> {
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
        source: sourceName,
        query,
        title: stripSearchHtml(item.name || ""),
        url: item.url || "",
        summary: stripSearchHtml(item.introduction || ""),
        sourceType,
      }))
      .filter((item) => item.title && item.url)
      .map(classifyRadarSource)
      .slice(0, 12);
  } catch {
    return [];
  } finally {
    timeout.cleanup();
  }
}

async function fetchEastmoneyBoardSources(signal: AbortSignal): Promise<RadarSource[]> {
  const timeout = timeoutSignal(signal, RADAR_SOURCE_TIMEOUT_MS);
  try {
    const endpoints = [
      { label: "东方财富行业板块", fs: "m:90+t:2" },
      { label: "东方财富概念板块", fs: "m:90+t:3" },
    ];
    const responses = await Promise.allSettled(
      endpoints.map(async (endpoint) => {
        const url = new URL("https://push2.eastmoney.com/api/qt/clist/get");
        url.search = new URLSearchParams({
          pn: "1",
          pz: "24",
          po: "1",
          np: "1",
          ut: "bd1d9ddb04089700cf9c27f6f7426281",
          fltt: "2",
          invt: "2",
          fid: "f3",
          fs: endpoint.fs,
          fields: "f12,f14,f3,f62,f128,f136,f140,f184",
        }).toString();
        const response = await fetch(url, {
          headers: {
            "user-agent": "Mozilla/5.0 (compatible; CSTDAlpha/1.0; +https://alpha.custard.top)",
            accept: "application/json,text/plain,*/*",
            referer: "https://quote.eastmoney.com/",
          },
          signal: timeout.signal,
        });
        if (!response.ok) throw new Error(`${endpoint.label}读取失败：${response.status}`);
        const data = (await response.json()) as { data?: { diff?: Array<Record<string, unknown>> } };
        return (data.data?.diff ?? []).map((item) =>
          classifyRadarSource({
            source: endpoint.label,
            query: "东方财富板块/行业/概念数据",
            title: `${stringValue(item.f14)} 涨跌幅 ${formatSourceNumber(item.f3)}%，主力净流入 ${formatSourceNumber(item.f62)}`,
            url: `https://quote.eastmoney.com/bk/${stringValue(item.f12)}.html`,
            summary: `领涨股 ${stringValue(item.f128) || "待验证"}，资金占比 ${formatSourceNumber(item.f184)}。`,
            sourceType: "market",
          }),
        );
      }),
    );
    return responses.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  } catch {
    return [];
  } finally {
    timeout.cleanup();
  }
}

function sourceFromNews(query: string, item: NewsItem): RadarSource {
  return classifyRadarSource({
    source: item.source,
    query,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    summary: item.summary,
  });
}

function normalizeRadarScan(value: unknown, model: string, sources: RadarSource[], previousScan: RadarScan | null): RadarScan {
  const record = isRecord(value) ? value : {};
  const now = new Date();
  const generatedAt = now.toISOString();
  const validUntil = new Date(now.getTime() + RADAR_VALID_HOURS * 60 * 60 * 1000).toISOString();
  const previousTitles = previousRadarTitles(previousScan);
  const scan: RadarScan = {
    id: stringValue(record.id) || `radar-${generatedAt}`,
    title: stringValue(record.title) || "行业雷达扫描",
    generatedAt,
    asOfDate: stringValue(record.asOfDate) || generatedAt.slice(0, 10),
    validUntil,
    model,
    sourceCount: sources.length,
    sourceQueries: allRadarQueries(),
    evidenceBreakdown: summarizeEvidenceBreakdown(sources),
    confidenceSummary:
      stringValue(record.confidenceSummary) ||
      "置信度按硬数据、公告、市场数据、新闻和研报的交叉验证强弱生成；硬数据和公告权重最高。",
    fromCache: false,
    executiveSummary: stringArray(record.executiveSummary).slice(0, 8),
    solidGrowth: radarItems(record.solidGrowth, previousTitles),
    sustainability: radarItems(record.sustainability, previousTitles),
    bubbleRisks: radarItems(record.bubbleRisks, previousTitles),
    upcomingGrowth: radarItems(record.upcomingGrowth, previousTitles),
    decliningIndustries: radarItems(record.decliningIndustries, previousTitles),
    representativeCompanies: radarLists(record.representativeCompanies),
    stageCompanies: radarLists(record.stageCompanies),
    limitations: stringArray(record.limitations).slice(0, 8),
  };
  return {
    ...scan,
    changeLog: stringArray(record.changeLog).slice(0, 8).length ? stringArray(record.changeLog).slice(0, 8) : buildChangeLog(previousScan, scan),
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

function markCached(radar: RadarScan, reuseReason?: string, refreshWarning?: string): RadarScan {
  return { ...radar, fromCache: true, ...(reuseReason ? { reuseReason } : {}), ...(refreshWarning ? { refreshWarning } : {}) };
}

function contentFromModelResponse(text: string) {
  const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new Error("雷达扫描模型未返回内容。");
  return content;
}

function radarItems(value: unknown, previousTitles = new Set<string>()): RadarItem[] {
  return arrayValue(value).map((item) => {
    const record = isRecord(item) ? item : {};
    const title = stringValue(record.title);
    const confidence = enumValue<NonNullable<RadarItem["confidence"]>>(record.confidence, ["低", "中", "高"], "中");
    return {
      title,
      industries: stringArray(record.industries).slice(0, 6),
      companies: stringArray(record.companies).slice(0, 8),
      thesis: stringValue(record.thesis),
      drivers: stringArray(record.drivers).slice(0, 8),
      evidence: stringArray(record.evidence).slice(0, 8),
      durability: enumValue(record.durability, ["短期", "中期", "长期", "不确定"], "不确定"),
      riskLevel: enumValue(record.riskLevel, ["低", "中", "高"], "中"),
      confidence,
      evidenceTypes: evidenceTypes(record.evidenceTypes),
      supportingSourceCount: numberValue(record.supportingSourceCount),
      changeReason:
        stringValue(record.changeReason) ||
        (title && previousTitles.has(title) ? "延续上次稳定判断，本次证据未形成足够反转。" : "本次扫描基于新增公开证据或硬数据重新归类。"),
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

export function classifyRadarSource(source: RadarSource): RadarSource {
  const text = `${source.source} ${source.query} ${source.title} ${source.summary ?? ""}`;
  const sourceType =
    source.sourceType ??
    (/(价格|产能|库存|开工率|销量|装机|发电量|出口|订单|碳酸锂|硅料|运价|猪价|钢铁|水泥|DRAM|NAND)/i.test(text)
      ? "hard_data"
      : /(公告|业绩预告|财报|年报|季报|一季报|中报|毛利率|现金流)/i.test(text)
        ? "announcement"
        : /(统计局|协会|工信部|海关|发改委|中汽协|乘联会|药监局)/i.test(text)
          ? "official"
          : /(板块|概念|资金流|涨跌幅|主力净流入|估值|市盈率|成交额)/i.test(text)
            ? "market"
            : /(研报|研究报告|券商|评级|目标价)/i.test(text)
              ? "research"
              : "news");
  return { ...source, sourceType, weight: source.weight ?? evidenceWeight(sourceType) };
}

export function summarizeEvidenceBreakdown(sources: ReadonlyArray<RadarSource>): RadarEvidenceBreakdown {
  return sources.reduce<RadarEvidenceBreakdown>((sum, source) => {
    const sourceType = source.sourceType ?? classifyRadarSource(source).sourceType ?? "news";
    sum[sourceType] = (sum[sourceType] ?? 0) + 1;
    return sum;
  }, {});
}

function evidenceWeight(sourceType: RadarEvidenceType) {
  return {
    hard_data: 5,
    official: 4,
    announcement: 4,
    market: 3,
    news: 2,
    research: 1,
  }[sourceType];
}

function allRadarQueries() {
  return [...RADAR_QUERIES, ...RADAR_HARD_DATA_QUERIES, ...RADAR_ANNOUNCEMENT_QUERIES, ...RADAR_RESEARCH_QUERIES];
}

function summarizePreviousScan(scan: RadarScan) {
  return {
    id: scan.id,
    generatedAt: scan.generatedAt,
    asOfDate: scan.asOfDate,
    executiveSummary: scan.executiveSummary.slice(0, 5),
    solidGrowth: scan.solidGrowth.map((item) => item.title).slice(0, 8),
    bubbleRisks: scan.bubbleRisks.map((item) => item.title).slice(0, 8),
    upcomingGrowth: scan.upcomingGrowth.map((item) => item.title).slice(0, 8),
    decliningIndustries: scan.decliningIndustries.map((item) => item.title).slice(0, 8),
  };
}

function previousRadarTitles(scan: RadarScan | null) {
  return new Set(
    scan
      ? [...scan.solidGrowth, ...scan.sustainability, ...scan.bubbleRisks, ...scan.upcomingGrowth, ...scan.decliningIndustries].map((item) => item.title).filter(Boolean)
      : [],
  );
}

function buildChangeLog(previousScan: RadarScan | null, scan: RadarScan) {
  if (!previousScan) return ["首次生成雷达扫描，后续刷新将与本次结果比较并说明变化原因。"];
  const previousTitles = previousRadarTitles(previousScan);
  const currentTitles = previousRadarTitles(scan);
  const added = [...currentTitles].filter((title) => !previousTitles.has(title));
  const retained = [...currentTitles].filter((title) => previousTitles.has(title));
  const removed = [...previousTitles].filter((title) => !currentTitles.has(title));
  return [
    retained.length ? `延续判断：${retained.slice(0, 5).join("、")}。` : "",
    added.length ? `新增或调整：${added.slice(0, 5).join("、")}。` : "",
    removed.length ? `本次未延续：${removed.slice(0, 5).join("、")}，需看后续硬数据确认是否为阶段变化。` : "",
  ].filter(Boolean);
}

function radarErrorMessage(error: unknown, mode: "read" | "refresh") {
  const message = error instanceof Error ? error.message : String(error || "");
  const prefix = mode === "refresh" ? "本次刷新失败，已保留上次扫描。" : "雷达扫描暂时不可用。";
  if (/429|rate.?limit|限流|quota|FreeUsageLimit/i.test(message)) return `${prefix} 模型限流或额度暂时不可用，请稍后再试。`;
  if (/timeout|Abort|timed out|超时/i.test(message)) return `${prefix} 外部数据源或模型请求超时，请稍后再试。`;
  if (/JSON|jsonrepair|parse|格式|未返回内容/i.test(message)) return `${prefix} 模型返回格式不完整，请稍后重试。`;
  return `${prefix} ${message.slice(0, 160) || "外部模型或数据源临时异常。"}`;
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

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatSourceNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return stringValue(value) || "待验证";
}

function stringArray(value: unknown) {
  return arrayValue(value)
    .map((item) => stringValue(item))
    .filter(Boolean);
}

function evidenceTypes(value: unknown): RadarEvidenceType[] {
  return stringArray(value)
    .filter((item): item is RadarEvidenceType => ["hard_data", "official", "announcement", "market", "news", "research"].includes(item))
    .slice(0, 6);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
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
  confidenceSummary: "说明本轮结论的总体置信度和主要证据类型",
  changeLog: ["相比上次扫描保留、新增、降级或删除了哪些判断，以及原因"],
  executiveSummary: ["3-8 条核心结论"],
  solidGrowth: [
    {
      title: "细分产业",
      industries: ["行业"],
      companies: ["公司"],
      thesis: "分析",
      drivers: ["驱动"],
      evidence: ["证据"],
      evidenceTypes: ["hard_data", "announcement"],
      supportingSourceCount: 5,
      confidence: "高",
      durability: "长期",
      riskLevel: "中",
      changeReason: "为什么延续或改变判断",
      turningPoints: ["拐点"],
    },
  ],
  sustainability: [{ title: "增长类型", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["驱动"], evidence: ["证据"], evidenceTypes: ["hard_data"], supportingSourceCount: 3, confidence: "中", durability: "长期", riskLevel: "中", changeReason: "变化原因", turningPoints: ["拐点"] }],
  bubbleRisks: [{ title: "泡沫类型", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["成因"], evidence: ["证据"], evidenceTypes: ["market"], supportingSourceCount: 3, confidence: "中", durability: "短期", riskLevel: "高", changeReason: "变化原因", turningPoints: ["拐点"] }],
  upcomingGrowth: [{ title: "即将增长", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["信号"], evidence: ["证据"], evidenceTypes: ["announcement"], supportingSourceCount: 2, confidence: "中", durability: "中期", riskLevel: "中", changeReason: "变化原因", turningPoints: ["拐点"] }],
  decliningIndustries: [{ title: "衰退产业", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["衰退原因"], evidence: ["证据"], evidenceTypes: ["hard_data"], supportingSourceCount: 4, confidence: "高", durability: "长期", riskLevel: "高", changeReason: "变化原因", turningPoints: ["拐点"] }],
  representativeCompanies: [{ label: "扎实增长产业中的代表公司", companies: ["公司"], note: "说明" }],
  stageCompanies: [{ label: "上升产业中的领军人物", companies: ["公司"], note: "说明" }],
  limitations: ["信息不足或需后续验证的地方"],
};
