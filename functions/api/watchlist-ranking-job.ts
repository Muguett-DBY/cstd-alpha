import { getOrCreateCompanyEvidencePackage } from "../_shared/company-evidence";
import { ensureUserResearchSchema, json, type WatchlistRankingRow, type WatchlistRow } from "../_shared/user-research-db";
import { writeCompletedWatchlistRanking, writeWatchlistRankingFailure } from "../_shared/watchlist-ranking";

type Env = {
  WATCHLIST_RANKING_WORKER_TOKEN?: string;
  TEMPLATE_ANALYSIS_WORKER_TOKEN?: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

type CompleteBody = {
  jobId?: string;
  generated?: {
    companyQualityScore?: number;
    investmentAttractivenessScore?: number;
    overallScore?: number;
    verdict?: string;
    summary?: string;
    keyPoints?: string[];
    riskFlags?: string[];
    modelUsed?: string;
  };
  evidenceHash?: string;
  error?: string;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireWorkerAuth(request, env);
  if (auth) return auth;
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) return json({ error: "REPORT_LIBRARY_DB/REPORT_LIBRARY_BUCKET is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);
  const jobId = new URL(request.url).searchParams.get("jobId")?.trim();
  if (!jobId) return json({ error: "缺少自选排行任务 ID。" }, 400);
  const row = await readRankingRowById(env.REPORT_LIBRARY_DB, jobId);
  if (!row) return json({ error: "自选排行任务不存在。" }, 404);
  if (row.status !== "running") return json({ error: "自选排行任务不是运行中状态。" }, 409);
  const watchlist = await readWatchlistRow(env.REPORT_LIBRARY_DB, row.user_key, row.watchlist_id);
  if (!watchlist) return json({ error: "自选股不存在。" }, 404);
  const evidencePackage = await getOrCreateCompanyEvidencePackage(
    { REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB, REPORT_LIBRARY_BUCKET: env.REPORT_LIBRARY_BUCKET },
    row.user_key,
    watchlist,
    request.signal,
  );
  return json({
    job: row,
    userId: row.user_key,
    watchlist,
    evidenceHash: evidencePackage.materialHash || evidencePackage.evidenceHash,
    evidence: evidencePackage.evidence,
  });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireWorkerAuth(request, env);
  if (auth) return auth;
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);
  const body = (await request.json().catch(() => null)) as CompleteBody | null;
  const jobId = body?.jobId?.trim();
  if (!jobId) return json({ error: "缺少自选排行任务 ID。" }, 400);
  const row = await readRankingRowById(env.REPORT_LIBRARY_DB, jobId);
  if (!row) return json({ error: "自选排行任务不存在。" }, 404);
  const watchlist = await readWatchlistRow(env.REPORT_LIBRARY_DB, row.user_key, row.watchlist_id);
  if (!watchlist) return json({ error: "自选股不存在。" }, 404);
  if (body?.error) {
    await writeWatchlistRankingFailure(env.REPORT_LIBRARY_DB, row.user_key, row.watchlist_id, body.error, body.evidenceHash || row.evidence_hash || undefined);
    return json({ ok: true });
  }
  if (!body?.generated) return json({ error: "缺少自选排行评分结果。" }, 400);
  await writeCompletedWatchlistRanking(env.REPORT_LIBRARY_DB, row.user_key, watchlist, normalizeGenerated(body.generated), body.evidenceHash || row.evidence_hash || undefined);
  return json({ ok: true });
};

function normalizeGenerated(input: NonNullable<CompleteBody["generated"]>) {
  return {
    companyQualityScore: Number(input.companyQualityScore),
    investmentAttractivenessScore: Number(input.investmentAttractivenessScore),
    overallScore: Number(input.overallScore),
    verdict: String(input.verdict || "观察"),
    summary: String(input.summary || "已完成自选股排行评分。"),
    keyPoints: Array.isArray(input.keyPoints) ? input.keyPoints.map(String) : [],
    riskFlags: Array.isArray(input.riskFlags) ? input.riskFlags.map(String) : [],
    modelUsed: input.modelUsed || "deepseek-v4-flash",
  };
}

async function readRankingRowById(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT id, user_key, watchlist_id, company_name, ticker, market, status, model, company_quality_score, investment_attractiveness_score, overall_score, verdict, summary, content_json, evidence_hash, created_at, updated_at, started_at, completed_at, error_message
       FROM watchlist_ranking_score
       WHERE id = ?1`,
    )
    .bind(id)
    .first<WatchlistRankingRow>();
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

function requireWorkerAuth(request: Request, env: Env) {
  const expected = env.WATCHLIST_RANKING_WORKER_TOKEN?.trim() || env.TEMPLATE_ANALYSIS_WORKER_TOKEN?.trim();
  if (!expected) return json({ error: "WATCHLIST_RANKING_WORKER_TOKEN is not configured." }, 500);
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return actual && actual === expected ? null : json({ error: "Unauthorized." }, 401);
}
