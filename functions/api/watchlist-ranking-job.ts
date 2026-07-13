import { getOrCreateCompanyEvidencePackage } from "../_shared/company-evidence";
import { ensureUserResearchSchema, json, type WatchlistRankingRow, type WatchlistRow } from "../_shared/user-research-db";
import { hasRequiredRankingScores, normalizeGeneratedRanking, writeCompletedWatchlistRanking, writeWatchlistRankingFailure } from "../_shared/watchlist-ranking";

type Env = {
  WATCHLIST_RANKING_WORKER_TOKEN?: string;
  TEMPLATE_ANALYSIS_WORKER_TOKEN?: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

type CompleteBody = {
  jobId?: string;
  runToken?: string;
  generated?: unknown;
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
  const runToken = new URL(request.url).searchParams.get("runToken")?.trim();
  if (!isValidRunToken(runToken)) return json({ error: "缺少自选排行运行令牌。" }, 400);
  const row = await readRankingRowById(env.REPORT_LIBRARY_DB, jobId);
  if (!row) return json({ error: "自选排行任务不存在。" }, 404);
  if (!isCurrentRun(row, runToken)) return staleRunResponse();
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
  const jobId = stringValue(body?.jobId);
  if (!jobId) return json({ error: "缺少自选排行任务 ID。" }, 400);
  const runToken = stringValue(body?.runToken);
  if (!isValidRunToken(runToken)) return json({ error: "缺少自选排行运行令牌。" }, 400);
  const row = await readRankingRowById(env.REPORT_LIBRARY_DB, jobId);
  if (!row) return json({ error: "自选排行任务不存在。" }, 404);
  if (!isCurrentRun(row, runToken)) return staleRunResponse();
  const watchlist = await readWatchlistRow(env.REPORT_LIBRARY_DB, row.user_key, row.watchlist_id);
  if (!watchlist) return json({ error: "自选股不存在。" }, 404);
  const evidenceHash = stringValue(body?.evidenceHash) || row.evidence_hash || undefined;
  const error = stringValue(body?.error);
  if (!error && (!isPlainRecord(body?.generated) || !hasRequiredRankingScores(body.generated))) {
    return json({ error: "自选排行评分结果缺少有效的公司质量分或投资吸引力分。" }, 422);
  }
  const finalizingToken = await claimRankingRun(env.REPORT_LIBRARY_DB, jobId, runToken);
  if (!finalizingToken) return staleRunResponse();
  if (error) {
    const applied = await writeWatchlistRankingFailure(env.REPORT_LIBRARY_DB, row.user_key, row.watchlist_id, error, evidenceHash, finalizingToken);
    if (!applied) return staleRunResponse();
    return json({ ok: true });
  }
  const applied = await writeCompletedWatchlistRanking(env.REPORT_LIBRARY_DB, row.user_key, watchlist, normalizeGeneratedRanking(body?.generated), evidenceHash, finalizingToken);
  if (!applied) return staleRunResponse();
  return json({ ok: true });
};

async function readRankingRowById(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT id, user_key, watchlist_id, company_name, ticker, market, status, model, company_quality_score, investment_attractiveness_score, overall_score, verdict, summary, content_json, evidence_hash, created_at, updated_at, started_at, completed_at, error_message, run_token
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

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRunToken(value: string | null | undefined): value is string {
  return Boolean(value && value.length <= 100);
}

function isCurrentRun(row: WatchlistRankingRow, runToken: string) {
  return row.status === "running" && row.run_token === runToken;
}

async function claimRankingRun(db: D1Database, jobId: string, runToken: string) {
  const finalizingToken = `finalizing:${runToken}`;
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE watchlist_ranking_score
       SET run_token = ?1, updated_at = ?2
       WHERE id = ?3 AND status = 'running' AND run_token = ?4`,
    )
    .bind(finalizingToken, now, jobId, runToken)
    .run();
  return (result.meta?.changes ?? 1) > 0 ? finalizingToken : null;
}

function staleRunResponse() {
  return json({ error: "自选排行任务运行已更新，本次回调已忽略。" }, 409);
}
