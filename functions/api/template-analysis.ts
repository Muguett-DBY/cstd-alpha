import { jsonrepair } from "jsonrepair";
import type { InvestmentReport } from "../../src/shared/report";
import { FULL_ANALYSIS_TEMPLATE_ID, RESEARCH_TEMPLATES, researchTemplateById, type TemplateAnalysisResult } from "../../src/shared/user-research";
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

const MODEL = "deepseek-v4-flash-free";
const OPENCODE_ZEN_CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/v1/chat/completions";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const watchlistId = new URL(request.url).searchParams.get("watchlistId")?.trim();
  const filters = watchlistId ? "WHERE user_key = ?1 AND watchlist_id = ?2" : "WHERE user_key = ?1";
  const params = watchlistId ? [session.userKey, watchlistId] : [session.userKey];
  const result = await env.REPORT_LIBRARY_DB.prepare(
    `SELECT id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, title, score, verdict, summary, content_json, created_at, updated_at
     FROM template_analysis
     ${filters}
     ORDER BY updated_at DESC`,
  )
    .bind(...params)
    .all<AnalysisRow>();
  return json({ analyses: (result.results ?? []).map(analysisRowToResult), templates: RESEARCH_TEMPLATES });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const session = await requireUserSession(request, env);
    if (!session) return json({ error: "Unauthorized." }, 401);
    if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
    await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

    const body = (await request.json().catch(() => null)) as { watchlistId?: string; templateId?: string } | null;
    const watchlistId = body?.watchlistId?.trim();
    const templateId = body?.templateId?.trim() || FULL_ANALYSIS_TEMPLATE_ID;
    if (!watchlistId) return json({ error: "缺少自选股 ID。" }, 400);
    const watchlist = await readWatchlistRow(env.REPORT_LIBRARY_DB, session.userKey, watchlistId);
    if (!watchlist) return json({ error: "自选股不存在。" }, 404);

    const report = await readBestReport(env, watchlist);
    const template = templateId === FULL_ANALYSIS_TEMPLATE_ID ? null : researchTemplateById(templateId);
    if (templateId !== FULL_ANALYSIS_TEMPLATE_ID && !template) return json({ error: "未知模板。" }, 400);

    const generated = await generateTemplateAnalysis(watchlist, report, templateId);
    const now = new Date().toISOString();
    const id = await sha256(`${session.userKey}:${watchlistId}:${templateId}`);
    const result: TemplateAnalysisResult = {
      id,
      watchlistId,
      templateId,
      templateTitle: generated.templateTitle,
      companyName: watchlist.company_name,
      ticker: watchlist.ticker,
      market: watchlist.market,
      model: MODEL,
      title: generated.title,
      score: generated.score,
      verdict: generated.verdict,
      summary: generated.summary,
      keyPoints: generated.keyPoints,
      riskFlags: generated.riskFlags,
      followUps: generated.followUps,
      sections: generated.sections,
      createdAt: now,
      updatedAt: now,
    };

    await env.REPORT_LIBRARY_DB.prepare(
      `INSERT INTO template_analysis (
      id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, title, score, verdict, summary, content_json, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    ON CONFLICT(user_key, watchlist_id, template_id) DO UPDATE SET
      template_title = excluded.template_title,
      company_name = excluded.company_name,
      ticker = excluded.ticker,
      market = excluded.market,
      model = excluded.model,
      title = excluded.title,
      score = excluded.score,
      verdict = excluded.verdict,
      summary = excluded.summary,
      content_json = excluded.content_json,
      updated_at = excluded.updated_at`,
    )
      .bind(
        id,
        session.userKey,
        watchlistId,
        templateId,
        result.templateTitle,
        result.companyName,
        result.ticker,
        result.market,
        MODEL,
        result.title,
        result.score ?? null,
        result.verdict,
        result.summary,
        JSON.stringify({
          keyPoints: result.keyPoints,
          riskFlags: result.riskFlags,
          followUps: result.followUps,
          sections: result.sections,
        }),
        now,
        now,
      )
      .run();

    return json({ analysis: result, watchlistItem: watchlistRowToItem(watchlist) });
  } catch (error) {
    return json({ error: normalizeTemplateAnalysisError(error) }, 500);
  }
};

async function generateTemplateAnalysis(watchlist: WatchlistRow, report: InvestmentReport | null, templateId: string) {
  const templates = templateId === FULL_ANALYSIS_TEMPLATE_ID ? RESEARCH_TEMPLATES : [researchTemplateById(templateId)!];
  const response = await fetch(OPENCODE_ZEN_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: "max",
      thinking: { type: "enabled" },
      response_format: { type: "json_object" },
      stream: false,
      max_tokens: templateId === FULL_ANALYSIS_TEMPLATE_ID ? 9000 : 5200,
      messages: [
        {
          role: "system",
          content:
            "你是 CSTD Alpha 的长期股权研究助手。只返回一个合法 JSON 对象，不要 Markdown。结论必须严格、保守、站在小股东视角。不要编造没有证据的数据；缺失处写明需复核。",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              task:
                templateId === FULL_ANALYSIS_TEMPLATE_ID
                  ? "使用十个投资分析模板生成一份综合分析。每个模板至少形成一个独立章节，并给出综合结论。"
                  : "使用指定投资分析模板生成一份专项分析。",
              company: {
                name: watchlist.company_name,
                ticker: watchlist.ticker,
                market: watchlist.market,
              },
              templates: templates.map(({ id, title, focus, prompt }) => ({ id, title, focus, prompt })),
              existingDeepReport: report ? compactReport(report) : null,
              expectedOutputShape: {
                title: "报告标题",
                templateTitle: templateId === FULL_ANALYSIS_TEMPLATE_ID ? "十模板全面分析" : templates[0]?.title,
                score: "0-100 数字，可省略但建议给出",
                verdict: "买入/持有/观察/回避/减仓之一或简短中文结论",
                summary: "180-300 字总结",
                keyPoints: ["3-6 条主要得分点或正面判断"],
                riskFlags: ["3-6 条主要风险或反证条件"],
                followUps: ["3-6 条后续跟踪指标"],
                sections: [{ heading: "章节标题", body: "完整中文段落，必须引用已有深度报告中的事实或说明证据不足" }],
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`模板分析生成失败：${response.status} ${(await response.text()).slice(0, 300)}`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new Error("模型未返回模板分析内容。");
  return normalizeGeneratedAnalysis(JSON.parse(jsonrepair(content)), templateId, templates);
}

async function readBestReport(env: Env, watchlist: WatchlistRow): Promise<InvestmentReport | null> {
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) return null;
  const row = watchlist.report_library_id
    ? await readReportIndexRowById(env.REPORT_LIBRARY_DB, watchlist.report_library_id)
    : await readReportIndexRowByTicker(env.REPORT_LIBRARY_DB, watchlist.ticker, watchlist.market);
  if (!row?.object_key) return null;
  const object = await env.REPORT_LIBRARY_BUCKET.get(row.object_key);
  return object ? ((await object.json()) as InvestmentReport) : null;
}

async function readWatchlistRow(db: D1Database, userKey: string, id: string) {
  return db
    .prepare(
      `SELECT id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
       FROM user_watchlist
       WHERE user_key = ?1 AND id = ?2`,
    )
    .bind(userKey, id)
    .first<WatchlistRow>();
}

async function readReportIndexRowById(db: D1Database, id: string) {
  return db.prepare(`SELECT object_key FROM report_library WHERE id = ?1`).bind(id).first<{ object_key: string }>();
}

async function readReportIndexRowByTicker(db: D1Database, ticker: string, market: string) {
  return db.prepare(`SELECT object_key FROM report_library WHERE ticker = ?1 ORDER BY CASE WHEN market = ?2 THEN 0 ELSE 1 END, imported_at DESC LIMIT 1`).bind(ticker, market).first<{ object_key: string }>();
}

function normalizeGeneratedAnalysis(value: unknown, templateId: string, templates: typeof RESEARCH_TEMPLATES) {
  const record = isRecord(value) ? value : {};
  const sections = Array.isArray(record.sections)
    ? record.sections
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({ heading: stringValue(item.heading) || "分析", body: stringValue(item.body) || "模型未提供本节正文。" }))
    : [];
  return {
    title: stringValue(record.title) || `${templates[0]?.shortTitle ?? "模板"}分析`,
    templateTitle: stringValue(record.templateTitle) || (templateId === FULL_ANALYSIS_TEMPLATE_ID ? "十模板全面分析" : templates[0]?.title ?? "模板分析"),
    score: numberValue(record.score),
    verdict: stringValue(record.verdict) || "观察",
    summary: stringValue(record.summary) || "模型未提供摘要，需要重新生成。",
    keyPoints: stringArray(record.keyPoints),
    riskFlags: stringArray(record.riskFlags),
    followUps: stringArray(record.followUps),
    sections: sections.length ? sections : [{ heading: "分析", body: stringValue(record.body) || "模型未提供正文，需要重新生成。" }],
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

function normalizeTemplateAnalysisError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("FreeUsageLimitError") || message.includes("Rate limit exceeded")) {
    return "opencode 免费 Flash 通道当前触发限流，请稍后重试；自选股已保存，不会丢失。";
  }
  if (message.includes("429")) return "模板分析模型通道当前限流，请稍后重试。";
  return message || "模板分析生成失败。";
}
