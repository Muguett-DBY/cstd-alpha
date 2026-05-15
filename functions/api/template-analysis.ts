import { jsonrepair } from "jsonrepair";
import { fetchPublicCompanyEvidence, type EvidenceBundle } from "../_shared/providers";
import {
  FULL_ANALYSIS_TEMPLATE_ID,
  RESEARCH_TEMPLATES,
  completedTemplateAnalysesForFull,
  minimumResearchMarkdownChars,
  researchTemplateById,
  type ResearchTemplate,
  type TemplateAnalysisResult,
  type TemplateAnalysisStatus,
} from "../../src/shared/user-research";
import {
  analysisRowToResult,
  ensureUserResearchSchema,
  json,
  requireUserSession,
  sha256,
  watchlistRowToItem,
  type AnalysisRow,
  type WatchlistRow,
} from "../_shared/user-research-db";

type Env = {
  AUTH_SECRET: string;
  DEEPSEEK_API_KEY?: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

type DurableTemplateEnv = {
  DEEPSEEK_API_KEY?: string;
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

const FREE_MODEL = "deepseek-v4-flash-free";
const PAID_MODEL = "deepseek-v4-flash";
const OPENCODE_ZEN_CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/v1/chat/completions";
const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const TEMPLATE_REPORT_PREFIX = "user-research/v1";
const MODEL_REQUEST_TIMEOUT_MS = 540_000;
const TEMPLATE_CACHE_ANCHOR_SENTENCE =
  "CSTD Alpha ten-template DeepSeek Flash Max cache anchor. Use the same long-term owner perspective, conservative evidence rules, strict anti-fabrication policy, Markdown report structure, risk/reward framing, valuation discipline and Chinese writing style for every company. ";
const FREE_TEMPLATE_CACHE_REPEAT = 180;
const PAID_TEMPLATE_CACHE_REPEAT = 420;
const FULL_ANALYSIS_UNCACHED_WARMUP_COUNT = 2;

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
    `SELECT id, user_id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, status, title, score, verdict, summary, content_json, object_key, created_at, updated_at, started_at, completed_at, error_message
     FROM template_analysis
     ${filters}
     ORDER BY updated_at DESC`,
  )
    .bind(...params)
    .all<AnalysisRow>();
  return json({ analyses: (result.results ?? []).map(analysisRowToResult), templates: RESEARCH_TEMPLATES });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
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

  const durableEnv = { DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY, REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB, REPORT_LIBRARY_BUCKET: env.REPORT_LIBRARY_BUCKET };
  if (templateId === FULL_ANALYSIS_TEMPLATE_ID) {
    const cachedFull = !forceRefresh ? await readCompletedAnalysisCache(env, session.userId, watchlist.id, FULL_ANALYSIS_TEMPLATE_ID) : null;
    if (cachedFull) return json({ analyses: [cachedFull], watchlistItem: watchlistRowToItem(watchlist) });
    const fullTemplate = fullAnalysisTemplate();
    const existingFull = await readAnalysisByWatchlistTemplate(env.REPORT_LIBRARY_DB, session.userId, watchlist.id, FULL_ANALYSIS_TEMPLATE_ID);
    const existingFullResult = existingFull ? analysisRowToResult(existingFull) : null;
    if (!shouldStartFullAnalysis(existingFullResult, forceRefresh)) {
      return json({ analyses: [existingFullResult], watchlistItem: watchlistRowToItem(watchlist) }, 202);
    }
    const running = await writeAnalysisStatus(env.REPORT_LIBRARY_DB, session.userId, watchlist, fullTemplate, "running");
    waitUntil(
      runFullAnalysisInBackground(durableEnv, session.userId, watchlist, forceRefresh).catch((error) =>
        writeAnalysisFailure(
          env.REPORT_LIBRARY_DB!,
          session.userId,
          watchlist,
          fullTemplate,
          normalizeTemplateAnalysisError(error),
          isRetryableError(error) ? "failed_retryable" : "failed",
          running.startedAt,
        ),
      ),
    );
    return json({ analyses: [running], watchlistItem: watchlistRowToItem(watchlist) }, 202);
  }

  const template = researchTemplateById(templateId);
  if (!template) return json({ error: "未知模板。" }, 400);
  const cachedAnalysis = !forceRefresh ? await readCompletedAnalysisCache(env, session.userId, watchlist.id, template.id) : null;
  if (cachedAnalysis) return json({ analysis: cachedAnalysis, watchlistItem: watchlistRowToItem(watchlist) });
  return streamTemplateGeneration(async (write) => {
    write({ type: "progress", stage: "evidence", label: "读取公开证据", detail: "正在整理公司财务、行情与公开证据。" });
    const evidence = await fetchTemplateEvidence(watchlist, request.signal);
    write({ type: "progress", stage: "template_analysis", label: "生成模板深度报告", detail: `${template.shortTitle} 正在用 DeepSeek Flash Max 生成。` });
    const analysis = await generateSingleTemplateAnalysis(durableEnv, session.userId, watchlist, evidence, template, forceRefresh, [], write);
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

async function fetchTemplateEvidence(watchlist: WatchlistRow, signal: AbortSignal) {
  return fetchPublicCompanyEvidence({
    companyName: watchlist.company_name,
    ticker: watchlist.ticker,
    market: watchlist.market,
    company: watchlistRowToItem(watchlist).company,
    signal,
  });
}

async function runFullAnalysisInBackground(env: DurableTemplateEnv, userId: string, watchlist: WatchlistRow, forceRefresh: boolean) {
  const controller = new AbortController();
  const evidence = await fetchTemplateEvidence(watchlist, controller.signal);
  await generateFullAnalysis(env, userId, watchlist, evidence, forceRefresh);
}

async function readCompletedAnalysisCache(env: TemplateCacheEnv, userId: string, watchlistId: string, templateId: string) {
  if (!env.REPORT_LIBRARY_DB) return null;
  const id = await analysisId(userId, watchlistId, templateId);
  const row = await readAnalysisRow(env.REPORT_LIBRARY_DB, userId, id);
  if (!row || row.status !== "completed" || !row.object_key) return null;
  return { ...(await hydrateMarkdown(env, analysisRowToResult(row))), fromCache: true };
}

async function generateFullAnalysis(
  env: DurableTemplateEnv,
  userId: string,
  watchlist: WatchlistRow,
  evidence: EvidenceBundle,
  forceRefresh: boolean,
  write?: TemplateProgressWriter,
) {
  const children = await runFullTemplateChildrenCacheAware({
    readCached: async (template) => {
      const cached = await readCompletedAnalysisCache(env, userId, watchlist.id, template.id);
      if (cached) write?.({ type: "progress", stage: "child_template_cache", label: "复用专项模板", detail: `${template.shortTitle} 已有缓存，直接复用。` });
      return cached;
    },
    runUncached: async (template) => {
      write?.({ type: "progress", stage: "child_template", label: "生成专项模板", detail: `正在生成 ${template.shortTitle}。` });
      return generateSingleTemplateAnalysis(env, userId, watchlist, evidence, template, false, [], write);
    },
  });
  const fullTemplate = fullAnalysisTemplate();
  const completedChildren = completedTemplateAnalysesForFull(children);
  if (completedChildren.length < RESEARCH_TEMPLATES.length) {
    return [
      await writeAnalysisFailure(env.REPORT_LIBRARY_DB, userId, watchlist, fullTemplate, "十个模板尚未全部完成，全面分析暂不可生成。", "failed_retryable"),
      ...children,
    ];
  }
  write?.({ type: "progress", stage: "full_summary", label: "生成综合汇总", detail: "十个专项模板已完成，正在交叉验证并生成最终全面分析。" });
  return [await generateSingleTemplateAnalysis(env, userId, watchlist, evidence, fullTemplate, forceRefresh, completedChildren, write), ...children];
}

function fullAnalysisTemplate(): ResearchTemplate {
  return {
    id: FULL_ANALYSIS_TEMPLATE_ID,
    title: "十模板全面分析",
    shortTitle: "全面分析",
    focus: "整合十个深度模板的核心判断，形成最终投资结论、关键分歧、反证条件和账户动作。",
    prompt: "整合十个模板专项报告，输出最终综合结论。",
    fullPrompt: "请阅读十个模板专项报告，进行交叉验证，保留分歧，输出最终综合结论、评分、风险反证和仓位规则。",
  };
}

export async function runFullTemplateChildrenCacheAware<T>({
  readCached,
  runUncached,
  warmupCount = FULL_ANALYSIS_UNCACHED_WARMUP_COUNT,
}: {
  readCached: (template: ResearchTemplate) => Promise<T | null>;
  runUncached: (template: ResearchTemplate) => Promise<T>;
  warmupCount?: number;
}) {
  const cacheChecks = await Promise.all(
    RESEARCH_TEMPLATES.map(async (template, index) => ({
      index,
      template,
      cached: await readCached(template),
    })),
  );
  const results = new Array<T>(RESEARCH_TEMPLATES.length);
  const uncached: Array<{ index: number; template: ResearchTemplate }> = [];
  for (const item of cacheChecks) {
    if (item.cached) results[item.index] = item.cached;
    else uncached.push({ index: item.index, template: item.template });
  }

  for (const item of uncached.slice(0, Math.max(0, warmupCount))) {
    results[item.index] = await runUncached(item.template);
  }

  const concurrentResults = await Promise.all(
    uncached.slice(Math.max(0, warmupCount)).map(async (item) => ({
      index: item.index,
      result: await runUncached(item.template),
    })),
  );
  for (const item of concurrentResults) results[item.index] = item.result;
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
) {
  const id = await analysisId(userId, watchlist.id, template.id);
  const existing = await readAnalysisRow(env.REPORT_LIBRARY_DB, userId, id);
  if (existing && existing.status === "completed" && existing.object_key && !forceRefresh) {
    return { ...(await hydrateMarkdown(env, analysisRowToResult(existing))), fromCache: true };
  }

  await writeAnalysisStatus(env.REPORT_LIBRARY_DB, userId, watchlist, template, "running");
  const startedAt = new Date().toISOString();
  try {
    write?.({ type: "progress", stage: "model", label: "DeepSeek 生成中", detail: `${template.shortTitle} 正在生成完整 Markdown 深度报告。` });
    const generated = await requestTemplateReport(env, watchlist, evidence, template, childAnalyses);
    const objectKey = `${TEMPLATE_REPORT_PREFIX}/${userId}/${watchlist.id}/${template.id}.md`;
    await env.REPORT_LIBRARY_BUCKET.put(objectKey, generated.markdown, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { templateId: template.id, ticker: watchlist.ticker },
    });
    const completedAt = new Date().toISOString();
    const result = await writeCompletedAnalysis(env.REPORT_LIBRARY_DB, userId, watchlist, template, generated, objectKey, startedAt, completedAt);
    write?.({ type: "progress", stage: "saved", label: "模板报告已保存", detail: `${template.shortTitle} 已写入 R2/D1 报告库。` });
    return { ...result, markdown: generated.markdown };
  } catch (error) {
    return writeAnalysisFailure(env.REPORT_LIBRARY_DB, userId, watchlist, template, normalizeTemplateAnalysisError(error), isRetryableError(error) ? "failed_retryable" : "failed", startedAt);
  }
}

async function requestTemplateReport(env: DurableTemplateEnv, watchlist: WatchlistRow, evidence: EvidenceBundle, template: ResearchTemplate, childAnalyses: TemplateAnalysisResult[]) {
  const first = await requestTemplateReportOnce(env, watchlist, evidence, template, childAnalyses);
  const minLength = minimumMarkdownLength(template);
  if (first.markdown.length >= minLength) return first;
  const expanded = await requestTemplateReportOnce(env, watchlist, evidence, template, childAnalyses, first.markdown);
  if (expanded.markdown.length >= minLength) return expanded;
  throw new Error(`模型输出过短：${expanded.markdown.length}/${minLength} 字符，未保存为成功报告。`);
}

async function requestTemplateReportOnce(
  env: DurableTemplateEnv,
  watchlist: WatchlistRow,
  evidence: EvidenceBundle,
  template: ResearchTemplate,
  childAnalyses: TemplateAnalysisResult[],
  draftToExpand?: string,
) {
  const minLength = minimumMarkdownLength(template);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("model-timeout"), MODEL_REQUEST_TIMEOUT_MS);
  try {
    const maxTokens = template.id === FULL_ANALYSIS_TEMPLATE_ID ? 20000 : 24000;
    let lastError: unknown;
    for (const route of templateModelRoutes(env.DEEPSEEK_API_KEY, template.id === FULL_ANALYSIS_TEMPLATE_ID)) {
      try {
        const messages = buildTemplateMessages(watchlist, evidence, template, childAnalyses, minLength, draftToExpand, route.isFree ? "free" : "paid");
        const response = await fetchTemplateModel(route.url, buildTemplateRequest(route, messages, maxTokens, controller.signal));
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
        if (route.isFree && env.DEEPSEEK_API_KEY?.trim() && generated.markdown.length < minLength) {
          lastError = new Error(`${route.model} 输出过短：${generated.markdown.length}/${minLength} 字符，改用付费 Flash Max 兜底。`);
          continue;
        }
        return generated;
      } catch (error) {
        lastError = error;
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
  minLength: number,
  draftToExpand?: string,
  cacheMode: "free" | "paid" = "free",
) {
  return [
    {
      role: "system" as const,
      content: `你是 CSTD Alpha 的长期股权深度研究员。只返回合法 JSON，不要 Markdown 包裹。报告正文必须是完整中文 Markdown。结论严格、保守、站在小股东视角；不得编造无证据数据，缺失处明确写需复核。正文不足最低字数视为失败。\n\n${templateCacheAnchor(cacheMode)}\n\n## 本次模板原文\n模板 ID：${template.id}\n模板标题：${template.title}\n\n${template.fullPrompt}\n\n## 固定输出要求\n- 必须严格按上方完整模板原文生成，不得只做摘要。\n- 必须输出合法 JSON 对象，markdown 字段内放完整中文 Markdown 正文。\n- 不得在正文或字段中展示 API 费用、计费或成本估算。`,
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: draftToExpand
          ? `上一次 Markdown 正文过短。请在不改变结论方向的前提下扩写为真正深度报告，正文至少 ${minLength} 个中文字符，目标 6000-9000 个中文字符，必须补足证据链、推理链、反证条件、估值/仓位规则和待复核清单。`
          : template.id === FULL_ANALYSIS_TEMPLATE_ID
            ? `基于十个专项模板报告生成最终全面分析。要求交叉验证、指出分歧、形成最终结论。Markdown 正文至少 ${minLength} 个中文字符，目标 7000-10000 个中文字符。`
            : `严格按完整模板原文生成一份超级深度专项报告。不是摘要，不是短 JSON。Markdown 正文至少 ${minLength} 个中文字符，目标 6000-9000 个中文字符，并包含模板要求的所有关键模块。`,
        template: { id: template.id, title: template.title, focus: template.focus },
        company: { name: watchlist.company_name, ticker: watchlist.ticker, market: watchlist.market },
        publicEvidence: compactTemplateEvidence(evidence),
        draftToExpand: draftToExpand || undefined,
        childTemplateReports: childAnalyses.map(({ templateTitle, summary, verdict, score, keyPoints, riskFlags, followUps }) => ({
          templateTitle,
          summary,
          verdict,
          score,
          keyPoints,
          riskFlags,
          followUps,
        })),
        expectedOutputShape: {
          title: "报告标题",
          score: "0-100 数字，可省略",
          verdict: "买入/持有/观察/回避/减仓之一或简短中文结论",
          summary: "300-600 字摘要",
          keyPoints: ["5-10 条核心正面判断"],
          riskFlags: ["5-10 条风险、反证或不确定性"],
          followUps: ["5-10 条后续跟踪指标"],
          markdown: `完整中文 Markdown 深度报告，使用二级/三级标题，必须覆盖模板原文要求；需要有证据、推理、反证、结论和仓位/动作建议。最低 ${minLength} 个中文字符，目标 6000 字以上，不足则不要结束。`,
        },
      }),
    },
  ];
}

function templateCacheAnchor(cacheMode: "free" | "paid") {
  return TEMPLATE_CACHE_ANCHOR_SENTENCE.repeat(cacheMode === "paid" ? PAID_TEMPLATE_CACHE_REPEAT : FREE_TEMPLATE_CACHE_REPEAT);
}

function templateModelRoutes(apiKey: string | undefined, preferPaid = false): Array<{ model: typeof FREE_MODEL | typeof PAID_MODEL; url: string; apiKey?: string; isFree: boolean }> {
  const paidRoute = apiKey?.trim()
    ? ({ model: PAID_MODEL, url: DEEPSEEK_CHAT_COMPLETIONS_URL, apiKey: apiKey.trim(), isFree: false } as const)
    : undefined;
  const freeRoute = { model: FREE_MODEL, url: OPENCODE_ZEN_CHAT_COMPLETIONS_URL, isFree: true } as const;
  if (preferPaid && paidRoute) return [paidRoute, freeRoute];
  return [
    freeRoute,
    ...(paidRoute ? [paidRoute] : []),
  ];
}

function buildTemplateRequest(
  route: { model: typeof FREE_MODEL | typeof PAID_MODEL; apiKey?: string; isFree: boolean },
  messages: ReturnType<typeof buildTemplateMessages>,
  maxTokens: number,
  signal: AbortSignal,
): RequestInit {
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
      max_tokens: maxTokens,
      messages,
    }),
  };
}

async function fetchTemplateModel(url: string, init: RequestInit) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!isRetryableHttpStatus(response.status) || attempt === 2) return response;
      lastError = new Error(`模板分析通道暂时不可用：${response.status} ${(await response.text()).slice(0, 300)}`);
    } catch (error) {
      lastError = error;
      if (isAbortLikeError(error) || attempt === 2) throw error;
    }
    await delay(800 * (attempt + 1));
  }
  throw lastError instanceof Error ? lastError : new Error("模板分析模型请求失败。");
}

function isRetryableHttpStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minimumMarkdownLength(template: ResearchTemplate) {
  return minimumResearchMarkdownChars(template.id);
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
    model: generated.modelUsed ?? FREE_MODEL,
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
  };
  await upsertAnalysis(db, result, JSON.stringify({ keyPoints: [], riskFlags: [], followUps: [], sections: [] }), null);
  return result;
}

async function writeAnalysisFailure(db: D1Database, userId: string, watchlist: WatchlistRow, template: ResearchTemplate, errorMessage: string, status: TemplateAnalysisStatus, startedAt?: string) {
  const now = new Date().toISOString();
  const result = { ...baseAnalysis(userId, watchlist, template, status, now), id: await analysisId(userId, watchlist.id, template.id), errorMessage, startedAt, completedAt: now, summary: errorMessage };
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
    model: FREE_MODEL,
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
  };
}

async function upsertAnalysis(db: D1Database, result: TemplateAnalysisResult, contentJson: string, errorMessage: string | null) {
  const id = result.id || (await analysisId(result.userId, result.watchlistId, result.templateId));
  await db
    .prepare(
      `INSERT INTO template_analysis (
        id, user_id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, status, title, score, verdict, summary, content_json, object_key, created_at, updated_at, started_at, completed_at, error_message
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
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
        error_message = excluded.error_message`,
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
      `SELECT id, user_id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, status, title, score, verdict, summary, content_json, object_key, created_at, updated_at, started_at, completed_at, error_message
       FROM template_analysis
       WHERE user_key = ?1 AND id = ?2`,
    )
    .bind(userId, id)
    .first<AnalysisRow>();
}

async function readAnalysisByWatchlistTemplate(db: D1Database, userId: string, watchlistId: string, templateId: string) {
  return db
    .prepare(
      `SELECT id, user_id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, status, title, score, verdict, summary, content_json, object_key, created_at, updated_at, started_at, completed_at, error_message
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

function compactTemplateEvidence(evidence: EvidenceBundle) {
  const facts = evidence.facts;
  const summary = optionalRecord(facts.summary);
  const eastmoney = optionalRecord(facts.eastmoney);
  const sec = optionalRecord(facts.sec);
  return {
    company: evidence.company,
    retrievedAt: evidence.retrievedAt,
    sources: evidence.evidence.map(({ title, source, freshness, notes }) => ({ title, source, freshness, notes })),
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

function normalizeGeneratedAnalysis(value: unknown, template: ResearchTemplate) {
  const record = isRecord(value) ? value : {};
  const markdown = stringValue(record.markdown) || stringValue(record.body);
  return {
    title: stringValue(record.title) || `${template.title}`,
    score: numberValue(record.score),
    verdict: stringValue(record.verdict) || "观察",
    summary: stringValue(record.summary) || "模型未提供摘要，需要重新生成。",
    keyPoints: stringArray(record.keyPoints),
    riskFlags: stringArray(record.riskFlags),
    followUps: stringArray(record.followUps),
    sections: markdownToSections(markdown),
    markdown: markdown || `# ${template.title}\n\n模型未提供正文，需要重新生成。`,
  };
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
  return message.includes("Rate limit exceeded") || message.includes("429") || message.includes("输出过短") || message.includes("超过 9 分钟") || /\b5\d\d\b/.test(message);
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
