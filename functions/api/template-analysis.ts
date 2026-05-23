import { jsonrepair } from "jsonrepair";
import { anySearchEvidenceToReportEvidence, fetchAnySearchEvidence, fetchSearxngEvidence, type AnySearchEvidence, type AnySearchQuery } from "../_shared/anysearch";
import { getOrCreateCompanyEvidencePackage, type CompanyEvidencePackage } from "../_shared/company-evidence";
import type { EvidenceBundle } from "../_shared/providers";
import {
  FULL_ANALYSIS_TEMPLATE_ID,
  RESEARCH_TEMPLATES,
  activeResearchTemplates,
  completedTemplateAnalysesForFull,
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
  DEEPSEEK_API_KEY?: string;
  ANYSEARCH_API_KEY?: string;
  SEARXNG_ENDPOINTS?: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

type DurableTemplateEnv = {
  DEEPSEEK_API_KEY?: string;
  ANYSEARCH_API_KEY?: string;
  SEARXNG_ENDPOINTS?: string;
  REPORT_LIBRARY_DB: D1Database;
  REPORT_LIBRARY_BUCKET: R2Bucket;
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

type TemplateProgressWriter = (event: Record<string, unknown>) => void;
type GeneratedTemplateAnalysis = ReturnType<typeof normalizeGeneratedAnalysis> & { modelUsed?: string };
type TemplateReasoningEffort = "high" | "max";
type TemplateCacheMode = "free" | "paid";
type TemplateGenerationAttempt = {
  reasoningEffort: TemplateReasoningEffort;
  cacheMode: TemplateCacheMode;
  maxTokens: number;
};

const PAID_MODEL = "deepseek-v4-flash";
const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const TEMPLATE_REPORT_PREFIX = "user-research/v1";
const MODEL_REQUEST_TIMEOUT_MS = 540_000;
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

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
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

  const durableEnv = {
    ANYSEARCH_API_KEY: env.ANYSEARCH_API_KEY,
    SEARXNG_ENDPOINTS: env.SEARXNG_ENDPOINTS,
    DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
    REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB,
    REPORT_LIBRARY_BUCKET: env.REPORT_LIBRARY_BUCKET,
  };
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
    return streamTemplateGeneration(async (write) => {
      const running = await writeAnalysisStatus(env.REPORT_LIBRARY_DB!, session.userId, watchlist, fullTemplate, "running");
      write({ type: "progress", stage: "full_started", label: "全部模板全面分析", detail: "正在检查已完成模板；缺失模板会由前端分批生成，避免单次 Worker 请求超出 Cloudflare subrequest 限制。" });
      try {
        const children = await readCompletedTemplateAnalysesForFull(env, session.userId, watchlist.id, enabledTemplates, write, cacheEvidenceHash);
        const completedChildren = completedTemplateAnalysesForFull(children, enabledTemplates);
        if (completedChildren.length < enabledTemplates.length) {
          const missingTitles = enabledTemplates
            .filter((template) => !completedChildren.some((analysis) => analysis.templateId === template.id))
            .map((template) => template.shortTitle)
            .join("、");
          const fullFailure = await writeAnalysisFailure(
            env.REPORT_LIBRARY_DB!,
            session.userId,
            watchlist,
            fullTemplate,
            `启用模板尚未全部完成，缺失：${missingTitles || "未知模板"}。请先生成缺失模板后再生成全面分析。`,
            "failed_retryable",
            running.startedAt,
          );
          write({ type: "final", analyses: [fullFailure, ...children], watchlistItem: watchlistRowToItem(watchlist) });
          return;
        }
        write({ type: "progress", stage: "evidence", label: "读取公司证据包", detail: "正在读取公司财务、行情、公告与外部证据包，供最终汇总使用。" });
        const analyses = await generateFullAnalysis(durableEnv, session.userId, watchlist, evidencePackage.evidence, enabledTemplates, forceRefresh, children, write, cacheEvidenceHash);
        write({ type: "final", analyses, watchlistItem: watchlistRowToItem(watchlist) });
      } catch (error) {
        await writeAnalysisFailure(
          env.REPORT_LIBRARY_DB!,
          session.userId,
          watchlist,
          fullTemplate,
          normalizeTemplateAnalysisError(error),
          isRetryableError(error) ? "failed_retryable" : "failed",
          running.startedAt,
        );
        throw error;
      }
    });
  }

  const template = userTemplates.find((item) => item.id === templateId);
  if (!template) return json({ error: "未知模板。" }, 400);
  if (template.enabled === false) return json({ error: "该模板未启用。" }, 400);
  const evidencePackage = await fetchTemplateEvidence(env, session.userId, watchlist, request.signal);
  const cacheEvidenceHash = templateEvidenceCacheHash(evidencePackage);
  const cachedAnalysis = !forceRefresh ? await readCompletedAnalysisCache(env, session.userId, watchlist.id, template, cacheEvidenceHash) : null;
  if (cachedAnalysis) return json({ analysis: cachedAnalysis, watchlistItem: watchlistRowToItem(watchlist) });
  return streamTemplateGeneration(async (write) => {
    write({ type: "progress", stage: "evidence", label: "读取公司证据包", detail: "正在整理公司财务、行情、公告与外部证据包。" });
    write({ type: "progress", stage: "template_analysis", label: "生成模板深度报告", detail: `${template.shortTitle} 正在用 DeepSeek Flash Max 生成。` });
    const analysis = await generateSingleTemplateAnalysis(durableEnv, session.userId, watchlist, evidencePackage.evidence, template, forceRefresh, [], write, cacheEvidenceHash);
    write({ type: "final", analysis, watchlistItem: watchlistRowToItem(watchlist) });
  });
};

function streamTemplateGeneration(run: (write: TemplateProgressWriter) => Promise<void>) {
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write: TemplateProgressWriter = (event) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`));
      };
      write({ type: "progress", stage: "started", label: "模板任务已开始", detail: "连接会保持打开，避免长报告生成时触发 Cloudflare 524。" });
      heartbeat = setInterval(() => {
        write({ type: "progress", stage: "heartbeat", label: "模板分析生成中", detail: "模型仍在生成完整深度报告，请保持等待。" });
      }, 12_000);
      run(write)
        .catch((error) => {
          write({ type: "error", error: error instanceof Error ? error.message : "模板分析生成失败。" });
        })
        .finally(() => {
          if (heartbeat) clearInterval(heartbeat);
          if (!closed) {
            closed = true;
            controller.close();
          }
        });
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

type TemplateEvidencePackage = CompanyEvidencePackage;

export function templateEvidenceCacheHash(pkg: Pick<CompanyEvidencePackage, "evidenceHash"> & { materialHash?: string }) {
  return pkg.materialHash || pkg.evidenceHash;
}

async function fetchTemplateEvidence(env: TemplateCacheEnv, userId: string, watchlist: WatchlistRow, signal: AbortSignal): Promise<TemplateEvidencePackage> {
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

async function generateFullAnalysis(
  env: DurableTemplateEnv,
  userId: string,
  watchlist: WatchlistRow,
  evidence: EvidenceBundle,
  templates: ResearchTemplate[],
  forceRefresh: boolean,
  children: TemplateAnalysisResult[],
  write?: TemplateProgressWriter,
  evidenceHash?: string,
) {
  const fullTemplate = fullAnalysisTemplate(templates);
  const completedChildren = completedTemplateAnalysesForFull(children, templates);
  if (completedChildren.length < templates.length) {
    return [
      await writeAnalysisFailure(env.REPORT_LIBRARY_DB, userId, watchlist, fullTemplate, "启用模板尚未全部完成，全部模板分析暂不可生成。", "failed_retryable"),
      ...children,
    ];
  }
  write?.({ type: "progress", stage: "full_summary", label: "生成综合汇总", detail: `${templates.length} 个启用模板已完成，正在交叉验证并生成最终全面分析。` });
  return [await generateSingleTemplateAnalysis(env, userId, watchlist, evidence, fullTemplate, forceRefresh, completedChildren, write, evidenceHash), ...children];
}

async function readCompletedTemplateAnalysesForFull(
  env: TemplateCacheEnv,
  userId: string,
  watchlistId: string,
  templates: ResearchTemplate[],
  write?: TemplateProgressWriter,
  evidenceHash?: string,
) {
  const analyses: TemplateAnalysisResult[] = [];
  for (const template of templates) {
    const cached = await readCompletedAnalysisCache(env, userId, watchlistId, template, evidenceHash);
    if (cached) {
      write?.({ type: "progress", stage: "child_template_cache", label: "复用专项模板", detail: `${template.shortTitle} 已有缓存，直接复用。` });
      analyses.push(cached);
    }
  }
  return analyses;
}

function fullAnalysisTemplate(templates: ResearchTemplate[] = RESEARCH_TEMPLATES): ResearchTemplate {
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

async function generateSingleTemplateAnalysis(
  env: DurableTemplateEnv,
  userId: string,
  watchlist: WatchlistRow,
  evidence: EvidenceBundle,
  template: ResearchTemplate,
  forceRefresh: boolean,
  childAnalyses: TemplateAnalysisResult[] = [],
  write?: TemplateProgressWriter,
  evidenceHash?: string,
) {
  const cached = !forceRefresh ? await readCompletedAnalysisCache(env, userId, watchlist.id, template, evidenceHash) : null;
  if (cached) {
    return cached;
  }

  await writeAnalysisStatus(env.REPORT_LIBRARY_DB, userId, watchlist, template, "running");
  const startedAt = new Date().toISOString();
  try {
    write?.({ type: "progress", stage: "model", label: "DeepSeek 生成中", detail: `${template.shortTitle} 正在生成完整 Markdown 深度报告。` });
    const generated = await requestTemplateReport(env, watchlist, evidence, template, childAnalyses);
    const templateHash = await templateVersionHash(template);
    const objectKey = `${TEMPLATE_REPORT_PREFIX}/${userId}/${watchlist.id}/${template.id}-${templateHash.slice(0, 12)}.md`;
    await env.REPORT_LIBRARY_BUCKET.put(objectKey, generated.markdown, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { templateId: template.id, templateHash, ticker: watchlist.ticker },
    });
    const completedAt = new Date().toISOString();
    const result = await writeCompletedAnalysis(env.REPORT_LIBRARY_DB, userId, watchlist, template, generated, objectKey, startedAt, completedAt, evidenceHash);
    write?.({ type: "progress", stage: "saved", label: "模板报告已保存", detail: `${template.shortTitle} 已写入 R2/D1 报告库。` });
    return { ...result, markdown: generated.markdown };
  } catch (error) {
    return writeAnalysisFailure(env.REPORT_LIBRARY_DB, userId, watchlist, template, normalizeTemplateAnalysisError(error), isRetryableError(error) ? "failed_retryable" : "failed", startedAt);
  }
}

export async function requestTemplateReport(env: DurableTemplateEnv, watchlist: WatchlistRow, evidence: EvidenceBundle, template: ResearchTemplate, childAnalyses: TemplateAnalysisResult[]) {
  try {
    return await requestTemplateReportOnce(env, watchlist, evidence, template, childAnalyses);
  } catch (error) {
    return buildEvidenceFallbackTemplateReport(watchlist, evidence, template, error);
  }
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
    for (const route of templateModelRoutes(env.DEEPSEEK_API_KEY, template.id === FULL_ANALYSIS_TEMPLATE_ID)) {
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
      content: `你是 CSTD Alpha 的长期股权深度研究员。只返回合法 JSON，不要 Markdown 包裹。报告正文必须是完整中文 Markdown。结论严格、保守、站在小股东视角；不得编造无证据数据，缺失处明确写需复核。\n\n${templateCacheAnchor(cacheMode)}\n\n## 固定输出要求\n- 必须严格按后续模板原文生成，不得只做摘要。\n- 必须输出合法 JSON 对象，且必须包含 title、score、verdict、summary、keyPoints、riskFlags、followUps、markdown 八个字段。\n- score 必须是 0-100 数字；keyPoints、riskFlags、followUps 各至少 5 条，不得留空。\n- markdown 字段内放完整中文 Markdown 正文，必须使用二级/三级标题组织，不得只输出列表或短摘要。\n- 正文必须包含：核心结论、证据链、推理链、反证条件、估值/仓位规则、待复核清单。\n- 必须逐项覆盖 user 消息中的 sectionRequirements；每项至少达到对应 minChars 的实质内容，并覆盖 requiredPoints。若证据不足，可以短于 minChars，但必须明确写“证据不足”及缺口。\n- 关键结论必须引用 publicEvidence.sources 中的证据编号（如 E1/E2）或明确来源类型；不得写“数据显示”但不给证据编号或来源。\n- 不得在正文或字段中展示 API 费用、计费或成本估算。\n- 必须优先保证 JSON 完整闭合；不要为了追求篇幅导致 markdown 或 JSON 被截断。`,
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        company: { name: watchlist.company_name, ticker: watchlist.ticker, market: watchlist.market },
        publicEvidence: compactTemplateEvidence(evidence, false),
      }),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: markdownTask,
        evidenceRetrievedAt: evidence.retrievedAt,
        template: { id: template.id, title: template.title, focus: template.focus, fullPrompt: template.fullPrompt },
        sectionRequirements: normalizeTemplateSectionRequirements(template),
        childTemplateReports: buildChildTemplateReportsForPrompt(childAnalyses),
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
  const cached = await readTemplateAnySearchCache(env.REPORT_LIBRARY_BUCKET, watchlist, template);
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
  if (!cached) await writeTemplateAnySearchCache(env.REPORT_LIBRARY_BUCKET, watchlist, template, anySearchEvidence);
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

export function templateModelRoutes(apiKey: string | undefined, preferPaid = false): Array<{ model: typeof PAID_MODEL; url: string; apiKey: string; isFree: false }> {
  const paidRoute = apiKey?.trim()
    ? ({ model: PAID_MODEL, url: DEEPSEEK_CHAT_COMPLETIONS_URL, apiKey: apiKey.trim(), isFree: false } as const)
    : undefined;
  void preferPaid;
  if (!paidRoute) throw new Error("DEEPSEEK_API_KEY 未配置，模板分析无法生成。");
  return [paidRoute];
}

function buildTemplateRequest(
  route: { model: typeof PAID_MODEL; apiKey: string; isFree: false },
  messages: ReturnType<typeof buildTemplateMessages>,
  maxTokens: number,
  reasoningEffort: TemplateReasoningEffort,
  signal: AbortSignal,
): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) },
    signal,
    body: JSON.stringify({
      model: route.model,
      reasoning_effort: reasoningEffort,
      response_format: { type: "json_object" },
      stream: false,
      temperature: 0.1,
      max_tokens: maxTokens,
      messages,
    }),
  };
}

export function templateReasoningEffort(templateId: string): TemplateReasoningEffort {
  return templateId === FULL_ANALYSIS_TEMPLATE_ID ? "max" : "high";
}

async function fetchTemplateModel(url: string, init: RequestInit) {
  return fetch(url, init);
}

function buildEvidenceFallbackTemplateReport(watchlist: WatchlistRow, evidence: EvidenceBundle, template: ResearchTemplate, error: unknown): GeneratedTemplateAnalysis {
  const evidenceItems = evidence.evidence.slice(0, 10).map((item, index) => {
    const withId = item as typeof item & { id?: string; evidenceType?: string };
    return {
      id: withId.id || `E${index + 1}`,
      title: item.title,
      source: item.source,
      freshness: item.freshness,
      notes: item.notes,
      evidenceType: withId.evidenceType,
      url: item.url,
    };
  });
  const evidenceLines = evidenceItems.length
    ? evidenceItems.map((item) => `- ${item.id}: ${item.title}（${item.source || "公开来源"}，${item.freshness || "时间待核验"}）${item.notes ? ` - ${item.notes}` : ""}`).join("\n")
    : "- 当前证据包没有可用来源，必须先补充公司财报、行情、公告或外部搜索证据。";
  const quote = optionalRecord(evidence.facts.quote);
  const summary = optionalRecord(evidence.facts.summary);
  const quoteLines = [
    quote?.regularMarketPrice !== undefined ? `- 最新价格：${String(quote.regularMarketPrice)}${quote.currency ? ` ${String(quote.currency)}` : ""}` : "",
    quote?.marketCap !== undefined ? `- 市值：${String(quote.marketCap)}` : "",
    quote?.trailingPE !== undefined ? `- TTM PE：${String(quote.trailingPE)}` : "",
    quote?.priceToBook !== undefined ? `- PB：${String(quote.priceToBook)}` : "",
    summary?.longBusinessSummary ? `- 主营摘要：${String(summary.longBusinessSummary).slice(0, 260)}` : "",
  ].filter(Boolean);
  const modelIssue = normalizeTemplateAnalysisError(error);
  const markdown = [
    `# ${watchlist.company_name}（${watchlist.ticker}）${template.shortTitle}`,
    "",
    "> 本报告为证据包基础版：模型本次未返回可用正文，系统没有再次调用模型，而是基于已缓存的公开证据生成可复核框架。后续如需更深推理，可在证据包更新后重新生成。",
    "",
    "## 核心结论",
    `${watchlist.company_name} 当前结论设为“需复核”。已有证据可以支撑基础事实整理，但不足以替代完整模型推理；投资动作应等待关键财务、估值、行业和反证条件补齐后再决定。`,
    "",
    "## 已使用证据",
    evidenceLines,
    "",
    "## 关键事实快照",
    quoteLines.length ? quoteLines.join("\n") : "- 当前结构化行情或财务摘要不足，需要补充价格、市值、估值、营收、利润、现金流和资产负债数据。",
    "",
    "## 按模板待完成的问题",
    `- 模板：${template.title}`,
    `- 研究重点：${template.focus}`,
    "- 需要逐项核验：商业模式、行业阶段、财务质量、估值安全边际、反证条件、仓位规则和跟踪指标。",
    "",
    "## 风险与反证",
    "- 如果关键财务数据缺失、行业数据无法交叉验证，任何高分结论都应降级为观察。",
    "- 如果估值、盈利质量、现金流或治理出现明确负面证据，应优先降低仓位或回避。",
    "- 如果证据只来自单一来源或新闻线索，不应视为可投资结论。",
    "",
    "## 后续跟踪",
    "- 补齐最近一期财报、经营现金流、毛利率、净利润和资本开支。",
    "- 跟踪所属行业价格、销量、库存、订单或政策变化。",
    "- 复核估值分位、股价动量和市场预期变化。",
    "- 检查重大公告、监管事件、诉讼、减持和治理风险。",
    "- 在证据包发生实质变化后重新生成模板报告。",
    "",
    "## 本次未使用模型生成的原因",
    `- ${modelIssue}`,
  ].join("\n");
  return {
    ...normalizeGeneratedAnalysis(
      {
        title: `${watchlist.company_name}${template.shortTitle}基础版`,
        score: 49,
        verdict: "需复核",
        summary: "模型本次未返回可用正文，系统未再次调用模型；此报告基于证据包生成基础研究框架，避免空结果和重复消耗。",
        keyPoints: [
          "已返回可读基础报告，避免空内容。",
          "报告仅使用当前证据包，不额外调用模型。",
          "结论保持保守，避免无证据高分。",
          "列出已使用证据，便于复核。",
          "给出后续需要补齐的关键跟踪项。",
        ],
        riskFlags: [
          "该报告不是完整模型推理结果。",
          "证据包可能缺少最新财报或行业硬数据。",
          "不能用单一新闻线索替代财务验证。",
          "估值和仓位结论需要重新生成后确认。",
          "若模型服务持续不可用，应先检查 API 状态和证据包质量。",
        ],
        followUps: ["补齐财报", "补齐行业数据", "复核估值", "复核风险事件", "证据变化后重新生成"],
        markdown,
      },
      template,
    ),
    modelUsed: "evidence-fallback",
  };
}

async function writeCompletedAnalysis(
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

async function writeAnalysisStatus(db: D1Database, userId: string, watchlist: WatchlistRow, template: ResearchTemplate, status: TemplateAnalysisStatus) {
  const now = new Date().toISOString();
  const result = {
    ...baseAnalysis(userId, watchlist, template, status, now),
    id: await analysisId(userId, watchlist.id, template.id),
    startedAt: status === "running" ? now : undefined,
    templateHash: await templateVersionHash(template),
    templateSnapshot: snapshotTemplate(template),
  };
  await upsertAnalysis(db, result, JSON.stringify({ keyPoints: [], riskFlags: [], followUps: [], sections: [] }), null);
  return result;
}

async function writeAnalysisFailure(db: D1Database, userId: string, watchlist: WatchlistRow, template: ResearchTemplate, errorMessage: string, status: TemplateAnalysisStatus, startedAt?: string) {
  const now = new Date().toISOString();
  const result = {
    ...baseAnalysis(userId, watchlist, template, status, now),
    id: await analysisId(userId, watchlist.id, template.id),
    errorMessage,
    startedAt,
    completedAt: now,
    summary: errorMessage,
    templateHash: await templateVersionHash(template),
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

async function readAnalysisRow(db: D1Database, userId: string, id: string) {
  return db
    .prepare(
      `SELECT id, user_id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, status, title, score, verdict, summary, content_json, object_key, created_at, updated_at, started_at, completed_at, error_message, template_hash, evidence_hash, template_snapshot_json
       FROM template_analysis
       WHERE user_key = ?1 AND id = ?2`,
    )
    .bind(userId, id)
    .first<AnalysisRow>();
}

async function readAnalysisByWatchlistTemplate(db: D1Database, userId: string, watchlistId: string, templateId: string) {
  return db
    .prepare(
      `SELECT id, user_id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, status, title, score, verdict, summary, content_json, object_key, created_at, updated_at, started_at, completed_at, error_message, template_hash, evidence_hash, template_snapshot_json
       FROM template_analysis
       WHERE user_key = ?1 AND watchlist_id = ?2 AND template_id = ?3`,
    )
    .bind(userId, watchlistId, templateId)
    .first<AnalysisRow>();
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

async function analysisId(userId: string, watchlistId: string, templateId: string) {
  return sha256(`${userId}:${watchlistId}:${templateId}`);
}

async function templateVersionHash(template: ResearchTemplate) {
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
  if (message.includes("DEEPSEEK_API_KEY")) return "DeepSeek API Key 未配置，免费通道失败后无法启用付费兜底。";
  if (message.includes("Rate limit exceeded")) return "DeepSeek Flash Max 当前触发限流，请稍后重试；任务已保存为可重试失败。";
  if (message.includes("429")) return "模板分析模型通道当前限流，请稍后重试。";
  return message || "模板分析生成失败。";
}

function isRetryableError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("Rate limit exceeded") ||
    message.includes("429") ||
    message.includes("输出过短") ||
    message.includes("未返回完整模板分析内容") ||
    message.includes("超过 9 分钟") ||
    /\b5\d\d\b/.test(message)
  );
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
