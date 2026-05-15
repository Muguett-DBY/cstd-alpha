import { jsonrepair } from "jsonrepair";
import type { InvestmentReport } from "../../src/shared/report";
import {
  FULL_ANALYSIS_TEMPLATE_ID,
  RESEARCH_TEMPLATES,
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
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

type DurableTemplateEnv = {
  REPORT_LIBRARY_DB: D1Database;
  REPORT_LIBRARY_BUCKET: R2Bucket;
};

type GenerateBody = {
  watchlistId?: string;
  templateId?: string;
  forceRefresh?: boolean;
};

const MODEL = "deepseek-v4-flash-free";
const OPENCODE_ZEN_CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/v1/chat/completions";
const TEMPLATE_REPORT_PREFIX = "user-research/v1";
const MIN_TEMPLATE_MARKDOWN_CHARS = 6000;
const MIN_FULL_MARKDOWN_CHARS = 5000;
const MODEL_REQUEST_TIMEOUT_MS = 240_000;

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

  const report = await readBestReport(env, watchlist);
  if (!report) {
    return json({ error: "请先生成或打开该公司的基础深度评分报告；十模板分析必须基于已有深度报告和公开证据，不能只凭公司名称生成。" }, 409);
  }
  const durableEnv = { REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB, REPORT_LIBRARY_BUCKET: env.REPORT_LIBRARY_BUCKET };
  if (templateId === FULL_ANALYSIS_TEMPLATE_ID) {
    const analyses = await generateFullAnalysis(durableEnv, session.userId, watchlist, report, Boolean(body?.forceRefresh));
    return json({ analyses, watchlistItem: watchlistRowToItem(watchlist) });
  }

  const template = researchTemplateById(templateId);
  if (!template) return json({ error: "未知模板。" }, 400);
  const analysis = await generateSingleTemplateAnalysis(durableEnv, session.userId, watchlist, report, template, Boolean(body?.forceRefresh));
  return json({ analysis, watchlistItem: watchlistRowToItem(watchlist) });
};

async function generateFullAnalysis(env: DurableTemplateEnv, userId: string, watchlist: WatchlistRow, report: InvestmentReport | null, forceRefresh: boolean) {
  const children: TemplateAnalysisResult[] = [];
  for (const template of RESEARCH_TEMPLATES) {
    children.push(await generateSingleTemplateAnalysis(env, userId, watchlist, report, template, false));
  }
  const fullTemplate: ResearchTemplate = {
    id: FULL_ANALYSIS_TEMPLATE_ID,
    title: "十模板全面分析",
    shortTitle: "全面分析",
    focus: "整合十个深度模板的核心判断，形成最终投资结论、关键分歧、反证条件和账户动作。",
    prompt: "整合十个模板专项报告，输出最终综合结论。",
    fullPrompt: "请阅读十个模板专项报告，进行交叉验证，保留分歧，输出最终综合结论、评分、风险反证和仓位规则。",
  };
  const completedChildren = children.filter((item) => item.status === "completed");
  if (completedChildren.length < RESEARCH_TEMPLATES.length) {
    return [
      await writeAnalysisFailure(env.REPORT_LIBRARY_DB, userId, watchlist, fullTemplate, "十个模板尚未全部完成，全面分析暂不可生成。", "failed_retryable"),
      ...children,
    ];
  }
  return [await generateSingleTemplateAnalysis(env, userId, watchlist, report, fullTemplate, forceRefresh, completedChildren), ...children];
}

async function generateSingleTemplateAnalysis(
  env: DurableTemplateEnv,
  userId: string,
  watchlist: WatchlistRow,
  report: InvestmentReport | null,
  template: ResearchTemplate,
  forceRefresh: boolean,
  childAnalyses: TemplateAnalysisResult[] = [],
) {
  const id = await analysisId(userId, watchlist.id, template.id);
  const existing = await readAnalysisRow(env.REPORT_LIBRARY_DB, userId, id);
  if (existing && existing.status === "completed" && existing.object_key && !forceRefresh) {
    return { ...(await hydrateMarkdown(env, analysisRowToResult(existing))), fromCache: true };
  }

  await writeAnalysisStatus(env.REPORT_LIBRARY_DB, userId, watchlist, template, "running");
  const startedAt = new Date().toISOString();
  try {
    const generated = await requestTemplateReport(watchlist, report, template, childAnalyses);
    const objectKey = `${TEMPLATE_REPORT_PREFIX}/${userId}/${watchlist.id}/${template.id}.md`;
    await env.REPORT_LIBRARY_BUCKET.put(objectKey, generated.markdown, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { templateId: template.id, ticker: watchlist.ticker },
    });
    const completedAt = new Date().toISOString();
    const result = await writeCompletedAnalysis(env.REPORT_LIBRARY_DB, userId, watchlist, template, generated, objectKey, startedAt, completedAt);
    return { ...result, markdown: generated.markdown };
  } catch (error) {
    return writeAnalysisFailure(env.REPORT_LIBRARY_DB, userId, watchlist, template, normalizeTemplateAnalysisError(error), isRetryableError(error) ? "failed_retryable" : "failed", startedAt);
  }
}

async function requestTemplateReport(watchlist: WatchlistRow, report: InvestmentReport | null, template: ResearchTemplate, childAnalyses: TemplateAnalysisResult[]) {
  const first = await requestTemplateReportOnce(watchlist, report, template, childAnalyses);
  const minLength = minimumMarkdownLength(template);
  if (first.markdown.length >= minLength) return first;
  const expanded = await requestTemplateReportOnce(watchlist, report, template, childAnalyses, first.markdown);
  if (expanded.markdown.length >= minLength) return expanded;
  throw new Error(`模型输出过短：${expanded.markdown.length}/${minLength} 字符，未保存为成功报告。`);
}

async function requestTemplateReportOnce(
  watchlist: WatchlistRow,
  report: InvestmentReport | null,
  template: ResearchTemplate,
  childAnalyses: TemplateAnalysisResult[],
  draftToExpand?: string,
) {
  const minLength = minimumMarkdownLength(template);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("model-timeout"), MODEL_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(OPENCODE_ZEN_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        reasoning_effort: "max",
        thinking: { type: "enabled" },
        response_format: { type: "json_object" },
        stream: false,
        max_tokens: template.id === FULL_ANALYSIS_TEMPLATE_ID ? 20000 : 24000,
        messages: [
          {
            role: "system",
            content:
              "你是 CSTD Alpha 的长期股权深度研究员。只返回合法 JSON，不要 Markdown 包裹。报告正文必须是完整中文 Markdown。结论严格、保守、站在小股东视角；不得编造无证据数据，缺失处明确写需复核。正文不足最低字数视为失败。",
          },
          {
            role: "user",
            content: JSON.stringify({
              task:
                draftToExpand
                  ? `上一次 Markdown 正文过短。请在不改变结论方向的前提下扩写为真正深度报告，正文至少 ${minLength} 个中文字符，必须补足证据链、推理链、反证条件、估值/仓位规则和待复核清单。`
                  : template.id === FULL_ANALYSIS_TEMPLATE_ID
                    ? `基于十个专项模板报告生成最终全面分析。要求交叉验证、指出分歧、形成最终结论。Markdown 正文至少 ${minLength} 个中文字符。`
                    : `严格按完整模板原文生成一份超级深度专项报告。不是摘要，不是短 JSON。Markdown 正文至少 ${minLength} 个中文字符，并包含模板要求的所有关键模块。`,
              company: { name: watchlist.company_name, ticker: watchlist.ticker, market: watchlist.market },
              template: { id: template.id, title: template.title, fullPrompt: template.fullPrompt },
              existingDeepReport: report ? compactReport(report) : null,
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
                markdown: `完整中文 Markdown 深度报告，使用二级/三级标题，必须覆盖模板原文要求；需要有证据、推理、反证、结论和仓位/动作建议。最低 ${minLength} 个中文字符，不足则不要结束。`,
              },
            }),
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`模板分析生成失败：${response.status} ${(await response.text()).slice(0, 500)}`);
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content?.trim()) throw new Error("模型未返回模板分析内容。");
    return normalizeGeneratedAnalysis(JSON.parse(jsonrepair(content)), template);
  } catch (error) {
    if (isAbortLikeError(error)) throw new Error("模板分析模型请求超过 4 分钟未返回，已标记为可重试失败。", { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function minimumMarkdownLength(template: ResearchTemplate) {
  return template.id === FULL_ANALYSIS_TEMPLATE_ID ? MIN_FULL_MARKDOWN_CHARS : MIN_TEMPLATE_MARKDOWN_CHARS;
}

async function writeCompletedAnalysis(
  db: D1Database,
  userId: string,
  watchlist: WatchlistRow,
  template: ResearchTemplate,
  generated: ReturnType<typeof normalizeGeneratedAnalysis>,
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
    model: MODEL,
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
  const result = baseAnalysis(userId, watchlist, template, status, now);
  await upsertAnalysis(db, result, JSON.stringify({ keyPoints: [], riskFlags: [], followUps: [], sections: [] }), null);
  return result;
}

async function writeAnalysisFailure(db: D1Database, userId: string, watchlist: WatchlistRow, template: ResearchTemplate, errorMessage: string, status: TemplateAnalysisStatus, startedAt?: string) {
  const now = new Date().toISOString();
  const result = { ...baseAnalysis(userId, watchlist, template, status, now), errorMessage, startedAt, completedAt: now, summary: errorMessage };
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
    model: MODEL,
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
      MODEL,
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
      ? await readReportIndexRowById(env.REPORT_LIBRARY_DB, watchlist.report_library_id)
      : await readReportIndexRowByTicker(env.REPORT_LIBRARY_DB, watchlist.ticker, watchlist.market);
    if (!row?.object_key) return null;
    const object = await env.REPORT_LIBRARY_BUCKET.get(row.object_key);
    return object ? ((await object.json()) as InvestmentReport) : null;
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) return null;
    throw error;
  }
}

async function readReportIndexRowById(db: D1Database, id: string) {
  return db.prepare(`SELECT object_key FROM report_library WHERE id = ?1`).bind(id).first<{ object_key: string }>();
}

async function readReportIndexRowByTicker(db: D1Database, ticker: string, market: string) {
  return db.prepare(`SELECT object_key FROM report_library WHERE ticker = ?1 ORDER BY CASE WHEN market = ?2 THEN 0 ELSE 1 END, imported_at DESC LIMIT 1`).bind(ticker, market).first<{ object_key: string }>();
}

async function analysisId(userId: string, watchlistId: string, templateId: string) {
  return sha256(`${userId}:${watchlistId}:${templateId}`);
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

function compactReport(report: InvestmentReport) {
  return {
    company: report.company,
    asOf: report.asOf,
    cqs: report.cqs,
    ias: report.ias,
    conclusion: report.conclusion,
    oneSentence: report.oneSentence,
    summaryDashboard: report.summaryDashboard,
    valuationAnalysis: report.valuationAnalysis,
    financialTenYear: report.financialTenYear,
    scoreItems20: report.scoreItems20.map(({ title, score, label, reason, evidence, deductions, recentChange }) => ({
      title,
      score,
      label,
      reason,
      evidence,
      deductions,
      recentChange,
    })),
    sections: report.sections,
    evidence: report.evidence.map(({ title, source, freshness, notes }) => ({ title, source, freshness, notes })),
  };
}

function normalizeTemplateAnalysisError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("FreeUsageLimitError") || message.includes("Rate limit exceeded")) {
    return "opencode 免费 Flash 通道当前触发限流，请稍后重试；任务已保存为可重试失败。";
  }
  if (message.includes("429")) return "模板分析模型通道当前限流，请稍后重试。";
  return message || "模板分析生成失败。";
}

function isRetryableError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return message.includes("FreeUsageLimitError") || message.includes("Rate limit exceeded") || message.includes("429") || message.includes("输出过短") || message.includes("超过 4 分钟") || /\b5\d\d\b/.test(message);
}

function isAbortLikeError(error: unknown) {
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
