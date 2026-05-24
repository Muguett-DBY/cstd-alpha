import type { ResearchTemplate, TemplateAnalysisResult } from "../../src/shared/user-research";
import {
  analysisRowToResult,
  ensureUserResearchSchema,
  json,
  readUserResearchTemplates,
  type AnalysisRow,
  type WatchlistRow,
} from "../_shared/user-research-db";
import {
  fetchTemplateEvidence,
  fullAnalysisTemplate,
  normalizeGeneratedAnalysis,
  templateEvidenceCacheHash,
  templateVersionHash,
  writeAnalysisFailure,
  writeCompletedAnalysis,
} from "./template-analysis";

type Env = {
  TEMPLATE_ANALYSIS_WORKER_TOKEN?: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

type CompleteBody = {
  jobId?: string;
  generated?: ReturnType<typeof normalizeGeneratedAnalysis> & { modelUsed?: string };
  markdown?: string;
  error?: string;
  evidenceHash?: string;
  childResults?: Array<{ templateId?: string; generated?: ReturnType<typeof normalizeGeneratedAnalysis> & { modelUsed?: string }; markdown?: string; evidenceHash?: string }>;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireWorkerAuth(request, env);
  if (auth) return auth;
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) return json({ error: "REPORT_LIBRARY_DB/REPORT_LIBRARY_BUCKET is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId")?.trim();
  if (!jobId) return json({ error: "缺少模板任务 ID。" }, 400);
  const row = await readAnalysisRowById(env.REPORT_LIBRARY_DB, jobId);
  if (!row) return json({ error: "模板任务不存在。" }, 404);
  const analysis = analysisRowToResult(row);
  if (analysis.status !== "running") return json({ error: "模板任务不是运行中状态。" }, 409);

  const watchlist = await readWatchlistRowForJob(env.REPORT_LIBRARY_DB, row.user_key, row.watchlist_id);
  if (!watchlist) return json({ error: "自选股不存在。" }, 404);
  const templates = await readUserResearchTemplates(env.REPORT_LIBRARY_DB, row.user_key);
  const activeTemplates = templates.filter((template) => template.enabled !== false);
  const resolved = resolveTemplateForJob(row, activeTemplates, analysis.templateSnapshot);
  if (!resolved.template) return json({ error: "模板不存在或未启用。" }, 404);
  if (resolved.stale) {
    const failed = await writeAnalysisFailure(
      env.REPORT_LIBRARY_DB,
      row.user_key,
      watchlist,
      resolved.template,
      "模板已删除或未启用，后台任务已取消。",
      "failed",
      row.started_at || row.updated_at,
      row.evidence_hash || undefined,
    );
    return json({ cancelled: true, error: "模板已删除或未启用，后台任务已取消。", analysis: failed }, 410);
  }
  const template = resolved.template;

  const evidencePackage = await fetchTemplateEvidence(env, row.user_key, watchlist, request.signal);
  const evidenceHash = templateEvidenceCacheHash(evidencePackage);
  const childAnalyses =
    row.template_id === "__full_analysis__"
      ? await readCompletedChildren(env, row.user_key, watchlist.id, activeTemplates, evidenceHash)
      : [];

  return json({
    job: analysis,
    userId: row.user_key,
    watchlist,
    template,
    activeTemplates,
    evidenceHash,
    evidence: evidencePackage.evidence,
    childAnalyses,
  });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireWorkerAuth(request, env);
  if (auth) return auth;
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) return json({ error: "REPORT_LIBRARY_DB/REPORT_LIBRARY_BUCKET is not configured." }, 500);
  const storageEnv = { REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB, REPORT_LIBRARY_BUCKET: env.REPORT_LIBRARY_BUCKET };
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const body = (await request.json().catch(() => null)) as CompleteBody | null;
  const jobId = body?.jobId?.trim();
  if (!jobId) return json({ error: "缺少模板任务 ID。" }, 400);
  const row = await readAnalysisRowById(env.REPORT_LIBRARY_DB, jobId);
  if (!row) return json({ error: "模板任务不存在。" }, 404);
  const watchlist = await readWatchlistRowForJob(env.REPORT_LIBRARY_DB, row.user_key, row.watchlist_id);
  if (!watchlist) return json({ error: "自选股不存在。" }, 404);
  const templates = await readUserResearchTemplates(env.REPORT_LIBRARY_DB, row.user_key);
  const activeTemplates = templates.filter((template) => template.enabled !== false);
  const resolved = resolveTemplateForJob(row, activeTemplates, analysisRowToResult(row).templateSnapshot);
  if (!resolved.template) return json({ error: "模板不存在或未启用。" }, 404);
  const template = resolved.template;

  const evidenceHash = body?.evidenceHash || row.evidence_hash || undefined;
  const startedAt = row.started_at || row.updated_at || new Date().toISOString();
  const childResults = Array.isArray(body?.childResults) ? body.childResults : [];
  for (const child of childResults) {
    const childTemplate = activeTemplates.find((item) => item.id === child.templateId);
    if (!childTemplate || !child.generated) continue;
    await persistGenerated(storageEnv, row.user_key, watchlist, childTemplate, child.generated, child.markdown || child.generated.markdown, startedAt, child.evidenceHash || evidenceHash);
  }

  if (body?.error) {
    const failed = await writeAnalysisFailure(env.REPORT_LIBRARY_DB, row.user_key, watchlist, template, body.error, "failed_retryable", startedAt, evidenceHash);
    return json({ analysis: failed });
  }
  if (resolved.stale) {
    const failed = await writeAnalysisFailure(env.REPORT_LIBRARY_DB, row.user_key, watchlist, template, "模板已删除或未启用，后台任务已取消。", "failed", startedAt, evidenceHash);
    return json({ cancelled: true, analysis: failed });
  }
  if (!body?.generated) return json({ error: "缺少模板生成结果。" }, 400);
  const analysis = await persistGenerated(storageEnv, row.user_key, watchlist, template, body.generated, body.markdown || body.generated.markdown, startedAt, evidenceHash);
  return json({ analysis });
};

async function persistGenerated(
  env: Required<Pick<Env, "REPORT_LIBRARY_DB" | "REPORT_LIBRARY_BUCKET">>,
  userId: string,
  watchlist: WatchlistRow,
  template: ResearchTemplate,
  generated: ReturnType<typeof normalizeGeneratedAnalysis> & { modelUsed?: string },
  markdown: string,
  startedAt: string,
  evidenceHash?: string,
) {
  const templateHash = await templateVersionHash(template);
  const objectKey = `user-research/v1/${userId}/${watchlist.id}/${template.id}-${templateHash.slice(0, 12)}.md`;
  const completedAt = new Date().toISOString();
  await env.REPORT_LIBRARY_BUCKET.put(objectKey, markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { templateId: template.id, templateHash, ticker: watchlist.ticker },
  });
  return writeCompletedAnalysis(env.REPORT_LIBRARY_DB, userId, watchlist, template, { ...generated, markdown }, objectKey, startedAt, completedAt, evidenceHash);
}

function resolveTemplateForJob(row: AnalysisRow, activeTemplates: ResearchTemplate[], snapshot?: ResearchTemplate) {
  if (row.template_id === "__full_analysis__") return { template: fullAnalysisTemplate(activeTemplates), stale: false };
  const active = activeTemplates.find((item) => item.id === row.template_id && item.enabled !== false);
  if (active) return { template: active, stale: false };
  if (snapshot?.id === row.template_id) return { template: snapshot, stale: true };
  return { template: fallbackTemplateFromRow(row), stale: true };
}

function fallbackTemplateFromRow(row: AnalysisRow): ResearchTemplate {
  const title = row.template_title || "已删除模板";
  return {
    id: row.template_id,
    title,
    shortTitle: title,
    focus: "该模板已删除或未启用，后台任务只用于取消状态落库。",
    prompt: "",
    fullPrompt: "",
    enabled: false,
  };
}

async function readCompletedChildren(env: Env, userId: string, watchlistId: string, templates: ResearchTemplate[], evidenceHash: string) {
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) return [];
  const results: TemplateAnalysisResult[] = [];
  for (const template of templates) {
    const hash = await templateVersionHash(template);
    const row = await readAnalysisByWatchlistTemplate(env.REPORT_LIBRARY_DB, userId, watchlistId, template.id);
    if (row?.status !== "completed" || row.template_hash !== hash || row.evidence_hash !== evidenceHash || !row.object_key) continue;
    const analysis = analysisRowToResult(row);
    const object = await env.REPORT_LIBRARY_BUCKET.get(row.object_key);
    results.push(object ? { ...analysis, markdown: await object.text() } : analysis);
  }
  return results;
}

async function readAnalysisRowById(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT id, user_id, user_key, watchlist_id, template_id, template_title, company_name, ticker, market, model, status, title, score, verdict, summary, content_json, object_key, created_at, updated_at, started_at, completed_at, error_message, template_hash, evidence_hash, template_snapshot_json
       FROM template_analysis
       WHERE id = ?1`,
    )
    .bind(id)
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

async function readWatchlistRowForJob(db: D1Database, userId: string, id: string) {
  return db
    .prepare(
      `SELECT id, user_id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
       FROM user_watchlist
       WHERE user_key = ?1 AND id = ?2`,
    )
    .bind(userId, id)
    .first<WatchlistRow>();
}

function requireWorkerAuth(request: Request, env: Env) {
  const expected = env.TEMPLATE_ANALYSIS_WORKER_TOKEN?.trim();
  if (!expected) return json({ error: "TEMPLATE_ANALYSIS_WORKER_TOKEN is not configured." }, 500);
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return actual && actual === expected ? null : json({ error: "Unauthorized." }, 401);
}
