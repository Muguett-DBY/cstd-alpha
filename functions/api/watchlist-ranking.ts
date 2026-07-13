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
  rankingRefreshAlreadyRunning,
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

type RankingRefreshParams = {
  watchlistId: string;
  forceRefresh: boolean;
  limit: number;
};

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

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

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = parseRankingRefreshParams(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { watchlistId, forceRefresh, limit } = parsed.value;
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const rows = await readWatchlistRows(env.REPORT_LIBRARY_DB, session.userId, watchlistId, limit);
  const queued: string[] = [];
  const reused: string[] = [];
  const failed: Array<{ watchlistId: string; error: string }> = [];

  const canRefreshEvidenceInline = forceRefresh && rows.length === 1;
  for (const row of rows) {
    try {
      const existing = await readRankingRow(env.REPORT_LIBRARY_DB, session.userId, row.id);
      if (rankingRefreshAlreadyRunning(existing)) {
        reused.push(row.id);
        continue;
      }
      const evidenceEnv = { REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB, REPORT_LIBRARY_BUCKET: env.REPORT_LIBRARY_BUCKET };
      const evidencePackage =
        canRefreshEvidenceInline
          ? await fetchAndStoreCompanyEvidence({ env: evidenceEnv, userId: session.userId, watchlist: row, signal: request.signal })
          : await getOrCreateCompanyEvidencePackage(evidenceEnv, session.userId, row, request.signal);
      if (rankingCacheReusable(existing, evidencePackage.materialHash || evidencePackage.evidenceHash, forceRefresh)) {
        reused.push(row.id);
        continue;
      }
      const { jobId, runToken } = await writeWatchlistRankingRunning(env.REPORT_LIBRARY_DB, session.userId, row, evidencePackage.materialHash || evidencePackage.evidenceHash);
      queued.push(jobId);
      context.waitUntil(
        dispatchWatchlistRankingWorkflow(env, jobId, runToken).catch(async (error) => {
          await writeWatchlistRankingFailure(env.REPORT_LIBRARY_DB!, session.userId, row.id, error, evidencePackage.materialHash || evidencePackage.evidenceHash, runToken);
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

async function dispatchWatchlistRankingWorkflow(env: Env, jobId: string, runToken: string) {
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
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId, run_token: runToken } }),
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
      `SELECT id, user_key, watchlist_id, company_name, ticker, market, status, model, company_quality_score, investment_attractiveness_score, overall_score, verdict, summary, content_json, evidence_hash, created_at, updated_at, started_at, completed_at, error_message, run_token
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
      `SELECT id, user_key, watchlist_id, company_name, ticker, market, status, model, company_quality_score, investment_attractiveness_score, overall_score, verdict, summary, content_json, evidence_hash, created_at, updated_at, started_at, completed_at, error_message, run_token
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

function parseRankingRefreshParams(body: Record<string, unknown> | null): ParseResult<RankingRefreshParams> {
  if (body !== null && !isPlainRecord(body)) return { ok: false, error: "请求参数格式不正确。" };
  const watchlistId = optionalStringParam(body, "watchlistId", "watchlistId");
  if (!watchlistId.ok) return watchlistId;
  const forceRefresh = optionalBooleanParam(body, "forceRefresh", "forceRefresh", false);
  if (!forceRefresh.ok) return forceRefresh;
  const limit = optionalBoundedNumberParam(body, "limit", "limit", 20, 1, 80);
  if (!limit.ok) return limit;
  return { ok: true, value: { watchlistId: watchlistId.value, forceRefresh: forceRefresh.value, limit: limit.value } };
}

function optionalStringParam(body: Record<string, unknown> | null, key: string, label: string): ParseResult<string> {
  if (!hasParam(body, key)) return { ok: true, value: "" };
  const value = body?.[key];
  if (value === undefined || value === null || value === "") return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, error: `${label} 参数格式不正确。` };
  return { ok: true, value: value.trim() };
}

function optionalBooleanParam(body: Record<string, unknown> | null, key: string, label: string, fallback: boolean): ParseResult<boolean> {
  if (!hasParam(body, key)) return { ok: true, value: fallback };
  const value = body?.[key];
  if (value === undefined || value === null || value === "") return { ok: true, value: fallback };
  if (typeof value !== "boolean") return { ok: false, error: `${label} 参数格式不正确。` };
  return { ok: true, value };
}

function optionalBoundedNumberParam(body: Record<string, unknown> | null, key: string, label: string, fallback: number, min: number, max: number): ParseResult<number> {
  if (!hasParam(body, key)) return { ok: true, value: fallback };
  const value = body?.[key];
  if (value === undefined || value === null || value === "") return { ok: true, value: fallback };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: `${label} 参数格式不正确。` };
  return { ok: true, value: Math.min(Math.max(value, min), max) };
}

function hasParam(body: Record<string, unknown> | null, key: string) {
  return isPlainRecord(body) && Object.prototype.hasOwnProperty.call(body, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
