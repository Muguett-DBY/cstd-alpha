import { jsonrepair } from "jsonrepair";
import { anySearchEvidenceToReportEvidence, fetchAnySearchEvidence, fetchSearxngEvidence, type AnySearchEvidence, type AnySearchQuery } from "../_shared/anysearch";
import { buildDeepSeekRequestInit, cacheStableUserContent, withCacheProtocol } from "../_shared/deepseek-cache";
import { getOrCreateCompanyEvidencePackage, type CompanyEvidencePackage } from "../_shared/company-evidence";
import { OPENCODE_GO_DEEPSEEK_FLASH_MODEL, buildDeepSeekFallbackRoutes, type DeepSeekFallbackRoute } from "../_shared/opencode-go";
import type { EvidenceBundle } from "../_shared/providers";
import {
  FULL_ANALYSIS_TEMPLATE_ID,
  RESEARCH_TEMPLATES,
  activeResearchTemplates,
  normalizeTemplateSectionRequirements,
  type ResearchTemplate,
  type TemplateAnalysisResult,
  type TemplateAnalysisStatus,
} from "../../src/shared/user-research";
import {
  analysisRowToResult,
  ensureUserResearchSchema,
  json,
  readUserResearchTemplates,
  requireUserSession,
  sha256,
  watchlistRowToItem,
  type AnalysisRow,
  type WatchlistRow,
} from "../_shared/user-research-db";

type Env = {
  AUTH_SECRET: string;
  OPENCODE_ZEN_API_KEY?: string;
  OPENCODE_GO_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  ANYSEARCH_API_KEY?: string;
  SEARXNG_ENDPOINTS?: string;
  GITHUB_RADAR_DISPATCH_TOKEN?: string;
  GITHUB_TEMPLATE_DISPATCH_TOKEN?: string;
  GITHUB_TEMPLATE_REPOSITORY?: string;
  GITHUB_TEMPLATE_WORKFLOW?: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

type DurableTemplateEnv = {
  OPENCODE_ZEN_API_KEY?: string;
  OPENCODE_GO_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  ANYSEARCH_API_KEY?: string;
  SEARXNG_ENDPOINTS?: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};
type TemplateCacheEnv = {
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

type GenerateBody = {
  watchlistId?: string;
  templateId?: string;
  forceRefresh?: boolean;
};

type GeneratedTemplateAnalysis = ReturnType<typeof normalizeGeneratedAnalysis> & { modelUsed?: string };
type TemplateReasoningEffort = "high" | "max";
type TemplateCacheMode = "free" | "paid";
type TemplateGenerationAttempt = {
  reasoningEffort: TemplateReasoningEffort;
  cacheMode: TemplateCacheMode;
  maxTokens: number;
};

const PAID_MODEL = OPENCODE_GO_DEEPSEEK_FLASH_MODEL;
const TEMPLATE_REPORT_PREFIX = "user-research/v1";
const MODEL_REQUEST_TIMEOUT_MS = 540_000;
const GITHUB_TEMPLATE_REPOSITORY = "Muguett-DBY/cstd-alpha";
const GITHUB_TEMPLATE_WORKFLOW = "template-analysis.yml";
const TEMPLATE_CACHE_ANCHOR_SENTENCE =
  "CSTD Alpha user-template DeepSeek Flash Max cache anchor. Use the same long-term owner perspective, conservative evidence rules, strict anti-fabrication policy, Markdown report structure, risk/reward framing, valuation discipline and Chinese writing style for every company. ";
const FREE_TEMPLATE_CACHE_REPEAT = 180;
const PAID_TEMPLATE_CACHE_REPEAT = 420;
const FULL_ANALYSIS_UNCACHED_WARMUP_COUNT = 2;
const CHILD_SYNTHESIS_MARKDOWN_CHARS = 7000;
const CHILD_SYNTHESIS_TOTAL_MARKDOWN_CHARS = 60_000;
const HARD_TEMPLATE_SCORE_CAP_FLAG = "后端保守评分约束：报告识别到重大经营、财务、治理、估值或产业红线，已限制模板总分。";
const ITEM_AVERAGE_TEMPLATE_SCORE_CAP_FLAG = "后端保守评分约束：顶层分数明显高于正文分项平均，已按分项均值限制总分。";
const HARD_TEMPLATE_RED_FLAG_PATTERNS = [
  /行业(?:长期)?衰退|衰退期|需求(?:永久|长期)?萎缩/,
  /主营收入持续下滑|营收持续下滑|利润持续下滑|业绩持续下滑|长期走下坡/,
  /经营现金流为负|自由现金流为负|现金流恶化|现金流断裂/,
  /负债率高|高负债|债务压力|资不抵债|偿债风险/,
  /治理混乱|利益输送|关联交易严重|管理层失信|管理层变节/,
  /退市风险|暴雷风险|财务造假|审计意见异常|无法持续经营/,
  /无护城河|护城河(?:很弱|薄弱|坍塌)|商业模式弱|盈利能力差/,
];

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const url = new URL(request.url);
  const analysisId = url.searchParams.get("analysisId")?.trim();
  if (analysisId) {
    const row = await readAnalysisRow(env.REPORT_LIBRARY_DB, session.userId, analysisId);
    if (!row) return json({ error: "模板报告不存在。" }, 404);
    const analysis = analysisRowToResult(row);
    return json({ analysis: await hydrateMarkdown(env, analysis) });
  }

  const watchlistId = url.searchParams.get("watchlistId")?.trim();
  const filters = watchlistId ? "WHERE user_key = ?1 AND watchlist_id = ?2" : "WHERE user_key = ?1";
  const params = watchlistId ? [session.userId, watchlistId] : [session.userId];
  const result = await env.REPORT_LIBRARY_DB.prepare(
    `SELECT id, user_id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, status, title, score, verdict, summary, content_json, object_key, created_at, updated_at, started_at, completed_at, error_message, template_hash, evidence_hash, template_snapshot_json
     FROM template_analysis
     ${filters}
     ORDER BY updated_at DESC`,
  )
    .bind(...params)
    .all<AnalysisRow>();
  return json({ analyses: (result.results ?? []).map(analysisRowToResult), templates: await readUserResearchTemplates(env.REPORT_LIBRARY_DB, session.userId) });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) return json({ error: "REPORT_LIBRARY_DB/REPORT_LIBRARY_BUCKET is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const body = (await request.json().catch(() => null)) as GenerateBody | null;
  const watchlistId = body?.watchlistId?.trim();
  const templateId = body?.templateId?.trim() || FULL_ANALYSIS_TEMPLATE_ID;
  if (!watchlistId) return json({ error: "缺少自选股 ID。" }, 400);
  const watchlist = await readWatchlistRow(env.REPORT_LIBRARY_DB, session.userId, watchlistId);
  if (!watchlist) return json({ error: "自选股不存在。" }, 404);
  const forceRefresh = Boolean(body?.forceRefresh);
  const userTemplates = await readUserResearchTemplates(env.REPORT_LIBRARY_DB, session.userId);
  const enabledTemplates = activeResearchTemplates(userTemplates);

  if (templateId === FULL_ANALYSIS_TEMPLATE_ID) {
    if (!enabledTemplates.length) return json({ error: "没有启用任何模板，无法进行全部模板分析。" }, 400);
    const fullTemplate = fullAnalysisTemplate(enabledTemplates);
    const evidencePackage = await fetchTemplateEvidence(env, session.userId, watchlist, request.signal);
    const cacheEvidenceHash = templateEvidenceCacheHash(evidencePackage);
    const cachedFull = !forceRefresh ? await readCompletedAnalysisCache(env, session.userId, watchlist.id, fullTemplate, cacheEvidenceHash) : null;
    if (cachedFull) return json({ analyses: [cachedFull], watchlistItem: watchlistRowToItem(watchlist) });
    const existingFull = await readAnalysisByWatchlistTemplate(env.REPORT_LIBRARY_DB, session.userId, watchlist.id, FULL_ANALYSIS_TEMPLATE_ID);
    const existingFullResult = existingFull ? analysisRowToResult(existingFull) : null;
    if (!shouldStartFullAnalysis(existingFullResult, forceRefresh)) {
      return json({ analyses: [existingFullResult], watchlistItem: watchlistRowToItem(watchlist) }, 202);
    }
    const running = await queueTemplateAnalysis(env, session.userId, watchlist, fullTemplate, cacheEvidenceHash, context);
    return json({ analyses: [running], watchlistItem: watchlistRowToItem(watchlist) }, 202);
  }

  const template = userTemplates.find((item) => item.id === templateId);
  if (!template) return json({ error: "未知模板。" }, 400);
  if (template.enabled === false) return json({ error: "该模板未启用。" }, 400);
  const evidencePackage = await fetchTemplateEvidence(env, session.userId, watchlist, request.signal);
  const cacheEvidenceHash = templateEvidenceCacheHash(evidencePackage);
  const cachedAnalysis = !forceRefresh ? await readCompletedAnalysisCache(env, session.userId, watchlist.id, template, cacheEvidenceHash) : null;
  if (cachedAnalysis) return json({ analysis: cachedAnalysis, watchlistItem: watchlistRowToItem(watchlist) });
  const existing = await readAnalysisByWatchlistTemplate(env.REPORT_LIBRARY_DB, session.userId, watchlist.id, template.id);
  const existingResult = existing ? analysisRowToResult(existing) : null;
  if (!forceRefresh && existingResult?.status === "running") return json({ analysis: existingResult, watchlistItem: watchlistRowToItem(watchlist) }, 202);
  const running = await queueTemplateAnalysis(env, session.userId, watchlist, template, cacheEvidenceHash, context);
  return json({ analysis: running, watchlistItem: watchlistRowToItem(watchlist) }, 202);
};

async function queueTemplateAnalysis(env: Env, userId: string, watchlist: WatchlistRow, template: ResearchTemplate, evidenceHash: string | undefined, context: EventContext<Env, string, unknown>) {
  if (!env.REPORT_LIBRARY_DB) throw new Error("REPORT_LIBRARY_DB is not configured.");
  const running = await writeAnalysisStatus(env.REPORT_LIBRARY_DB, userId, watchlist, template, "running", evidenceHash);
  const dispatchTask = dispatchTemplateAnalysisWorkflow(env, running.id).catch(async (error) => {
    await writeAnalysisFailure(env.REPORT_LIBRARY_DB!, userId, watchlist, template, normalizeTemplateAnalysisError(error), "failed_retryable", running.startedAt, evidenceHash);
  });
  context.waitUntil(dispatchTask);
  return running;
}

async function dispatchTemplateAnalysisWorkflow(env: Env, jobId: string) {
  const token = env.GITHUB_TEMPLATE_DISPATCH_TOKEN?.trim() || env.GITHUB_RADAR_DISPATCH_TOKEN?.trim();
  if (!token) throw new Error("missing GitHub template dispatch token");
  const repository = env.GITHUB_TEMPLATE_REPOSITORY?.trim() || GITHUB_TEMPLATE_REPOSITORY;
  const workflow = env.GITHUB_TEMPLATE_WORKFLOW?.trim() || GITHUB_TEMPLATE_WORKFLOW;
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "CSTDAlphaTemplate/1.0",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId } }),
  });
  if (!response.ok) throw new Error(`GitHub template dispatch failed: ${response.status}`);
}

type TemplateEvidencePackage = CompanyEvidencePackage;

export function templateEvidenceCacheHash(pkg: Pick<CompanyEvidencePackage, "evidenceHash"> & { materialHash?: string }) {
  return pkg.materialHash || pkg.evidenceHash;
}

export async function fetchTemplateEvidence(env: TemplateCacheEnv, userId: string, watchlist: WatchlistRow, signal: AbortSignal): Promise<TemplateEvidencePackage> {
  return getOrCreateCompanyEvidencePackage(env, userId, watchlist, signal);
}

async function readCompletedAnalysisCache(env: TemplateCacheEnv, userId: string, watchlistId: string, template: ResearchTemplate, evidenceHash?: string) {
  if (!env.REPORT_LIBRARY_DB) return null;
  const id = await analysisId(userId, watchlistId, template.id);
  const hash = await templateVersionHash(template);
  const row = await readAnalysisRow(env.REPORT_LIBRARY_DB, userId, id);
  if (!row) return null;
  if (!isTemplateAnalysisCacheReusable(row, hash, evidenceHash, false)) return null;
  const hydrated = await hydrateMarkdown(env, analysisRowToResult(row));
  if (!isUsableTemplateAnalysisCache(hydrated)) return null;
  return { ...hydrated, fromCache: true };
}

export function isTemplateAnalysisCacheReusable(
  row: Pick<AnalysisRow, "status" | "object_key" | "template_hash" | "evidence_hash"> | null | undefined,
  templateHash: string,
  evidenceHash: string | undefined,
  forceRefresh: boolean,
) {
  if (forceRefresh || !row || row.status !== "completed" || !row.object_key || row.template_hash !== templateHash) return false;
  return !evidenceHash || row.evidence_hash === evidenceHash;
}

export function fullAnalysisTemplate(templates: ResearchTemplate[] = RESEARCH_TEMPLATES): ResearchTemplate {
  const count = templates.length;
  return {
    id: FULL_ANALYSIS_TEMPLATE_ID,
    title: "全部模板全面分析",
    shortTitle: "全面分析",
    focus: `整合当前启用的 ${count} 个深度模板核心判断，形成最终投资结论、关键分歧、反证条件和账户动作。`,
    prompt: "整合全部启用模板专项报告，输出最终综合结论。",
    fullPrompt: `请阅读当前启用的 ${count} 个模板专项报告，进行交叉验证，保留分歧，输出最终综合结论、评分、风险反证和仓位规则。\n\n启用模板清单：\n${templates.map((template, index) => `${index + 1}. ${template.title}：${template.focus}`).join("\n")}`,
  };
}

export async function runFullTemplateChildrenCacheAware<T>({
  templates = RESEARCH_TEMPLATES,
  readCached,
  runUncached,
  warmupCount = FULL_ANALYSIS_UNCACHED_WARMUP_COUNT,
}: {
  templates?: ResearchTemplate[];
  readCached: (template: ResearchTemplate) => Promise<T | null>;
  runUncached: (template: ResearchTemplate) => Promise<T>;
  warmupCount?: number;
}) {
  const cacheChecks: Array<{ index: number; template: ResearchTemplate; cached: T | null }> = [];
  for (const [index, template] of templates.entries()) {
    cacheChecks.push({ index, template, cached: await readCached(template) });
  }
  const results = new Array<T>(templates.length);
  const uncached: Array<{ index: number; template: ResearchTemplate }> = [];
  for (const item of cacheChecks) {
    if (item.cached) results[item.index] = item.cached;
    else uncached.push({ index: item.index, template: item.template });
  }

  void warmupCount;
  for (const item of uncached) results[item.index] = await runUncached(item.template);
  return results;
}

export function shouldStartFullAnalysis(existing: TemplateAnalysisResult | null, forceRefresh: boolean) {
  if (forceRefresh) return true;
  return existing?.status !== "running";
}

export async function requestTemplateReport(env: DurableTemplateEnv, watchlist: WatchlistRow, evidence: EvidenceBundle, template: ResearchTemplate, childAnalyses: TemplateAnalysisResult[]) {
  return await requestTemplateReportOnce(env, watchlist, evidence, template, childAnalyses);
}

async function requestTemplateReportOnce(
  env: DurableTemplateEnv,
  watchlist: WatchlistRow,
  evidence: EvidenceBundle,
  template: ResearchTemplate,
  childAnalyses: TemplateAnalysisResult[],
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("model-timeout"), MODEL_REQUEST_TIMEOUT_MS);
  try {
    const maxTokens = template.id === FULL_ANALYSIS_TEMPLATE_ID ? 20000 : 24000;
    const enrichedEvidence = await enrichTemplateEvidenceWithAnySearch(env, watchlist, evidence, template, controller.signal);
    let lastError: unknown;
    for (const route of templateModelRoutes(env, template.id === FULL_ANALYSIS_TEMPLATE_ID)) {
      for (const attempt of templateGenerationAttempts(template.id, maxTokens, route.isFree ? "free" : "paid")) {
        try {
          const messages = buildTemplateMessages(
            watchlist,
            enrichedEvidence,
            template,
            childAnalyses,
            attempt.cacheMode,
          );
          const response = await fetchTemplateModel(route.url, buildTemplateRequest(route, messages, attempt.maxTokens, attempt.reasoningEffort, controller.signal));
          if (!response.ok) {
            lastError = new Error(`模板分析生成失败：${route.model} ${response.status} ${(await response.text()).slice(0, 500)}`);
            continue;
          }
          const payload = (await response.json()) as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
          const choice = payload.choices?.[0];
          const content = choice?.message?.content;
          if (choice?.finish_reason === "length" || !content?.trim()) {
            lastError = new Error(`${route.model} 未返回完整模板分析内容。`);
            continue;
          }
          const generated = { ...normalizeGeneratedAnalysis(JSON.parse(jsonrepair(content)), template), modelUsed: route.model };
          return generated;
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("模板分析生成失败。");
  } catch (error) {
    if (isAbortLikeError(error)) throw new Error("模板分析模型请求超过 9 分钟未返回，已标记为可重试失败。", { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildTemplateMessages(
  watchlist: WatchlistRow,
  evidence: EvidenceBundle,
  template: ResearchTemplate,
  childAnalyses: TemplateAnalysisResult[],
  cacheMode: TemplateCacheMode = "free",
) {
  const markdownTask =
    template.id === FULL_ANALYSIS_TEMPLATE_ID
      ? "基于全部启用模板专项报告生成最终全面分析。要求交叉验证、指出分歧、形成最终结论。不要为了篇幅重复扩写；只要把关键判断、证据、反证和动作建议写完整。"
      : "严格按完整模板原文逐项回答。不是摘要，不是短 JSON。每个有实质信息的模板小节都要包含结论、证据依据、反证条件和跟踪指标；缺证据的部分明确写证据缺口。不要为了凑字扩写。";
  return [
    {
      role: "system" as const,
      content: withCacheProtocol(
        `你是 CSTD Alpha 的长期股权深度研究员。只返回合法 JSON，不要 Markdown 包裹。报告正文必须是完整中文 Markdown。结论严格、保守、站在小股东视角；不得编造无证据数据，缺失处明确写需复核。\n\n${templateCacheAnchor(cacheMode)}\n\n## 固定输出要求\n- 必须严格按后续模板原文生成，不得只做摘要。\n- 必须输出合法 JSON 对象，且必须包含 title、score、verdict、summary、keyPoints、riskFlags、followUps、markdown 八个字段。\n- score 必须是 0-100 数字；keyPoints、riskFlags、followUps 各至少 5 条，不得留空。\n- markdown 字段内放完整中文 Markdown 正文，必须使用二级/三级标题组织，不得只输出列表或短摘要。\n- 正文必须包含：核心结论、证据链、推理链、反证条件、估值/仓位规则、待复核清单。\n- 必须逐项覆盖 user 消息中的 sectionRequirements；每项至少达到对应 minChars 的实质内容，并覆盖 requiredPoints。若证据不足，可以短于 minChars，但必须明确写“证据不足”及缺口。\n- 关键结论必须引用 publicEvidence.sources 中的证据编号（如 E1/E2）或明确来源类型；不得写“数据显示”但不给证据编号或来源。\n- 不得在正文或字段中展示 API 费用、计费或成本估算。\n- 必须优先保证 JSON 完整闭合；不要为了追求篇幅导致 markdown 或 JSON 被截断。`,
        "template-analysis",
      ),
    },
    {
      role: "user" as const,
      content: cacheStableUserContent({
        kind: "template-analysis-evidence",
        stable: {
          evidenceContract:
            "publicEvidence 是唯一事实来源；关键结论必须引用 evidence id 或来源类型；缺少财报、公告、价格、销量或现金流时必须写证据缺口。",
        },
        volatile: {
          company: { name: watchlist.company_name, ticker: watchlist.ticker, market: watchlist.market },
          publicEvidence: compactTemplateEvidence(evidence, false),
        },
      }),
    },
    {
      role: "user" as const,
      content: cacheStableUserContent({
        kind: "template-analysis-task",
        stable: {
          task: markdownTask,
          expectedOutputShape: {
            title: "报告标题",
            score: "0-100 数字，必填",
            verdict: "买入/持有/观察/回避/减仓之一或简短中文结论",
            summary: "摘要必须明确结论、估值、风险和跟踪重点",
            keyPoints: ["至少 5 条核心正面判断，每条必须有证据或推理"],
            riskFlags: ["至少 5 条风险、反证或不确定性，每条必须可跟踪"],
            followUps: ["至少 5 条后续跟踪指标，每条必须具体"],
            markdown: "完整中文 Markdown 报告，使用二级/三级标题，必须覆盖模板原文要求；每个关键小节都要有证据、推理、反证、结论和仓位/动作建议。无需凑字，必须保证 JSON 完整闭合。",
          },
        },
        volatile: {
          evidenceRetrievedAt: evidence.retrievedAt,
          template: { id: template.id, title: template.title, focus: template.focus, fullPrompt: template.fullPrompt },
          sectionRequirements: normalizeTemplateSectionRequirements(template),
          childTemplateReports: buildChildTemplateReportsForPrompt(childAnalyses),
        },
      }),
    },
  ];
}

function templateCacheAnchor(cacheMode: TemplateCacheMode) {
  return TEMPLATE_CACHE_ANCHOR_SENTENCE.repeat(cacheMode === "paid" ? PAID_TEMPLATE_CACHE_REPEAT : FREE_TEMPLATE_CACHE_REPEAT);
}

function templateGenerationAttempts(templateId: string, maxTokens: number, cacheMode: TemplateCacheMode): TemplateGenerationAttempt[] {
  const primaryEffort = templateReasoningEffort(templateId);
  return [
    {
      reasoningEffort: primaryEffort,
      cacheMode,
      maxTokens,
    },
  ];
}

async function enrichTemplateEvidenceWithAnySearch(
  env: DurableTemplateEnv,
  watchlist: WatchlistRow,
  evidence: EvidenceBundle,
  template: ResearchTemplate,
  signal: AbortSignal,
): Promise<EvidenceBundle> {
  const apiKey = env.ANYSEARCH_API_KEY?.trim();
  const searxngEndpoints = env.SEARXNG_ENDPOINTS?.trim();
  if (!apiKey && !searxngEndpoints) return evidence;
  const bucket = env.REPORT_LIBRARY_BUCKET;
  const cached = bucket ? await readTemplateAnySearchCache(bucket, watchlist, template) : null;
  const queries = templateSupplementalSearchQueries(watchlist);
  const anySearchEvidence =
    cached ??
    [
      ...(apiKey
        ? await fetchAnySearchEvidence({
            apiKey,
            signal,
            queries,
          })
        : []),
      ...(searxngEndpoints
        ? await fetchSearxngEvidence({
            endpoints: searxngEndpoints,
            signal,
            queries: queries.map((query) => ({ ...query, maxResults: 2 })),
          })
        : []),
    ];
  if (!cached && bucket) await writeTemplateAnySearchCache(bucket, watchlist, template, anySearchEvidence);
  if (!anySearchEvidence.length) return evidence;
  return {
    ...evidence,
    evidence: [...evidence.evidence, ...anySearchEvidenceToReportEvidence(anySearchEvidence, evidence.retrievedAt)],
    facts: {
      ...evidence.facts,
      externalSearch: {
        source: "AnySearch",
        note: "外部搜索线索只用于补充公司、行业、政策和风险信息，不替代财报、公告、价格或销量硬数据。",
        items: anySearchEvidence.map(({ title, url, summary, topic, publishedAt, qualityScore, anysearchRequestId, cached }) => ({
          title,
          url,
          summary,
          topic,
          publishedAt,
          qualityScore,
          anysearchRequestId,
          cached,
        })),
      },
    },
  };
}

function templateSupplementalSearchQueries(watchlist: WatchlistRow): AnySearchQuery[] {
  return [
    {
      query: `${watchlist.company_name} ${watchlist.ticker} 最新公告 财报 业绩预告 经营现金流 毛利率 订单`,
      topic: `${watchlist.company_name} 模板分析补充证据`,
      sourceType: "official" as const,
      maxResults: 3,
      domains: ["finance", "business", "legal"],
      tags: ["finance.company", "business.company"],
      contentTypes: ["news", "web", "doc", "data"],
      freshness: "month",
    },
    {
      query: `${watchlist.company_name} ${watchlist.ticker} 所属行业 最新变化 竞争格局 价格 销量 库存 产能`,
      topic: `${watchlist.company_name} 所属行业补充证据`,
      sourceType: "official" as const,
      maxResults: 3,
      domains: ["finance", "business"],
      tags: ["finance.market", "business.industry"],
      contentTypes: ["data", "news", "web"],
      freshness: "week",
    },
    {
      query: `${watchlist.company_name} ${watchlist.ticker} 负面 舆情 监管 风险 亏损 下滑 停牌 异动`,
      topic: `${watchlist.company_name} 风险监管补充证据`,
      sourceType: "news" as const,
      maxResults: 3,
      domains: ["finance", "business", "legal"],
      tags: ["finance.risk", "legal.regulation"],
      contentTypes: ["news", "web", "doc"],
      freshness: "month",
    },
  ];
}

async function readTemplateAnySearchCache(bucket: R2Bucket, watchlist: WatchlistRow, template: ResearchTemplate): Promise<AnySearchEvidence[] | null> {
  if (typeof bucket.get !== "function") return null;
  const object = await bucket.get(templateAnySearchCacheKey(watchlist, template)).catch(() => null);
  if (!object) return null;
  const payload = (await object.json().catch(() => null)) as { items?: AnySearchEvidence[] } | null;
  return Array.isArray(payload?.items) ? payload.items : null;
}

async function writeTemplateAnySearchCache(bucket: R2Bucket, watchlist: WatchlistRow, template: ResearchTemplate, items: AnySearchEvidence[]) {
  if (typeof bucket.put !== "function") return;
  await bucket
    .put(templateAnySearchCacheKey(watchlist, template), JSON.stringify({ cachedAt: new Date().toISOString(), items }), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { templateId: template.id, ticker: watchlist.ticker },
    })
    .catch(() => undefined);
}

function templateAnySearchCacheKey(watchlist: WatchlistRow, template: ResearchTemplate) {
  const day = new Date().toISOString().slice(0, 10);
  return `${TEMPLATE_REPORT_PREFIX}/anysearch-cache/${day}/${safeCacheKey(watchlist.user_key || watchlist.user_id || "user")}/${safeCacheKey(watchlist.id || "watchlist")}/${safeCacheKey(template.id)}.json`;
}

function safeCacheKey(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "unknown";
}

export function isUsableTemplateAnalysisCache(analysis: TemplateAnalysisResult) {
  if (analysis.status !== "completed" || !analysis.objectKey) return false;
  const markdownLength = analysis.markdown?.trim().length ?? 0;
  return markdownLength > 0;
}

export function buildChildTemplateReportsForPrompt(childAnalyses: TemplateAnalysisResult[]) {
  let remainingMarkdownChars = CHILD_SYNTHESIS_TOTAL_MARKDOWN_CHARS;
  return childAnalyses.map(({ templateTitle, summary, verdict, score, keyPoints, riskFlags, followUps, markdown }) => {
    const markdownExcerpt = markdown && remainingMarkdownChars > 0 ? clampMarkdownForSynthesis(markdown, Math.min(CHILD_SYNTHESIS_MARKDOWN_CHARS, remainingMarkdownChars)) : undefined;
    if (markdownExcerpt) remainingMarkdownChars -= markdownExcerpt.length;
    return {
      templateTitle,
      summary,
      verdict,
      score,
      keyPoints,
      riskFlags,
      followUps,
      markdownChars: markdown?.length ?? 0,
      markdownExcerpt,
    };
  });
}

function clampMarkdownForSynthesis(markdown: string, maxChars: number) {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 60)).trim()}\n\n（后文因上下文长度限制截断，汇总时以已提供正文和结构化要点交叉验证。）`;
}

export function templateModelRoutes(env: Pick<DurableTemplateEnv, "OPENCODE_ZEN_API_KEY" | "OPENCODE_GO_API_KEY" | "OPENCODE_API_KEY" | "DEEPSEEK_API_KEY">, preferPaid = false): DeepSeekFallbackRoute[] {
  void preferPaid;
  return buildDeepSeekFallbackRoutes(env);
}

function buildTemplateRequest(
  route: DeepSeekFallbackRoute,
  messages: ReturnType<typeof buildTemplateMessages>,
  maxTokens: number,
  reasoningEffort: TemplateReasoningEffort,
  signal: AbortSignal,
): RequestInit {
  return buildDeepSeekRequestInit({
    apiKey: route.apiKey,
    signal,
    model: route.model,
    thinking: route.isFree ? { type: "enabled" } : { type: "enabled", reasoning_effort: reasoningEffort as "high" | "max" },
    maxTokens,
    messages,
  });
}

export function templateReasoningEffort(templateId: string): TemplateReasoningEffort {
  void templateId;
  return "max";
}

async function fetchTemplateModel(url: string, init: RequestInit) {
  return fetch(url, init);
}

export async function writeCompletedAnalysis(
  db: D1Database,
  userId: string,
  watchlist: WatchlistRow,
  template: ResearchTemplate,
  generated: GeneratedTemplateAnalysis,
  objectKey: string,
  startedAt: string,
  completedAt: string,
  evidenceHash?: string,
) {
  const id = await analysisId(userId, watchlist.id, template.id);
  const result: TemplateAnalysisResult = {
    id,
    userId,
    watchlistId: watchlist.id,
    templateId: template.id,
    templateTitle: template.title,
    companyName: watchlist.company_name,
    ticker: watchlist.ticker,
    market: watchlist.market,
    model: generated.modelUsed ?? PAID_MODEL,
    status: "completed",
    title: generated.title,
    score: generated.score,
    verdict: generated.verdict,
    summary: generated.summary,
    objectKey,
    keyPoints: generated.keyPoints,
    riskFlags: generated.riskFlags,
    followUps: generated.followUps,
    sections: generated.sections,
    createdAt: startedAt,
    updatedAt: completedAt,
    startedAt,
    completedAt,
    templateHash: await templateVersionHash(template),
    evidenceHash,
    templateSnapshot: snapshotTemplate(template),
  };
  await upsertAnalysis(db, result, JSON.stringify({ keyPoints: result.keyPoints, riskFlags: result.riskFlags, followUps: result.followUps, sections: result.sections }), null);
  return result;
}

export async function writeAnalysisStatus(db: D1Database, userId: string, watchlist: WatchlistRow, template: ResearchTemplate, status: TemplateAnalysisStatus, evidenceHash?: string) {
  const now = new Date().toISOString();
  const result = {
    ...baseAnalysis(userId, watchlist, template, status, now),
    id: await analysisId(userId, watchlist.id, template.id),
    startedAt: status === "running" ? now : undefined,
    templateHash: await templateVersionHash(template),
    evidenceHash,
    templateSnapshot: snapshotTemplate(template),
  };
  await upsertAnalysis(db, result, JSON.stringify({ keyPoints: [], riskFlags: [], followUps: [], sections: [] }), null);
  return result;
}

export async function writeAnalysisFailure(db: D1Database, userId: string, watchlist: WatchlistRow, template: ResearchTemplate, errorMessage: string, status: TemplateAnalysisStatus, startedAt?: string, evidenceHash?: string) {
  const now = new Date().toISOString();
  const result = {
    ...baseAnalysis(userId, watchlist, template, status, now),
    id: await analysisId(userId, watchlist.id, template.id),
    errorMessage,
    startedAt,
    completedAt: now,
    summary: errorMessage,
    templateHash: await templateVersionHash(template),
    evidenceHash,
    templateSnapshot: snapshotTemplate(template),
  };
  await upsertAnalysis(db, result, JSON.stringify({ keyPoints: [], riskFlags: [errorMessage], followUps: ["稍后重试或切换可用模型通道。"], sections: [] }), errorMessage);
  return result;
}

function baseAnalysis(userId: string, watchlist: WatchlistRow, template: ResearchTemplate, status: TemplateAnalysisStatus, now: string): TemplateAnalysisResult {
  return {
    id: "",
    userId,
    watchlistId: watchlist.id,
    templateId: template.id,
    templateTitle: template.title,
    companyName: watchlist.company_name,
    ticker: watchlist.ticker,
    market: watchlist.market,
    model: PAID_MODEL,
    status,
    title: `${watchlist.company_name}${template.shortTitle}`,
    verdict: "待生成",
    summary: status === "running" ? "模板深度报告正在生成。" : "模板深度报告尚未生成。",
    keyPoints: [],
    riskFlags: [],
    followUps: [],
    sections: [],
    createdAt: now,
    updatedAt: now,
    templateSnapshot: snapshotTemplate(template),
  };
}

async function upsertAnalysis(db: D1Database, result: TemplateAnalysisResult, contentJson: string, errorMessage: string | null) {
  const id = result.id || (await analysisId(result.userId, result.watchlistId, result.templateId));
  await db
    .prepare(
      `INSERT INTO template_analysis (
        id, user_id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, status, title, score, verdict, summary, content_json, object_key, created_at, updated_at, started_at, completed_at, error_message, template_hash, evidence_hash, template_snapshot_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
      ON CONFLICT(user_key, watchlist_id, template_id) DO UPDATE SET
        user_id = excluded.user_id,
        template_title = excluded.template_title,
        company_name = excluded.company_name,
        ticker = excluded.ticker,
        market = excluded.market,
        model = excluded.model,
        status = excluded.status,
        title = excluded.title,
        score = excluded.score,
        verdict = excluded.verdict,
        summary = excluded.summary,
        content_json = excluded.content_json,
        object_key = COALESCE(excluded.object_key, template_analysis.object_key),
        updated_at = excluded.updated_at,
        started_at = COALESCE(excluded.started_at, template_analysis.started_at),
        completed_at = excluded.completed_at,
        error_message = excluded.error_message,
        template_hash = excluded.template_hash,
        evidence_hash = excluded.evidence_hash,
        template_snapshot_json = excluded.template_snapshot_json`,
    )
    .bind(
      id,
      result.userId,
      result.userId,
      result.watchlistId,
      result.templateId,
      result.templateTitle,
      result.companyName,
      result.ticker,
      result.market,
      result.model,
      result.status,
      result.title,
      result.score ?? null,
      result.verdict,
      result.summary,
      contentJson,
      result.objectKey ?? null,
      result.createdAt,
      result.updatedAt,
      result.startedAt ?? null,
      result.completedAt ?? null,
      errorMessage,
      result.templateHash ?? null,
      result.evidenceHash ?? null,
      result.templateSnapshot ? JSON.stringify(result.templateSnapshot) : null,
    )
    .run();
}

async function hydrateMarkdown(env: Pick<Env, "REPORT_LIBRARY_BUCKET">, analysis: TemplateAnalysisResult) {
  if (!env.REPORT_LIBRARY_BUCKET || !analysis.objectKey) return analysis;
  const object = await env.REPORT_LIBRARY_BUCKET.get(analysis.objectKey);
  return object ? { ...analysis, markdown: await object.text() } : analysis;
}

export async function readAnalysisRow(db: D1Database, userId: string, id: string) {
  return db
    .prepare(
      `SELECT id, user_id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, status, title, score, verdict, summary, content_json, object_key, created_at, updated_at, started_at, completed_at, error_message, template_hash, evidence_hash, template_snapshot_json
       FROM template_analysis
       WHERE user_key = ?1 AND id = ?2`,
    )
    .bind(userId, id)
    .first<AnalysisRow>();
}

export async function readAnalysisByWatchlistTemplate(db: D1Database, userId: string, watchlistId: string, templateId: string) {
  return db
    .prepare(
      `SELECT id, user_id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, status, title, score, verdict, summary, content_json, object_key, created_at, updated_at, started_at, completed_at, error_message, template_hash, evidence_hash, template_snapshot_json
       FROM template_analysis
       WHERE user_key = ?1 AND watchlist_id = ?2 AND template_id = ?3`,
    )
    .bind(userId, watchlistId, templateId)
    .first<AnalysisRow>();
}

export async function readWatchlistRow(db: D1Database, userId: string, id: string) {
  return db
    .prepare(
      `SELECT id, user_id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
       FROM user_watchlist
       WHERE user_key = ?1 AND id = ?2`,
    )
    .bind(userId, id)
    .first<WatchlistRow>();
}

async function analysisId(userId: string, watchlistId: string, templateId: string) {
  return sha256(`${userId}:${watchlistId}:${templateId}`);
}

export async function templateVersionHash(template: ResearchTemplate) {
  return sha256(
    JSON.stringify({
      id: template.id,
      title: template.title,
      shortTitle: template.shortTitle,
      focus: template.focus,
      prompt: template.prompt,
      fullPrompt: template.fullPrompt,
      enabled: template.enabled !== false,
    }),
  );
}

function snapshotTemplate(template: ResearchTemplate): ResearchTemplate {
  return {
    id: template.id,
    title: template.title,
    shortTitle: template.shortTitle,
    focus: template.focus,
    prompt: template.prompt,
    fullPrompt: template.fullPrompt,
    enabled: template.enabled !== false,
    sortOrder: template.sortOrder,
    isSystem: template.isSystem,
  };
}

function compactTemplateEvidence(evidence: EvidenceBundle, includeRetrievedAt = true) {
  const facts = evidence.facts;
  const summary = optionalRecord(facts.summary);
  const eastmoney = optionalRecord(facts.eastmoney);
  const sec = optionalRecord(facts.sec);
  return {
    company: evidence.company,
    ...(includeRetrievedAt ? { retrievedAt: evidence.retrievedAt } : {}),
    sources: evidence.evidence.map((item) => {
      const withId = item as typeof item & { id?: string; evidenceType?: string };
      return { id: withId.id, title: item.title, source: item.source, freshness: item.freshness, notes: item.notes, evidenceType: withId.evidenceType };
    }),
    facts: {
      quote: pickKeys(optionalRecord(facts.quote), [
        "regularMarketPrice",
        "currency",
        "marketCap",
        "trailingPE",
        "forwardPE",
        "priceToBook",
        "dividendYield",
        "regularMarketChangePercent",
        "fiftyTwoWeekHigh",
        "fiftyTwoWeekLow",
        "marketState",
      ]),
      selectedCompany: facts.selectedCompany,
      financialTenYear: facts.financialTenYear,
      eastmoney: {
        quote: pickKeys(optionalRecord(eastmoney?.quote), ["f43", "f44", "f45", "f46", "f57", "f58", "f116", "f162", "f167", "f168", "f169", "f170", "f173"]),
        incomeRows: latestRows(eastmoney?.incomeRows, 8),
        cashflowRows: latestRows(eastmoney?.cashflowRows, 8),
        balanceRows: latestRows(eastmoney?.balanceRows, 8),
      },
      sec: sec
        ? {
            cik: sec.cik,
            title: sec.title,
            latestAnnual: sec.latestAnnual,
            latestQuarter: sec.latestQuarter,
            normalizedFinancialTenYear: sec.normalizedFinancialTenYear,
            summaryFinancialData: sec.summaryFinancialData,
          }
        : undefined,
      summary: {
        assetProfile: summary?.assetProfile,
        price: summary?.price,
        financialData: summary?.financialData,
        summaryDetail: summary?.summaryDetail,
        defaultKeyStatistics: summary?.defaultKeyStatistics,
      },
      fundamentals: facts.fundamentals,
    },
  };
}

export function normalizeGeneratedAnalysis(value: unknown, template: ResearchTemplate) {
  const record = isRecord(value) ? value : {};
  const markdown = stringValue(record.markdown) || stringValue(record.body);
  return applyTemplateScoreDiscipline({
    title: stringValue(record.title) || `${template.title}`,
    score: numberValue(record.score),
    verdict: stringValue(record.verdict) || "观察",
    summary: stringValue(record.summary) || "模型未提供摘要，需要重新生成。",
    keyPoints: stringArray(record.keyPoints),
    riskFlags: stringArray(record.riskFlags),
    followUps: stringArray(record.followUps),
    sections: markdownToSections(markdown),
    markdown: markdown || `# ${template.title}\n\n模型未提供正文，需要重新生成。`,
  });
}

type NormalizedTemplateAnalysis = {
  title: string;
  score?: number;
  verdict: string;
  summary: string;
  keyPoints: string[];
  riskFlags: string[];
  followUps: string[];
  sections: Array<{ heading: string; body: string }>;
  markdown: string;
};

function applyTemplateScoreDiscipline(analysis: NormalizedTemplateAnalysis): NormalizedTemplateAnalysis {
  if (analysis.score === undefined) return analysis;
  const fullText = [analysis.verdict, analysis.summary, ...analysis.riskFlags, analysis.markdown].join("\n");
  const caps: Array<{ score: number; flag: string }> = [];

  if (hardTemplateRedFlagCount(fullText) >= 3 || hasAvoidConclusion(fullText)) {
    caps.push({ score: 49, flag: HARD_TEMPLATE_SCORE_CAP_FLAG });
  } else if (hardTemplateRedFlagCount(fullText) >= 2) {
    caps.push({ score: 69, flag: HARD_TEMPLATE_SCORE_CAP_FLAG });
  }

  if (/减仓|低配|降低仓位|暂缓买入/.test(analysis.verdict)) {
    caps.push({ score: 65, flag: HARD_TEMPLATE_SCORE_CAP_FLAG });
  }

  const averageItemScore = markdownItemScoreAverage(analysis.markdown);
  if (averageItemScore !== undefined && analysis.score > averageItemScore + 8) {
    caps.push({ score: roundTemplateScore(averageItemScore + 5), flag: ITEM_AVERAGE_TEMPLATE_SCORE_CAP_FLAG });
  }

  const cappedScore = Math.min(analysis.score, ...caps.map((cap) => cap.score));
  const addedFlags = caps.map((cap) => cap.flag).filter((flag, index, flags) => flags.indexOf(flag) === index);
  if (!caps.length) {
    return { ...analysis, verdict: disciplinedTemplateVerdict(analysis.verdict, cappedScore) };
  }
  return {
    ...analysis,
    score: cappedScore,
    verdict: disciplinedTemplateVerdict(analysis.verdict, cappedScore),
    riskFlags: [...analysis.riskFlags, ...addedFlags.filter((flag) => !analysis.riskFlags.includes(flag))],
  };
}

function hardTemplateRedFlagCount(text: string) {
  return HARD_TEMPLATE_RED_FLAG_PATTERNS.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function hasAvoidConclusion(text: string) {
  return /回避|规避|卖出|清仓|不建议(?:买入|持有|配置)|不适合长期股权投资|坚决不能投/.test(text);
}

function markdownItemScoreAverage(markdown: string) {
  const scores = markdown
    .split(/\n+/)
    .map((line) => line.match(/^#+[^\n]*[（(]\s*([0-9０-９]{1,3}(?:\.[0-9]+)?)\s*分/) ?? line.match(/(?:评分|得分|评估)[^\n0-9０-９]{0,20}([0-9０-９]{1,3}(?:\.[0-9]+)?)\s*分/))
    .map((match) => (match ? numberValue(normalizeAsciiNumber(match[1])) : undefined))
    .filter((score): score is number => score !== undefined);
  if (scores.length < 3) return undefined;
  return roundTemplateScore(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function disciplinedTemplateVerdict(verdict: string, score: number) {
  if (score <= 35 && /买入|重配|加仓|持有|配置/.test(verdict)) return "回避/重新复核";
  if (score <= 49 && /买入|重配|加仓|持有|配置/.test(verdict)) return "回避/重新复核";
  if (score < 70 && /买入|重配|加仓/.test(verdict)) return "观察/等待";
  return verdict;
}

function normalizeAsciiNumber(value: string) {
  return value.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 48));
}

function roundTemplateScore(value: number) {
  return Math.round(value * 10) / 10;
}

function normalizeTemplateAnalysisError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("OPENCODE_API_KEY")) return "OpenCode Go API Key 未配置，无法调用 DeepSeek Flash Max。";
  if (message.includes("Rate limit exceeded")) return "DeepSeek Flash Max 当前触发限流，请稍后重试；任务已保存为可重试失败。";
  if (message.includes("429")) return "模板分析模型通道当前限流，请稍后重试。";
  return message || "模板分析生成失败。";
}

function isAbortLikeError(error: unknown) {
  if (error === "model-timeout") return true;
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
}

function markdownToSections(markdown: string) {
  if (!markdown.trim()) return [];
  return markdown
    .split(/\n(?=##\s+)/)
    .map((chunk) => {
      const heading = chunk.match(/^##\s+(.+)$/m)?.[1]?.trim() || "分析";
      return { heading, body: chunk.trim() };
    })
    .filter((section) => section.body);
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalRecord(value: unknown) {
  return isRecord(value) ? value : undefined;
}

function pickKeys(record: Record<string, unknown> | undefined, keys: string[]) {
  if (!record) return undefined;
  const picked = keys.reduce<Record<string, unknown>>((result, key) => {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") result[key] = record[key];
    return result;
  }, {});
  return Object.keys(picked).length ? picked : undefined;
}

function latestRows(value: unknown, limit: number) {
  return Array.isArray(value) ? value.slice(0, limit) : undefined;
}
