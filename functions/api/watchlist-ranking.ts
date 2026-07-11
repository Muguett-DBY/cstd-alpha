import { fetchAndStoreCompanyEvidence, getOrCreateCompanyEvidencePackage } from "../_shared/company-evidence";
import {
  ensureUserResearchSchema,
  json,
  rankingRowToEntry,
  requireUserSession,
  watchlistRowToItem,
  type WatchlistRankingRow,
  type WatchlistRow,
} from "../_shared/user-research-db";
import {
  rankingCacheReusable,
  writeWatchlistRankingFailure,
  writeWatchlistRankingRunning,
} from "../_shared/watchlist-ranking";

type Env = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
  GITHUB_WATCHLIST_RANKING_DISPATCH_TOKEN?: string;
  GITHUB_TEMPLATE_DISPATCH_TOKEN?: string;
  GITHUB_RADAR_DISPATCH_TOKEN?: string;
  GITHUB_WATCHLIST_RANKING_REPOSITORY?: string;
  GITHUB_WATCHLIST_RANKING_WORKFLOW?: string;
};

const DEFAULT_REPOSITORY = "Muguett-DBY/cstd-alpha";
const DEFAULT_WORKFLOW = "watchlist-ranking.yml";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const [watchlistRows, scoreRows] = await Promise.all([readWatchlistRows(env.REPORT_LIBRARY_DB, session.userId), readRankingRows(env.REPORT_LIBRARY_DB, session.userId)]);
  const scores = new Map(scoreRows.map((row) => [row.watchlist_id, row]));
  const entries = watchlistRows
    .map((row) => rankingRowToEntry(scores.get(row.id) ?? pendingRow(row, session.userId), row))
    .sort((left, right) => (right.overallScore ?? -1) - (left.overallScore ?? -1) || left.companyName.localeCompare(right.companyName, "zh-CN"));
  return json({ entries, watchlist: watchlistRows.map(watchlistRowToItem) });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) return json({ error: "REPORT_LIBRARY_DB/REPORT_LIBRARY_BUCKET is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const watchlistId = stringValue(body?.watchlistId);
  const forceRefresh = body?.forceRefresh === true;
  const limit = boundedNumber(body?.limit, 20, 1, 80);
  const rows = await readWatchlistRows(env.REPORT_LIBRARY_DB, session.userId, watchlistId, limit);
  const queued: string[] = [];
  const reused: string[] = [];
  const failed: Array<{ watchlistId: string; error: string }> = [];

  const canRefreshEvidenceInline = forceRefresh && rows.length === 1;
  for (const row of rows) {
    try {
      const evidenceEnv = { REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB, REPORT_LIBRARY_BUCKET: env.REPORT_LIBRARY_BUCKET };
      const evidencePackage =
        canRefreshEvidenceInline
          ? await fetchAndStoreCompanyEvidence({ env: evidenceEnv, userId: session.userId, watchlist: row, signal: request.signal })
          : await getOrCreateCompanyEvidencePackage(evidenceEnv, session.userId, row, request.signal);
      const existing = await readRankingRow(env.REPORT_LIBRARY_DB, session.userId, row.id);
      if (rankingCacheReusable(existing, evidencePackage.materialHash || evidencePackage.evidenceHash, forceRefresh)) {
        reused.push(row.id);
        continue;
      }
      const jobId = await writeWatchlistRankingRunning(env.REPORT_LIBRARY_DB, session.userId, row, evidencePackage.materialHash || evidencePackage.evidenceHash);
      queued.push(jobId);
      context.waitUntil(
        dispatchWatchlistRankingWorkflow(env, jobId).catch(async (error) => {
          await writeWatchlistRankingFailure(env.REPORT_LIBRARY_DB!, session.userId, row.id, error, evidencePackage.materialHash || evidencePackage.evidenceHash);
        }),
      );
    } catch (error) {
      failed.push({ watchlistId: row.id, error: error instanceof Error ? error.message : "自选评分排队失败。" });
    }
  }

  const scoreRows = await readRankingRows(env.REPORT_LIBRARY_DB, session.userId);
  const scores = new Map(scoreRows.map((row) => [row.watchlist_id, row]));
  const entries = rows.map((row) => rankingRowToEntry(scores.get(row.id) ?? pendingRow(row, session.userId), row));
  return json({ entries, queued, reused, failed }, queued.length ? 202 : 200);
};

async function dispatchWatchlistRankingWorkflow(env: Env, jobId: string) {
  const token = env.GITHUB_WATCHLIST_RANKING_DISPATCH_TOKEN?.trim() || env.GITHUB_TEMPLATE_DISPATCH_TOKEN?.trim() || env.GITHUB_RADAR_DISPATCH_TOKEN?.trim();
  if (!token) throw new Error("missing GitHub watchlist ranking dispatch token");
  const repository = env.GITHUB_WATCHLIST_RANKING_REPOSITORY?.trim() || DEFAULT_REPOSITORY;
  const workflow = env.GITHUB_WATCHLIST_RANKING_WORKFLOW?.trim() || DEFAULT_WORKFLOW;
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "CSTDAlphaWatchlistRanking/1.0",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId } }),
  });
  if (!response.ok) throw new Error(`GitHub watchlist ranking dispatch failed: ${response.status}`);
}

async function readWatchlistRows(db: D1Database, userId: string, watchlistId?: string, limit = 200) {
  const params: unknown[] = [userId];
  let where = "WHERE user_key = ?1";
  if (watchlistId?.trim()) {
    params.push(watchlistId.trim());
    where += ` AND id = ?${params.length}`;
  }
  params.push(limit);
  const result = await db
    .prepare(
      `SELECT id, user_id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
       FROM user_watchlist
       ${where}
       ORDER BY added_at DESC
       LIMIT ?${params.length}`,
    )
    .bind(...params)
    .all<WatchlistRow>();
  return result.results ?? [];
}

async function readRankingRows(db: D1Database, userId: string) {
  const result = await db
    .prepare(
      `SELECT id, user_key, watchlist_id, company_name, ticker, market, status, model, company_quality_score, investment_attractiveness_score, overall_score, verdict, summary, content_json, evidence_hash, created_at, updated_at, started_at, completed_at, error_message
       FROM watchlist_ranking_score
       WHERE user_key = ?1`,
    )
    .bind(userId)
    .all<WatchlistRankingRow>();
  return result.results ?? [];
}

async function readRankingRow(db: D1Database, userId: string, watchlistId: string) {
  return db
    .prepare(
      `SELECT id, user_key, watchlist_id, company_name, ticker, market, status, model, company_quality_score, investment_attractiveness_score, overall_score, verdict, summary, content_json, evidence_hash, created_at, updated_at, started_at, completed_at, error_message
       FROM watchlist_ranking_score
       WHERE user_key = ?1 AND watchlist_id = ?2`,
    )
    .bind(userId, watchlistId)
    .first<WatchlistRankingRow>();
}

function pendingRow(row: WatchlistRow, userId: string): WatchlistRankingRow {
  const now = new Date().toISOString();
  return {
    id: `${userId}:${row.id}:pending`,
    user_key: userId,
    watchlist_id: row.id,
    company_name: row.company_name,
    ticker: row.ticker,
    market: row.market,
    status: "pending",
    model: null,
    company_quality_score: null,
    investment_attractiveness_score: null,
    overall_score: null,
    verdict: "待评分",
    summary: "尚未基于证据包生成自选股排行评分。",
    content_json: JSON.stringify({ keyPoints: [], riskFlags: [] }),
    evidence_hash: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    error_message: null,
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === "number" ? value : NaN;
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}
