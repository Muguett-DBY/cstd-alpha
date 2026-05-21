import { jsonrepair } from "jsonrepair";
import { readSessionCookie } from "../_shared/auth";
import { decorateNewsSentiment, filterRecentNews, parseGoogleNewsRss, type NewsItem } from "../../src/shared/news";
import type {
  RadarCitation,
  RadarAnalysisJob,
  RadarAnalysisJobStatus,
  RadarConclusionStrength,
  RadarCoverageItem,
  RadarCoverageReview,
  RadarCoverageStatus,
  RadarEvidenceBreakdown,
  RadarEvidenceGap,
  RadarEvidenceType,
  RadarEvidenceFreshness,
  RadarDiagnostics,
  RadarDriverTag,
  RadarItem,
  RadarList,
  RadarScan,
  RadarSource,
  RadarSustainabilityTier,
} from "../../src/shared/radar";

type Env = {
  AUTH_SECRET: string;
  DEEPSEEK_API_KEY?: string;
  GITHUB_RADAR_DISPATCH_TOKEN?: string;
  GITHUB_RADAR_REPOSITORY?: string;
  GITHUB_RADAR_WORKFLOW?: string;
  REPORT_CACHE?: KVNamespace;
  REPORT_LIBRARY_DB?: D1Database;
};

type RadarModel = typeof DEEPSEEK_PAID_MODEL;
type RadarRoute = { model: RadarModel; url: string; apiKey?: string; isFree: boolean };

export type RadarCachePayload = {
  version: typeof RADAR_CACHE_VERSION;
  cachedAt: string;
  radar: RadarScan;
};

export type RadarEvidencePacket = {
  topic: string;
  score: number;
  sourceIds: string[];
  evidenceTypes: RadarEvidenceType[];
  signalTypes: string[];
  summary: string;
  signals: string[];
};

export type RadarEvidenceDigest = {
  sourceFingerprint: string;
  sourceCount: number;
  evidenceBreakdown: RadarEvidenceBreakdown;
  citations: RadarCitation[];
  packets: RadarEvidencePacket[];
  softCoverage: RadarCoverageItem[];
};

type RadarSourceCachePayload = {
  version: typeof RADAR_SOURCE_CACHE_VERSION;
  cachedAt: string;
  expiresAt: string;
  sources: RadarSource[];
};

type ScoredRadarSource = RadarSource & {
  sourceType: RadarEvidenceType;
  weight: number;
  score?: number;
};

type RadarDigestCachePayload = {
  version: typeof RADAR_DIGEST_CACHE_VERSION;
  cachedAt: string;
  sourceFingerprint: string;
  digest: RadarEvidenceDigest;
};

type RadarEvidenceSnapshotPayload = {
  version: typeof RADAR_EVIDENCE_SNAPSHOT_VERSION;
  generatedAt: string;
  asOfDate: string;
  source: string;
  evidenceHash?: string;
  sources: RadarSource[];
  quality?: Record<string, unknown>;
  industryPackets?: unknown[];
};

export const RADAR_CACHE_VERSION = "v2";
export const RADAR_CACHE_KEY = `radar-scan:${RADAR_CACHE_VERSION}:latest`;
export const RADAR_SOURCE_CACHE_VERSION = "v2";
export const RADAR_SOURCE_CACHE_KEY = `radar-sources:${RADAR_SOURCE_CACHE_VERSION}:latest`;
export const RADAR_DIGEST_CACHE_VERSION = "v3";
export const RADAR_DIGEST_CACHE_KEY = `radar-digest:${RADAR_DIGEST_CACHE_VERSION}:latest`;
export const RADAR_EVIDENCE_SNAPSHOT_VERSION = "v1";
export const RADAR_EVIDENCE_SNAPSHOT_KEY = `radar-evidence:${RADAR_EVIDENCE_SNAPSHOT_VERSION}:latest`;
export const RADAR_ANALYSIS_JOB_PREFIX = "radar-analysis:job:";
export const RADAR_ANALYSIS_JOB_LATEST_KEY = `${RADAR_ANALYSIS_JOB_PREFIX}latest`;
const LEGACY_RADAR_CACHE_KEYS = ["radar-scan:v1:latest"];
const LEGACY_RADAR_SOURCE_CACHE_KEYS = ["radar-sources:v1:latest"];
const MIN_RADAR_SOURCE_COUNT = 36;

const DEEPSEEK_PAID_MODEL = "deepseek-v4-flash";
const RADAR_MODEL_REASONING: Partial<Record<RadarModel, "max">> = { "deepseek-v4-flash": "max" };
const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const GITHUB_RADAR_REPOSITORY = "Muguett-DBY/cstd-alpha";
const GITHUB_RADAR_WORKFLOW = "radar-analysis.yml";
const RADAR_VALID_HOURS = 12;
const RADAR_SOURCE_CACHE_HOURS = 6;
const RADAR_SOURCE_TIMEOUT_MS = 18_000;
const RADAR_MODEL_TIMEOUT_MS = 85_000;
const RADAR_FREE_PLAN_SOURCE_REQUEST_BUDGET = 38;
const RADAR_DIGEST_CITATION_LIMIT = 48;
const RADAR_DIGEST_NEWS_FLOOR = 10;
const RADAR_DIGEST_MAX_NEWS_SHARE = 0.3;
const RADAR_DIGEST_MAX_SINGLE_SOURCE_SHARE = 0.46;
const RADAR_CONCLUSION_STRENGTHS: readonly RadarConclusionStrength[] = ["正式结论", "观察", "证据不足"];
const RADAR_EVIDENCE_GAPS: readonly RadarEvidenceGap[] = ["缺财报", "缺价格", "缺销量", "缺订单", "缺库存", "缺产能", "缺现金流", "缺政策细则", "缺公司公告", "缺多源验证"];
const RADAR_DRIVER_TAGS: readonly RadarDriverTag[] = ["需求", "价格", "技术", "政策", "市占率", "供给收缩"];
const RADAR_SUSTAINABILITY_TIERS: readonly RadarSustainabilityTier[] = ["短期催化", "中期景气", "长期护城河"];

const RADAR_QUERIES = [
  "A股 细分行业 业绩增长 景气度",
  "A股 行业 增长 可持续 需求 扩张",
  "A股 产能过剩 泡沫 股价 估值",
  "中国 半导体 设备 算力 电网 创新药 业绩 增长",
  "中国 消费 出海 高端制造 周期复苏 行业",
  "港股 互联网 创新药 高股息 行业 景气",
  "A股 港股 AI 半导体 云计算 电力 数据中心 增长",
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

const RADAR_STABLE_INDUSTRY_QUERIES = [
  "A股 平稳产业 高股息 现金流 公用事业 电信 水电",
  "A股 港股 平稳产业 分红 ROE 经营现金流",
  "港股 高股息 稳定现金流 电信 公用事业 能源",
];

const RADAR_COMPANY_UNIVERSE_RULES = [
  "代表公司只能列 A 股或港股上市公司，包括 A 股主板、科创板、创业板、北交所和港股主板公司。",
  "可以参考全球产业链信息判断行业趋势，但 companies、representativeCompanies、stageCompanies 里不得输出美股、欧股、日股或未上市公司。",
  "如果某个细分产业的核心代表主要是海外公司，不要用海外公司替代；改为列 A/H 对标公司，若找不到就留空并写入 limitations。",
  "不得把美光、Micron、英伟达、NVIDIA、苹果、Apple、特斯拉、Tesla、ASML、台积电、TSMC 等海外上市主体作为代表公司。",
];

const NON_AH_REPRESENTATIVE_PATTERNS = [
  /美光|Micron/i,
  /英伟达|NVIDIA/i,
  /苹果|Apple/i,
  /特斯拉|Tesla/i,
  /ASML/i,
  /台积电|TSMC/i,
  /微软|Microsoft/i,
  /谷歌|Alphabet|Google/i,
  /亚马逊|Amazon/i,
  /Meta/i,
  /博通|Broadcom/i,
  /AMD/i,
  /英特尔|Intel/i,
  /超微电脑|Supermicro/i,
  /三星|Samsung/i,
  /SK海力士|SK Hynix|Hynix/i,
];

const RADAR_TOPIC_RULES = [
  { label: "平稳现金流/高股息", pattern: /平稳|高股息|分红|现金流|公用事业|电信|水电|运营商|煤炭|高速公路/i },
  { label: "半导体/AI算力", pattern: /半导体|存储|DRAM|NAND|HBM|芯片|算力|AI|服务器|数据中心|光模块|PCB|CPO/i },
  { label: "战略有色金属", pattern: /有色|铜|铝|钨|稀土|金|银|锂|钴|镍|矿/i },
  { label: "锂电储能", pattern: /锂电|电池|储能|碳酸锂|磷酸铁锂|固态电池/i },
  { label: "光伏产业链", pattern: /光伏|硅料|硅片|组件|逆变器|电池片|TOPCon|BC电池/i },
  { label: "生猪养殖", pattern: /猪价|生猪|能繁母猪|养殖|猪肉/i },
  { label: "汽车/智能驾驶", pattern: /汽车|新能源车|乘用车|智能驾驶|出口|车企|销量/i },
  { label: "创新药/医疗服务", pattern: /创新药|医药|医疗|临床|审批|CXO|医保|药监/i },
  { label: "电力电网/能源基础设施", pattern: /电力|电网|发电量|装机|特高压|变压器|储能电站/i },
  { label: "钢铁水泥/地产链", pattern: /钢铁|水泥|地产|房地产|玻璃|建材|开工率/i },
  { label: "航运物流", pattern: /航运|运价|集运|港口|物流|BDI|CCFI|SCFI/i },
  { label: "消费出海", pattern: /消费|品牌出海|跨境|家电|纺织|食品饮料|旅游/i },
  { label: "机器人/AI应用", pattern: /机器人|人形机器人|具身智能|AI应用|大模型/i },
];

type RadarSourcePlanItem =
  | { kind: "google"; tier: RadarEvidenceType; query: string }
  | { kind: "baidu"; tier: RadarEvidenceType; query: string }
  | { kind: "eastmoney"; tier: RadarEvidenceType; query: string; sourceName?: string; sourceType?: RadarEvidenceType }
  | { kind: "boards"; tier: RadarEvidenceType };

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const session = await readSessionCookie(request.headers.get("cookie"), env);
  if (!session) return json({ error: "Unauthorized." }, 401);

  const cached = await readRadarCache(env);
  const job = await readLatestRadarJob(env);
  const freshness = await readRadarEvidenceFreshness(env);
  const radar = cached ? markCached(withRadarFreshness(cached.radar, freshness)) : null;
  return json({
    radar,
    job,
    diagnostics: session.role === "admin" ? radarDiagnostics(cached, job, freshness) : null,
    ...(radar ? {} : { error: radarErrorMessage(null, "read") }),
  }, 200);
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const session = await readSessionCookie(request.headers.get("cookie"), env);
  if (!session) return json({ error: "Unauthorized." }, 401);

  const cached = await readRadarCache(env);
  const freshness = await readRadarEvidenceFreshness(env);
  const activeJob = await readActiveRadarJob(env);
  if (activeJob) {
    return json({
      radar: cached ? markCached(withRadarFreshness(cached.radar, freshness)) : null,
      job: activeJob,
      diagnostics: session.role === "admin" ? radarDiagnostics(cached, activeJob, freshness) : null,
    }, 202);
  }

  const evidenceHash = freshness?.evidenceHash ?? (await readRadarEvidenceHash(env));
  const job = createRadarAnalysisJob(evidenceHash);
  await writeRadarJob(env, job);

  const dispatchTask = dispatchRadarAnalysisWorkflow(env, job.id).catch(async (error) => {
    logRadarFailure(error, "refresh", Boolean(cached));
    await writeRadarJob(env, updateRadarJob(job, "failed", "本次后台分析未能启动，已保留上次扫描。"));
  });
  context.waitUntil(dispatchTask);
  return json({
    radar: cached ? markCached(withRadarFreshness(cached.radar, freshness)) : null,
    job,
    diagnostics: session.role === "admin" ? radarDiagnostics(cached, job, freshness) : null,
  }, 202);
};

export function radarModelRoutes(apiKey: string | undefined): RadarRoute[] {
  const paidKey = apiKey?.trim();
  return paidKey ? [{ model: DEEPSEEK_PAID_MODEL, url: DEEPSEEK_CHAT_COMPLETIONS_URL, apiKey: paidKey, isFree: false }] : [];
}

export function buildRadarRequest(route: RadarRoute, digest: RadarEvidenceDigest, signal: AbortSignal, previousScan?: RadarScan | null): RequestInit {
  const asOfDate = new Date().toISOString().slice(0, 10);
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) },
    signal,
    body: JSON.stringify({
      model: route.model,
      ...(RADAR_MODEL_REASONING[route.model] ? { reasoning_effort: RADAR_MODEL_REASONING[route.model], thinking: { type: "enabled", budget_tokens: 1024 } } : {}),
      response_format: { type: "json_object" },
      stream: false,
      temperature: 0.1,
      max_tokens: 4500,
      messages: [
        {
          role: "system",
          content:
            "你是 CSTD Alpha 的行业雷达分析师。只输出 JSON。必须基于证据包和长期产业逻辑，不要编造具体数据。短时间内不要因为单条新闻改变结论；只有当多源证据或长期基本面支持时才改变行业归类。区分业绩增长、股价泡沫、产业泡沫、周期复苏和长期衰退。证据不足时必须明确写入 limitations。",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: RADAR_PROMPT,
            evidenceRules: [
              "先按公开信息源归纳，再做模型自己的投资分析。",
              "优先使用多源交叉验证，避免只凭单条新闻判断。",
              "硬数据和公告证据优先于新闻与研报观点；新闻只负责发现线索，硬数据负责验证增长。",
              "信息差必须来自价格变化、财报拐点、业绩预告、销量/订单边际变化、产业链利润迁移，而不是新闻复述。",
              "证据里的 signalType 表示第一阶段硬数据信号：commodity_price 商品/价格，financial_metric 财报指标，industry_stat 行业统计，freight_rate 运价。正式结论优先引用这些信号。",
              "如果同一产业方向同时出现主题板块聚合、行业分类覆盖和多条新闻线索，可以形成中低置信观察或正式结论；不要只因为 sourceType 里没有 hard_data 就把所有方向清空。",
              "新浪主题板块聚合用于说明产业方向覆盖，Google News 用于提供价格、库存、财报和产能线索；正式结论仍需写清证据强弱和待验证项。",
              "不要生成全空报告：如果没有高置信正式结论，也必须把证据较强的方向作为低/中置信观察条目放入 sustainability、upcomingGrowth 或 decliningIndustries，并在 thesis、confidence、limitations 里明确待验证。",
              "solidGrowth 只放高或中置信增长；低置信增长线索放入 sustainability 或 upcomingGrowth。decliningIndustries 可放低/中置信衰退观察，但必须说明证据不足和拐点。",
              "本次输入已经是第一阶段证据摘要。你必须在每个行业结论中填写 sourceIds，引用 evidenceDigest.citations 里的 S1/S2 等证据编号。",
              "只把证据强度足够的行业写入正式结论；被扫描但证据不足的方向写入 limitations，不要为了覆盖而强行输出。",
              "coverageReview 必须逐项复核 evidenceDigest.softCoverage：formal 表示进入正式结论，watched 表示已扫描但证据不足或方向分化，insufficient 表示来源太弱。不要把 softCoverage 里的方向写成“未覆盖”。",
              "平稳产业中的杰出经营者优先从平稳现金流、高股息、公用事业、电信运营、能源、消费必需等证据中判断；如果证据不足，写入 coverageReview，不要写“没有覆盖平稳产业”。",
              "汽车、航运、钢铁、水泥等周期方向如果只构成线索，应写为已扫描但未形成强结论，而不是写成未能覆盖。",
              "增长判断至少说明需求扩张、技术突破、价格提升、市占率提升、政策推动中的主要驱动。",
              "每个行业条目必须填写结论强度 conclusionStrength，只能是：正式结论、观察、证据不足。正式结论需要多源或硬证据支持，观察用于线索较强但仍待验证，证据不足用于只可记录缺口的方向。",
              "每个行业条目必须填写证据缺口 evidenceGaps，优先使用：缺财报、缺价格、缺销量、缺订单、缺库存、缺产能、缺现金流、缺政策细则、缺公司公告、缺多源验证；没有明显缺口时输出空数组。",
              "每个行业条目必须填写驱动因素标签 driverTags，只能从需求、价格、技术、政策、市占率、供给收缩中选择，和 drivers 里的文字解释保持一致。",
              "每个行业条目必须填写可持续性分层 sustainabilityTier，只能是短期催化、中期景气、长期护城河；证据无法支撑时选择最保守的一档，并写明 evidenceGaps。",
              "每个行业条目必须填写反证条件 counterEvidenceConditions，写出哪些价格、销量、订单、财报、政策或供给信号出现后应下调或撤销该结论。",
              "泡沫判断必须同时说明原因、当前证据和潜在拐点。",
              "输出应稳定：如果只是短期新闻扰动，不要改变产业阶段判断；若改变归类，必须写明 changeReason。",
              "控制输出冗余：每个正式数组最多 3 条，每条只保留最关键的 2-4 个驱动、证据、拐点，优先引用 sourceIds，不要重复长篇复制证据标题。",
              ...RADAR_COMPANY_UNIVERSE_RULES,
            ],
            evidenceWeights: {
              hard_data: 5,
              official: 4,
              announcement: 4,
              market: 3,
              news: 2,
              research: 1,
            },
            expectedJsonShape: RADAR_JSON_SHAPE,
          }),
        },
        {
          role: "user",
          content: JSON.stringify({
            asOfDate,
            previousScan: previousScan ? summarizePreviousScan(previousScan) : null,
            evidenceDigest: compactRadarEvidenceDigest(digest),
          }),
        },
      ],
    }),
  };
}

export async function generateRadarScan(env: Env, signal: AbortSignal, previousScan: RadarScan | null, preloadedDigest?: RadarEvidenceDigest | null): Promise<RadarScan> {
  const digest = preloadedDigest ?? (await loadRadarEvidenceDigest(env, await loadRadarSources(env, signal)));
  if (digest.sourceCount < MIN_RADAR_SOURCE_COUNT) {
    throw new Error(`雷达证据包过薄：${digest.sourceCount}/${MIN_RADAR_SOURCE_COUNT}`);
  }
  const routes = radarModelRoutes(env.DEEPSEEK_API_KEY);
  if (!routes.length) throw new Error("未配置 DeepSeek API Key，无法生成雷达扫描。");
  let lastError: unknown;
  for (const route of routes) {
    const modelTimeout = timeoutSignal(signal, RADAR_MODEL_TIMEOUT_MS);
    try {
      const response = await fetch(route.url, buildRadarRequest(route, digest, modelTimeout.signal, previousScan));
      const text = await response.text();
      if (!response.ok) {
        lastError = new Error(`雷达扫描失败：${route.model} ${response.status} ${text.slice(0, 400)}`);
        continue;
      }
      return normalizeRadarScan(JSON.parse(jsonrepair(contentFromModelResponse(text))), route.model, digest, previousScan);
    } catch (error) {
      lastError = error;
    } finally {
      modelTimeout.cleanup();
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : "雷达扫描失败。");
}

async function loadRadarSources(env: Env, signal: AbortSignal): Promise<RadarSource[]> {
  const rollingSnapshot = await readRadarEvidenceSnapshot(env);
  if (rollingSnapshot && rollingSnapshot.length >= MIN_RADAR_SOURCE_COUNT) {
    await writeRadarSourceCache(env, rollingSnapshot);
    return rollingSnapshot;
  }

  const cached = await readRadarSourceCache(env);
  if (cached && cached.length >= MIN_RADAR_SOURCE_COUNT) return cached;

  for (const key of LEGACY_RADAR_SOURCE_CACHE_KEYS) {
    const legacy = await readRadarSourceCache(env, key, ["v1"]);
    if (legacy && legacy.length >= MIN_RADAR_SOURCE_COUNT) {
      await writeRadarSourceCache(env, legacy);
      return legacy;
    }
  }

  const sources = await fetchRadarSources(signal);
  if (sources.length >= MIN_RADAR_SOURCE_COUNT) await writeRadarSourceCache(env, sources);
  if (sources.length >= (cached?.length ?? 0)) return sources;
  if (cached) return cached;
  return sources;
}

export async function loadRollingRadarEvidenceDigest(env: Env): Promise<RadarEvidenceDigest | null> {
  const sources = await readRadarEvidenceSnapshot(env);
  if (!sources || sources.length < MIN_RADAR_SOURCE_COUNT) return null;
  return loadRadarEvidenceDigest(env, sources);
}

async function loadRadarEvidenceDigest(env: Env, sources: RadarSource[]): Promise<RadarEvidenceDigest> {
  const fingerprint = radarSourceFingerprint(sources);
  const cached = await readRadarDigestCache(env, fingerprint);
  if (cached) return cached;

  const digest = buildRadarEvidenceDigest(sources);
  await writeRadarDigestCache(env, digest);
  return digest;
}

async function fetchRadarSources(signal: AbortSignal): Promise<RadarSource[]> {
  const results = await Promise.allSettled(createRadarSourcePlan().map((item) => fetchRadarSourcePlanItem(item, signal)));
  const items = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const deduped = dedupeSources(items);
  return deduped.sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0)).slice(0, 96);
}

export function buildRadarEvidenceDigest(sources: ReadonlyArray<RadarSource>): RadarEvidenceDigest {
  const scoredSources = dedupeSources(sources.map(classifyRadarSource))
    .map((source) => {
      const sourceType = source.sourceType ?? "news";
      const weight = source.weight ?? evidenceWeight(sourceType);
      return {
        ...source,
        sourceType,
        weight,
        score: radarSourceScore({ ...source, sourceType, weight }),
      };
    })
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const citations = selectRadarCitationSources(scoredSources, RADAR_DIGEST_CITATION_LIMIT)
    .map((source, index): RadarCitation => ({ ...source, id: `S${index + 1}` }));

  const groups = new Map<string, RadarCitation[]>();
  for (const citation of citations) {
    const topic = inferRadarTopic(citation);
    groups.set(topic, [...(groups.get(topic) ?? []), citation]);
  }

  const packets = [...groups.entries()]
    .map(([topic, group]): RadarEvidencePacket => {
      const sorted = [...group].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
      const evidenceTypes = uniqueEvidenceTypes(sorted.map((source) => source.sourceType));
      const signalTypes = uniqueStrings(sorted.map((source) => source.signalType));
      const sourceIds = sorted.slice(0, 5).map((source) => source.id);
      const signals = sorted.slice(0, 6).map((source) => `${source.id}${source.signalType ? ` [${source.signalType}]` : ""} ${source.title}${source.summary ? `：${source.summary}` : ""}`);
      return {
        topic,
        score: sorted.reduce((sum, source) => sum + (source.score ?? 0), 0),
        sourceIds,
        evidenceTypes,
        signalTypes,
        summary: `${topic}共 ${group.length} 条公开来源，主要证据类型：${evidenceTypes.map(radarEvidenceTypeName).join("、") || "新闻线索"}${signalTypes.length ? `，硬数据信号：${signalTypes.join("、")}` : ""}。`,
        signals,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);

  return {
    sourceFingerprint: radarSourceFingerprint(citations),
    sourceCount: citations.length,
    evidenceBreakdown: summarizeEvidenceBreakdown(citations),
    citations,
    packets,
    softCoverage: packets.slice(0, 10).map((packet): RadarCoverageItem => ({
      label: packet.topic,
      sourceCount: packet.sourceIds.length,
      evidenceTypes: packet.evidenceTypes,
      note: `${packet.topic}已有可核验证据，但是否进入正式结论由模型按证据强度决定。`,
      topSourceIds: packet.sourceIds,
    })),
  };
}

function compactRadarEvidenceDigest(digest: RadarEvidenceDigest) {
  const packets = digest.packets.slice(0, 8).map((packet) => ({
    topic: packet.topic,
    score: Math.round(packet.score),
    sourceIds: packet.sourceIds.slice(0, 3),
    evidenceTypes: packet.evidenceTypes,
    signalTypes: packet.signalTypes,
    summary: packet.summary,
    signals: packet.signals.slice(0, 2).map((signal) => trimText(signal, 120)),
  }));
  const citationIds = new Set(packets.flatMap((packet) => packet.sourceIds));
  const citationSources = [
    ...digest.citations.filter((source) => citationIds.has(source.id)),
    ...digest.citations.filter((source) => !citationIds.has(source.id)),
  ].slice(0, 24);

  return {
    sourceFingerprint: digest.sourceFingerprint,
    sourceCount: digest.sourceCount,
    evidenceBreakdown: digest.evidenceBreakdown,
    softCoverage: digest.softCoverage.slice(0, 8).map((item) => ({ ...item, topSourceIds: item.topSourceIds?.slice(0, 3) ?? [] })),
    packets,
    citations: citationSources.map((source) => ({
      id: source.id,
      source: source.source,
      sourceType: source.sourceType,
      title: trimText(source.title, 90),
      url: source.url,
      publishedAt: source.publishedAt,
      query: source.query,
      signalType: source.signalType,
      summary: source.summary ? trimText(source.summary, 100) : undefined,
    })),
  };
}

function selectRadarCitationSources(sources: ScoredRadarSource[], limit: number): ScoredRadarSource[] {
  const selected: ScoredRadarSource[] = [];
  const seen = new Set<string>();
  const newsSources = sources.filter((source) => source.sourceType === "news");
  const nonNewsSources = sources.filter((source) => source.sourceType !== "news");
  const reservedNews = nonNewsSources.length >= MIN_RADAR_SOURCE_COUNT ? Math.min(newsSources.length, RADAR_DIGEST_NEWS_FLOOR, Math.floor(limit * RADAR_DIGEST_MAX_NEWS_SHARE)) : 0;
  const nonNewsLimit = limit - reservedNews;
  const maxPerSource = Math.max(1, Math.floor(limit * RADAR_DIGEST_MAX_SINGLE_SOURCE_SHARE));
  const minimumByType: Partial<Record<RadarEvidenceType, number>> = {
    hard_data: 24,
    announcement: 12,
    official: 18,
    market: 24,
    research: 4,
  };

  for (const [sourceType, minimum] of Object.entries(minimumByType) as Array<[RadarEvidenceType, number]>) {
    for (const source of nonNewsSources.filter((item) => item.sourceType === sourceType).slice(0, minimum)) {
      addRadarCitationSource(source, selected, seen, nonNewsLimit, maxPerSource);
    }
  }
  for (const source of nonNewsSources) {
    addRadarCitationSource(source, selected, seen, nonNewsLimit, maxPerSource);
  }
  for (const source of newsSources) {
    addRadarCitationSource(source, selected, seen, limit, maxPerSource, reservedNews);
  }
  for (const source of sources) {
    addRadarCitationSource(source, selected, seen, limit, maxPerSource);
  }
  return selected.slice(0, limit);
}

function addRadarCitationSource(source: ScoredRadarSource, selected: ScoredRadarSource[], seen: Set<string>, limit: number, maxPerSource: number, maxNews?: number) {
  if (selected.length >= limit) return;
  const key = source.url || `${source.source}|${source.title}`;
  if (!key || seen.has(key)) return;
  if (maxNews !== undefined && source.sourceType === "news" && selected.filter((item) => item.sourceType === "news").length >= maxNews) return;
  if (selected.filter((item) => item.source === source.source).length >= maxPerSource) return;
  seen.add(key);
  selected.push(source);
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
    ...RADAR_RESEARCH_QUERIES.map<RadarSourcePlanItem>((query) => ({ kind: "eastmoney", tier: "research", query, sourceName: "研报摘要", sourceType: "research" })),
    ...RADAR_STABLE_INDUSTRY_QUERIES.flatMap<RadarSourcePlanItem>((query) => [
      { kind: "eastmoney", tier: "hard_data", query, sourceName: "平稳产业数据", sourceType: "hard_data" },
      { kind: "google", tier: "hard_data", query },
    ]),
    ...RADAR_QUERIES.slice(0, 6).flatMap<RadarSourcePlanItem>((query) => [
      { kind: "google", tier: "news", query },
      { kind: "baidu", tier: "news", query },
      { kind: "eastmoney", tier: "news", query },
    ]),
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

function normalizeRadarScan(value: unknown, model: string, digest: RadarEvidenceDigest, previousScan: RadarScan | null): RadarScan {
  const record = isRecord(value) ? value : {};
  const now = new Date();
  const generatedAt = now.toISOString();
  const validUntil = new Date(now.getTime() + RADAR_VALID_HOURS * 60 * 60 * 1000).toISOString();
  const previousTitles = previousRadarTitles(previousScan);
  const solidGrowth = radarItems(record.solidGrowth, previousTitles, digest);
  const sustainability = radarItems(record.sustainability, previousTitles, digest);
  const bubbleRisks = radarItems(record.bubbleRisks, previousTitles, digest);
  const upcomingGrowth = radarItems(record.upcomingGrowth, previousTitles, digest);
  const decliningIndustries = radarItems(record.decliningIndustries, previousTitles, digest);
  const formalItems = [...solidGrowth, ...sustainability, ...bubbleRisks, ...upcomingGrowth, ...decliningIndustries];
  const coverageReview = radarCoverageReview(record.coverageReview, digest, formalItems);
  const scan: RadarScan = {
    id: stringValue(record.id) || `radar-${generatedAt}`,
    title: stringValue(record.title) || "行业雷达扫描",
    generatedAt,
    asOfDate: stringValue(record.asOfDate) || generatedAt.slice(0, 10),
    validUntil,
    model,
    sourceCount: digest.sourceCount,
    sourceQueries: allRadarQueries(),
    evidenceBreakdown: digest.evidenceBreakdown,
    evidenceSources: digest.citations,
    softCoverage: digest.softCoverage,
    coverageReview,
    confidenceSummary:
      stringValue(record.confidenceSummary) ||
      "置信度按硬数据、公告、市场数据、新闻和研报的交叉验证强弱生成；硬数据和公告权重最高。",
    fromCache: false,
    executiveSummary: stringArray(record.executiveSummary).slice(0, 8),
    solidGrowth,
    sustainability,
    bubbleRisks,
    upcomingGrowth,
    decliningIndustries,
    representativeCompanies: radarLists(record.representativeCompanies, coverageReview),
    stageCompanies: radarLists(record.stageCompanies, coverageReview),
    limitations: sanitizeCoverageLanguageList(record.limitations, coverageReview).slice(0, 8),
  };
  return {
    ...scan,
    changeLog: stringArray(record.changeLog).slice(0, 8).length ? stringArray(record.changeLog).slice(0, 8) : buildChangeLog(previousScan, scan),
  };
}

function createRadarAnalysisJob(evidenceHash?: string): RadarAnalysisJob {
  const now = new Date().toISOString();
  return {
    id: `radar-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    evidenceHash,
    message: "后台分析已排队，页面会继续显示上次稳定结果。",
  };
}

function updateRadarJob(job: RadarAnalysisJob, status: RadarAnalysisJobStatus, message?: string): RadarAnalysisJob {
  return {
    ...job,
    status,
    updatedAt: new Date().toISOString(),
    ...(message ? { message } : {}),
  };
}

async function readLatestRadarJob(env: Env): Promise<RadarAnalysisJob | null> {
  const value = await env.REPORT_CACHE?.get<RadarAnalysisJob>(RADAR_ANALYSIS_JOB_LATEST_KEY, "json").catch(() => null);
  return normalizeRadarJob(value);
}

async function readActiveRadarJob(env: Env): Promise<RadarAnalysisJob | null> {
  const job = await readLatestRadarJob(env);
  if (!job || (job.status !== "queued" && job.status !== "running")) return null;
  const updatedAt = Date.parse(job.updatedAt);
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt > 20 * 60 * 1000) return null;
  return job;
}

async function writeRadarJob(env: Env, job: RadarAnalysisJob) {
  const payload = JSON.stringify(job);
  await Promise.all([
    env.REPORT_CACHE?.put(`${RADAR_ANALYSIS_JOB_PREFIX}${job.id}`, payload, { expirationTtl: 24 * 60 * 60 }),
    env.REPORT_CACHE?.put(RADAR_ANALYSIS_JOB_LATEST_KEY, payload, { expirationTtl: 24 * 60 * 60 }),
  ]);
}

function normalizeRadarJob(value: unknown): RadarAnalysisJob | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const status = stringValue(value.status) as RadarAnalysisJobStatus;
  const createdAt = stringValue(value.createdAt);
  const updatedAt = stringValue(value.updatedAt);
  if (!id || !["queued", "running", "completed", "failed"].includes(status) || !createdAt || !updatedAt) return null;
  return {
    id,
    status,
    createdAt,
    updatedAt,
    evidenceHash: stringValue(value.evidenceHash) || undefined,
    message: stringValue(value.message) || undefined,
    radarGeneratedAt: stringValue(value.radarGeneratedAt) || undefined,
  };
}

async function readRadarEvidenceHash(env: Env): Promise<string | undefined> {
  const value = await env.REPORT_CACHE?.get<RadarEvidenceSnapshotPayload>(RADAR_EVIDENCE_SNAPSHOT_KEY, "json").catch(() => null);
  return stringValue(value?.evidenceHash) || undefined;
}

async function readRadarEvidenceFreshness(env: Env): Promise<RadarEvidenceFreshness | null> {
  const value = await env.REPORT_CACHE?.get<RadarEvidenceSnapshotPayload>(RADAR_EVIDENCE_SNAPSHOT_KEY, "json").catch(() => null);
  if (!value || value.version !== RADAR_EVIDENCE_SNAPSHOT_VERSION) return null;
  const generatedAt = stringValue(value.generatedAt) || undefined;
  const ageHours = generatedAt ? Math.max(0, Math.round(((Date.now() - Date.parse(generatedAt)) / 3_600_000) * 10) / 10) : undefined;
  return {
    generatedAt,
    asOfDate: stringValue(value.asOfDate) || undefined,
    ageHours,
    stale: typeof ageHours === "number" ? ageHours > 30 : true,
    sourceCount: Array.isArray(value.sources) ? value.sources.length : undefined,
    evidenceHash: stringValue(value.evidenceHash) || undefined,
  };
}

async function dispatchRadarAnalysisWorkflow(env: Env, jobId: string) {
  const token = env.GITHUB_RADAR_DISPATCH_TOKEN?.trim();
  if (!token) throw new Error("missing GitHub radar dispatch token");
  const repository = env.GITHUB_RADAR_REPOSITORY?.trim() || GITHUB_RADAR_REPOSITORY;
  const workflow = env.GITHUB_RADAR_WORKFLOW?.trim() || GITHUB_RADAR_WORKFLOW;
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "CSTDAlphaRadar/1.0",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: { job_id: jobId },
    }),
  });
  if (!response.ok) throw new Error(`GitHub radar dispatch failed: ${response.status}`);
}

async function readRadarCache(env: Env): Promise<RadarCachePayload | null> {
  const value = await env.REPORT_CACHE?.get<RadarCachePayload>(RADAR_CACHE_KEY, "json").catch(() => null);
  if (value?.version === RADAR_CACHE_VERSION && value.radar) return value;
  for (const key of LEGACY_RADAR_CACHE_KEYS) {
    const legacy = await env.REPORT_CACHE?.get<{ cachedAt?: string; radar?: RadarScan }>(key, "json").catch(() => null);
    if (legacy?.radar) {
      return { version: RADAR_CACHE_VERSION, cachedAt: legacy.cachedAt || new Date().toISOString(), radar: legacy.radar };
    }
  }
  return null;
}

export async function writeRadarCache(env: Env, radar: RadarScan) {
  const payload: RadarCachePayload = { version: RADAR_CACHE_VERSION, cachedAt: new Date().toISOString(), radar };
  await env.REPORT_CACHE?.put(RADAR_CACHE_KEY, JSON.stringify(payload));
}

async function readRadarSourceCache(env: Env, key = RADAR_SOURCE_CACHE_KEY, acceptedVersions = [RADAR_SOURCE_CACHE_VERSION]): Promise<RadarSource[] | null> {
  const value = await env.REPORT_CACHE?.get<RadarSourceCachePayload>(key, "json").catch(() => null);
  if (!value || !acceptedVersions.includes(value.version) || !Array.isArray(value.sources)) return null;
  if (Date.parse(value.expiresAt) <= Date.now()) return null;
  return value.sources;
}

async function writeRadarSourceCache(env: Env, sources: RadarSource[]) {
  if (!sources.length) return;
  const payload: RadarSourceCachePayload = {
    version: RADAR_SOURCE_CACHE_VERSION,
    cachedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + RADAR_SOURCE_CACHE_HOURS * 60 * 60 * 1000).toISOString(),
    sources,
  };
  await env.REPORT_CACHE?.put(RADAR_SOURCE_CACHE_KEY, JSON.stringify(payload), { expirationTtl: RADAR_SOURCE_CACHE_HOURS * 60 * 60 });
}

async function readRadarDigestCache(env: Env, sourceFingerprint: string): Promise<RadarEvidenceDigest | null> {
  const value = await env.REPORT_CACHE?.get<RadarDigestCachePayload>(RADAR_DIGEST_CACHE_KEY, "json").catch(() => null);
  if (!value || value.version !== RADAR_DIGEST_CACHE_VERSION || value.sourceFingerprint !== sourceFingerprint || !value.digest) return null;
  return value.digest;
}

async function writeRadarDigestCache(env: Env, digest: RadarEvidenceDigest) {
  if (!digest.sourceCount) return;
  const payload: RadarDigestCachePayload = {
    version: RADAR_DIGEST_CACHE_VERSION,
    cachedAt: new Date().toISOString(),
    sourceFingerprint: digest.sourceFingerprint,
    digest,
  };
  await env.REPORT_CACHE?.put(RADAR_DIGEST_CACHE_KEY, JSON.stringify(payload), { expirationTtl: RADAR_SOURCE_CACHE_HOURS * 60 * 60 });
}

async function readRadarEvidenceSnapshot(env: Env): Promise<RadarSource[] | null> {
  const value = await env.REPORT_CACHE?.get<RadarEvidenceSnapshotPayload>(RADAR_EVIDENCE_SNAPSHOT_KEY, "json").catch(() => null);
  if (!value || value.version !== RADAR_EVIDENCE_SNAPSHOT_VERSION || !Array.isArray(value.sources)) return null;
  const sources = dedupeSources(value.sources.map(radarSourceFromSnapshot).filter((source): source is RadarSource => Boolean(source)));
  if (sources.length < MIN_RADAR_SOURCE_COUNT) return null;
  return sources.sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0)).slice(0, 128);
}

function withRadarFreshness(radar: RadarScan, freshness: RadarEvidenceFreshness | null): RadarScan {
  return freshness ? { ...radar, evidenceFreshness: freshness } : radar;
}

function radarDiagnostics(cache: RadarCachePayload | null, job: RadarAnalysisJob | null, freshness: RadarEvidenceFreshness | null): RadarDiagnostics {
  return {
    jobStatus: job?.status,
    jobMessage: sanitizeDiagnostic(job?.message),
    evidenceGeneratedAt: freshness?.generatedAt,
    evidenceHash: freshness?.evidenceHash,
    evidenceAgeHours: freshness?.ageHours,
    latestRadarGeneratedAt: cache?.radar.generatedAt,
    sourceCount: freshness?.sourceCount ?? cache?.radar.sourceCount,
    cacheVersion: cache?.version,
    tokenUsage: job?.tokenUsage,
  };
}

function sanitizeDiagnostic(value: string | undefined) {
  if (!value) return undefined;
  return value.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]").replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]");
}

function markCached(radar: RadarScan, reuseReason?: string, refreshWarning?: string): RadarScan {
  return { ...radar, fromCache: true, ...(reuseReason ? { reuseReason } : {}), ...(refreshWarning ? { refreshWarning } : {}) };
}

export function cachedRadarMatchesDigest(radar: RadarScan, digest: RadarEvidenceDigest) {
  if (!radar.evidenceSources?.length) return false;
  return radar.sourceCount === digest.sourceCount && radarSourceFingerprint(radar.evidenceSources) === digest.sourceFingerprint;
}

function contentFromModelResponse(text: string) {
  const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new Error("雷达扫描模型未返回内容。");
  return content;
}

function radarItems(value: unknown, previousTitles = new Set<string>(), digest?: RadarEvidenceDigest): RadarItem[] {
  return arrayValue(value).map((item) => {
    const record = isRecord(item) ? item : {};
    const title = stringValue(record.title);
    const confidence = enumValue<NonNullable<RadarItem["confidence"]>>(record.confidence, ["低", "中", "高"], "中");
    const sourceIds = radarItemSourceIds(record, digest);
    const drivers = stringArray(record.drivers).slice(0, 8);
    const evidence = stringArray(record.evidence).slice(0, 8);
    const durability = enumValue(record.durability, ["短期", "中期", "长期", "不确定"], "不确定");
    const itemEvidenceTypes = evidenceTypes(record.evidenceTypes);
    const turningPoints = stringArray(record.turningPoints).slice(0, 6);
    return {
      title,
      industries: stringArray(record.industries).slice(0, 6),
      companies: ahRepresentativeCompanies(record.companies).slice(0, 8),
      thesis: stringValue(record.thesis),
      drivers,
      evidence,
      conclusionStrength: conclusionStrengthValue(record.conclusionStrength, confidence),
      evidenceGaps: evidenceGapValues(record.evidenceGaps),
      driverTags: driverTagValues(record.driverTags, [title, stringValue(record.thesis), drivers.join(" "), evidence.join(" ")]),
      sustainabilityTier: sustainabilityTierValue(record.sustainabilityTier, durability),
      durability,
      riskLevel: enumValue(record.riskLevel, ["低", "中", "高"], "中"),
      confidence,
      evidenceTypes: itemEvidenceTypes,
      supportingSourceCount: numberValue(record.supportingSourceCount) ?? (sourceIds.length || undefined),
      sourceIds,
      changeReason:
        stringValue(record.changeReason) ||
        (title && previousTitles.has(title) ? "延续上次稳定判断，本次证据未形成足够反转。" : "本次扫描基于新增公开证据或硬数据重新归类。"),
      counterEvidenceConditions: counterEvidenceConditions(record.counterEvidenceConditions, turningPoints),
      turningPoints,
    };
  });
}

function conclusionStrengthValue(value: unknown, confidence: NonNullable<RadarItem["confidence"]>) {
  return enumValue<RadarConclusionStrength>(value, RADAR_CONCLUSION_STRENGTHS, defaultConclusionStrength(confidence));
}

function defaultConclusionStrength(confidence: NonNullable<RadarItem["confidence"]>): RadarConclusionStrength {
  if (confidence === "高") return "正式结论";
  if (confidence === "低") return "证据不足";
  return "观察";
}

function evidenceGapValues(value: unknown) {
  return enumArrayValue<RadarEvidenceGap>(value, RADAR_EVIDENCE_GAPS).slice(0, 8);
}

function driverTagValues(value: unknown, fallbackTextParts: string[]) {
  const explicit = enumArrayValue<RadarDriverTag>(value, RADAR_DRIVER_TAGS).slice(0, 6);
  if (explicit.length) return explicit;
  const fallbackText = fallbackTextParts.join(" ");
  return RADAR_DRIVER_TAGS.filter((tag) => driverTagPattern(tag).test(fallbackText)).slice(0, 6);
}

function driverTagPattern(tag: RadarDriverTag) {
  return {
    需求: /需求|订单|销量|消费|出口|装机|发电量|客流|用电/i,
    价格: /价格|涨价|提价|毛利率|价差|运价|猪价|铜价|锂价|硅料/i,
    技术: /技术|创新|AI|算力|芯片|工艺|临床|审批|突破|升级/i,
    政策: /政策|补贴|监管|医保|药监|发改委|工信部|财政|关税/i,
    市占率: /市占率|份额|渗透率|国产替代|集中度|龙头/i,
    供给收缩: /供给收缩|限产|去产能|库存下降|产能出清|供给约束|开工率下降/i,
  }[tag];
}

function sustainabilityTierValue(value: unknown, durability: RadarItem["durability"]) {
  const fallback = {
    短期: "短期催化",
    中期: "中期景气",
    长期: "长期护城河",
    不确定: "短期催化",
  }[durability] as RadarSustainabilityTier;
  return enumValue<RadarSustainabilityTier>(value, RADAR_SUSTAINABILITY_TIERS, fallback);
}

function counterEvidenceConditions(value: unknown, turningPoints: string[]) {
  const explicit = stringArray(value).slice(0, 6);
  return explicit.length ? explicit : turningPoints.slice(0, 3);
}

function radarLists(value: unknown, coverageReview: RadarCoverageReview[] = []): RadarList[] {
  return arrayValue(value).map((item) => {
    const record = isRecord(item) ? item : {};
    return {
      label: stringValue(record.label),
      companies: ahRepresentativeCompanies(record.companies).slice(0, 12),
      note: sanitizeCoverageLanguage(stringValue(record.note), coverageReview),
    };
  });
}

function radarCoverageReview(value: unknown, digest: RadarEvidenceDigest, formalItems: RadarItem[]): RadarCoverageReview[] {
  const derived = deriveCoverageReview(digest, formalItems);
  const byLabel = new Map(derived.map((item) => [item.label, item]));
  for (const item of arrayValue(value)) {
    const record = isRecord(item) ? item : {};
    const label = stringValue(record.label);
    if (!label) continue;
    const fallback = byLabel.get(label);
    byLabel.set(label, {
      label,
      status: enumValue<RadarCoverageStatus>(record.status, ["formal", "watched", "insufficient"], fallback?.status ?? "watched"),
      sourceCount: numberValue(record.sourceCount) ?? fallback?.sourceCount ?? 0,
      evidenceTypes: evidenceTypes(record.evidenceTypes).length ? evidenceTypes(record.evidenceTypes) : fallback?.evidenceTypes ?? [],
      note: sanitizeCoverageLanguage(stringValue(record.note) || fallback?.note || "已扫描该方向，证据强度决定是否进入正式结论。", derived),
      sourceIds: coverageSourceIds(record.sourceIds, digest).length ? coverageSourceIds(record.sourceIds, digest) : fallback?.sourceIds,
    });
  }
  return [...byLabel.values()].slice(0, 16);
}

function deriveCoverageReview(digest: RadarEvidenceDigest, formalItems: RadarItem[]): RadarCoverageReview[] {
  const formalText = formalItems
    .flatMap((item) => [item.title, ...item.industries, ...item.companies])
    .join(" ");
  return digest.softCoverage.map((item) => {
    const status = coverageStatus(item, formalText);
    return {
      label: item.label,
      status,
      sourceCount: item.sourceCount,
      evidenceTypes: item.evidenceTypes,
      sourceIds: item.topSourceIds,
      note:
        status === "formal"
          ? "已进入正式雷达结论。"
          : status === "watched"
            ? "已扫描到公开证据，但方向分化或证据强度不足，暂未升为正式结论。"
            : "已扫描该方向，但来源数量或硬数据不足，继续等待验证。",
    };
  });
}

function coverageStatus(item: RadarCoverageItem, formalText: string): RadarCoverageStatus {
  if (keywordOverlapScore(item.label, formalText) > 0) return "formal";
  const hasHardEvidence = item.evidenceTypes.some((type) => ["hard_data", "official", "announcement", "market"].includes(type));
  if (item.sourceCount >= 1 && hasHardEvidence) return "watched";
  return "insufficient";
}

function coverageSourceIds(value: unknown, digest: RadarEvidenceDigest) {
  const validIds = new Set(digest.citations.map((source) => source.id));
  return stringArray(value).filter((id) => validIds.has(id)).slice(0, 5);
}

function sanitizeCoverageLanguageList(value: unknown, coverageReview: RadarCoverageReview[]) {
  return stringArray(value).map((item) => sanitizeCoverageLanguage(item, coverageReview)).filter(Boolean);
}

function sanitizeCoverageLanguage(value: string, coverageReview: RadarCoverageReview[]) {
  if (!value) return "";
  const coveredText = coverageReview.map((item) => item.label).join(" ");
  const shouldRewrite =
    /(未能覆盖|没有覆盖|未覆盖|无法推荐)/.test(value) &&
    (/(汽车|航运|钢铁|水泥|平稳|高股息|现金流|公用事业|电信)/.test(value) || keywordOverlapScore(value, coveredText) > 0);
  if (!shouldRewrite) return value;
  return value
    .replace(/未能覆盖/g, "已扫描但未形成强结论")
    .replace(/没有覆盖/g, "已扫描但证据不足")
    .replace(/未覆盖/g, "已扫描但证据不足")
    .replace(/无法推荐/g, "暂不列入正式推荐");
}

function radarItemSourceIds(record: Record<string, unknown>, digest?: RadarEvidenceDigest) {
  if (!digest?.citations.length) return stringArray(record.sourceIds).slice(0, 5);
  const validIds = new Set(digest.citations.map((source) => source.id));
  const explicit = stringArray(record.sourceIds).filter((id) => validIds.has(id)).slice(0, 5);
  if (explicit.length) return explicit;

  const itemText = [record.title, record.thesis, ...stringArray(record.industries), ...stringArray(record.evidence), ...stringArray(record.drivers)]
    .map((value) => stringValue(value))
    .join(" ");
  const inferred = digest.citations
    .map((source) => ({
      id: source.id,
      score: keywordOverlapScore(itemText, `${source.title} ${source.summary ?? ""} ${source.query}`) + (source.weight ?? 0),
    }))
    .filter((source) => source.score > 1)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map((source) => source.id);
  return inferred.length ? inferred : digest.citations.slice(0, 2).map((source) => source.id);
}

function ahRepresentativeCompanies(value: unknown) {
  return stringArray(value).filter((company) => !isNonAhRepresentative(company));
}

function isNonAhRepresentative(company: string) {
  return NON_AH_REPRESENTATIVE_PATTERNS.some((pattern) => pattern.test(company));
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

function radarSourceFromSnapshot(value: unknown): RadarSource | null {
  if (!isRecord(value)) return null;
  const source = stringValue(value.source);
  const query = stringValue(value.query);
  const title = stringValue(value.title);
  if (!source || !query || !title) return null;
  return classifyRadarSource({
    source,
    query,
    title,
    url: stringValue(value.url),
    publishedAt: stringValue(value.publishedAt) || undefined,
    summary: stringValue(value.summary) || undefined,
    sourceType: evidenceTypeValue(value.sourceType),
    signalType: stringValue(value.signalType) || undefined,
    weight: numberValue(value.weight),
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

function radarEvidenceTypeName(sourceType: RadarEvidenceType) {
  return {
    hard_data: "硬数据",
    official: "官方/协会",
    announcement: "公告/财报",
    market: "市场数据",
    news: "新闻线索",
    research: "研报摘要",
  }[sourceType];
}

function uniqueEvidenceTypes(values: RadarEvidenceType[]) {
  return [...new Set(values)].sort((left, right) => evidenceWeight(right) - evidenceWeight(left)).slice(0, 6);
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].slice(0, 8);
}

function radarSourceScore(source: Pick<RadarCitation, "source" | "query" | "title" | "summary" | "sourceType" | "weight" | "publishedAt">) {
  const text = `${source.source} ${source.query} ${source.title} ${source.summary ?? ""}`;
  const recency = source.publishedAt ? sourceRecencyScore(source.publishedAt) : 0;
  const dataSignal = /(价格|库存|产能|订单|营收|净利润|毛利率|现金流|销量|装机|开工率|预增|亏损|同比|环比)/i.test(text) ? 8 : 0;
  const riskSignal = /(泡沫|过剩|停牌|异动|亏损|下滑|衰退|减值|库存高企)/i.test(text) ? 4 : 0;
  return source.weight * 10 + recency + dataSignal + riskSignal;
}

function sourceRecencyScore(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 0;
  const days = (Date.now() - time) / 86_400_000;
  if (days <= 30) return 8;
  if (days <= 90) return 5;
  if (days <= 180) return 3;
  return 1;
}

function inferRadarTopic(source: RadarSource) {
  const text = `${source.query} ${source.title} ${source.summary ?? ""}`;
  const matched = RADAR_TOPIC_RULES.find((rule) => rule.pattern.test(text));
  if (matched) return matched.label;
  const query = plainNewsQuery(source.query);
  return query.split(/\s+/).slice(0, 3).join("/") || "其他待验证方向";
}

export function radarSourceFingerprint(sources: ReadonlyArray<RadarSource>) {
  const text = sources
    .map((source) => `${source.url || source.title}|${source.title}|${source.source}|${source.query}|${source.publishedAt ?? ""}`)
    .sort()
    .join("\n");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function keywordOverlapScore(left: string, right: string) {
  const rightText = right.toLocaleLowerCase();
  return keywordTokens(left).reduce((score, token) => score + (rightText.includes(token.toLocaleLowerCase()) ? 1 : 0), 0);
}

function keywordTokens(text: string) {
  const tokens = text
    .split(/[\s,，、。；;:：()（）[\]【】"'“”]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const topicLabels = RADAR_TOPIC_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label.split("/")[0]);
  return [...new Set([...tokens, ...topicLabels])];
}

function allRadarQueries() {
  return [...RADAR_QUERIES, ...RADAR_HARD_DATA_QUERIES, ...RADAR_ANNOUNCEMENT_QUERIES, ...RADAR_RESEARCH_QUERIES, ...RADAR_STABLE_INDUSTRY_QUERIES];
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

function radarErrorMessage(_error: unknown, mode: "read" | "refresh") {
  return mode === "refresh" ? "本次刷新失败，已保留上次扫描。请稍后重试。" : "雷达扫描暂时不可用，请稍后重试。";
}

function logRadarFailure(error: unknown, mode: "read" | "refresh", hasCache: boolean) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn("radar_scan_failed", {
    mode,
    hasCache,
    message: message.slice(0, 500),
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

function trimText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
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

function evidenceTypeValue(value: unknown): RadarEvidenceType | undefined {
  return evidenceTypes([value])[0];
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

function enumArrayValue<T extends string>(value: unknown, values: readonly T[]): T[] {
  const allowed = new Set<string>(values);
  const seen = new Set<string>();
  return stringArray(value).filter((item): item is T => {
    if (!allowed.has(item) || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
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

const RADAR_ITEM_JSON_FIELDS = {
  conclusionStrength: "正式结论 | 观察 | 证据不足",
  evidenceGaps: ["缺财报", "缺价格", "缺销量"],
  driverTags: ["需求", "价格", "技术"],
  sustainabilityTier: "短期催化 | 中期景气 | 长期护城河",
  counterEvidenceConditions: ["反证条件"],
};

const RADAR_JSON_SHAPE = {
  title: "行业雷达扫描",
  asOfDate: "YYYY-MM-DD",
  confidenceSummary: "说明本轮结论的总体置信度和主要证据类型",
  changeLog: ["相比上次扫描保留、新增、降级或删除了哪些判断，以及原因"],
  executiveSummary: ["3-8 条核心结论"],
  coverageReview: [
    {
      label: "软覆盖方向",
      status: "formal | watched | insufficient",
      sourceCount: 5,
      evidenceTypes: ["hard_data"],
      sourceIds: ["S1", "S2"],
      note: "已扫描后是否形成正式结论及原因",
    },
  ],
  solidGrowth: [
    {
      title: "细分产业",
      industries: ["行业"],
      companies: ["公司"],
      thesis: "分析",
      drivers: ["驱动"],
      evidence: ["证据"],
      ...RADAR_ITEM_JSON_FIELDS,
      sourceIds: ["S1", "S2"],
      evidenceTypes: ["hard_data", "announcement"],
      supportingSourceCount: 5,
      confidence: "高",
      durability: "长期",
      riskLevel: "中",
      changeReason: "为什么延续或改变判断",
      turningPoints: ["拐点"],
    },
  ],
  sustainability: [{ title: "增长类型", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["驱动"], evidence: ["证据"], ...RADAR_ITEM_JSON_FIELDS, sourceIds: ["S1"], evidenceTypes: ["hard_data"], supportingSourceCount: 3, confidence: "中", durability: "长期", riskLevel: "中", changeReason: "变化原因", turningPoints: ["拐点"] }],
  bubbleRisks: [{ title: "泡沫类型", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["成因"], evidence: ["证据"], ...RADAR_ITEM_JSON_FIELDS, sourceIds: ["S1"], evidenceTypes: ["market"], supportingSourceCount: 3, confidence: "中", durability: "短期", riskLevel: "高", changeReason: "变化原因", turningPoints: ["拐点"] }],
  upcomingGrowth: [{ title: "即将增长", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["信号"], evidence: ["证据"], ...RADAR_ITEM_JSON_FIELDS, sourceIds: ["S1"], evidenceTypes: ["announcement"], supportingSourceCount: 2, confidence: "中", durability: "中期", riskLevel: "中", changeReason: "变化原因", turningPoints: ["拐点"] }],
  decliningIndustries: [{ title: "衰退产业", industries: ["行业"], companies: ["公司"], thesis: "分析", drivers: ["衰退原因"], evidence: ["证据"], ...RADAR_ITEM_JSON_FIELDS, sourceIds: ["S1"], evidenceTypes: ["hard_data"], supportingSourceCount: 4, confidence: "高", durability: "长期", riskLevel: "高", changeReason: "变化原因", turningPoints: ["拐点"] }],
  representativeCompanies: [{ label: "扎实增长产业中的代表公司", companies: ["公司"], note: "说明" }],
  stageCompanies: [{ label: "上升产业中的领军人物", companies: ["公司"], note: "说明" }],
  limitations: ["信息不足或需后续验证的地方"],
};
