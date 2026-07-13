import {
  fetchAndStoreCompanyEvidence,
  writeCompanyEvidenceFailure,
} from "../_shared/company-evidence";
import {
  ensureUserResearchSchema,
  json,
  normalizeCompany,
  requireUserSession,
  sha256,
  watchlistRowToItem,
  type WatchlistRankingRow,
  type WatchlistRow,
} from "../_shared/user-research-db";
import { rankingRefreshAlreadyRunning, writeWatchlistRankingFailure, writeWatchlistRankingRunning } from "../_shared/watchlist-ranking";

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

  const result = await env.REPORT_LIBRARY_DB.prepare(
    `SELECT id, user_id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
     FROM user_watchlist
     WHERE user_key = ?1
     ORDER BY added_at DESC`,
  )
    .bind(session.userId)
    .all<WatchlistRow>();
  return json({ items: (result.results ?? []).map(watchlistRowToItem), user: { userId: session.userId, username: session.username, displayName: session.displayName, role: session.role } });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const company = normalizeCompany(body?.company);
  if (!company) return json({ error: "公司信息不完整，无法加入自选。" }, 400);
  const reportLibraryId = stringValue(body?.reportLibraryId);

  const now = new Date().toISOString();
  const id = await sha256(`${session.userId}:${company.listingPlace}:${company.code}`);
  const existingRow = await readWatchlistRowBySymbol(env.REPORT_LIBRARY_DB, session.userId, company.code, company.listingPlace);
  const status = existingRow ? "updated" : "created";
  await env.REPORT_LIBRARY_DB.prepare(
    `INSERT INTO user_watchlist (
      id, user_id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    ON CONFLICT(user_key, ticker, market) DO UPDATE SET
      user_id = excluded.user_id,
      company_name = excluded.company_name,
      exchange_name = excluded.exchange_name,
      listing_place = excluded.listing_place,
      market_type = excluded.market_type,
      source = excluded.source,
      report_library_id = COALESCE(excluded.report_library_id, user_watchlist.report_library_id)`,
  )
    .bind(id, session.userId, session.userId, company.name, company.code, company.listingPlace, company.exchange, company.listingPlace, company.marketType, company.source, reportLibraryId || null, now)
    .run();

  const row = await readWatchlistRowBySymbol(env.REPORT_LIBRARY_DB, session.userId, company.code, company.listingPlace);
  if (!row) return json({ error: "自选股保存失败。" }, 500);
  if (env.REPORT_LIBRARY_BUCKET) {
    context.waitUntil(
      (async () => {
        const existingRanking = await readWatchlistRankingRow(env.REPORT_LIBRARY_DB!, session.userId, row.id);
        if (rankingRefreshAlreadyRunning(existingRanking)) return;
        let pkg;
        try {
          pkg = await fetchAndStoreCompanyEvidence({
            env: { REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB!, REPORT_LIBRARY_BUCKET: env.REPORT_LIBRARY_BUCKET! },
            userId: session.userId,
            watchlist: row,
            signal: request.signal,
          });
        } catch (error) {
          await writeCompanyEvidenceFailure(env.REPORT_LIBRARY_DB!, session.userId, row, error);
          return;
        }
        const evidenceHash = pkg.materialHash || pkg.evidenceHash;
        const { jobId, runToken } = await writeWatchlistRankingRunning(env.REPORT_LIBRARY_DB!, session.userId, row, evidenceHash);
        try {
          await dispatchWatchlistRankingWorkflow(env, jobId, runToken);
        } catch (error) {
          await writeWatchlistRankingFailure(env.REPORT_LIBRARY_DB!, session.userId, row.id, error, evidenceHash, runToken);
        }
      })(),
    );
  }
  return json({ item: watchlistRowToItem(row), status });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return json({ error: "缺少自选股 ID。" }, 400);
  await env.REPORT_LIBRARY_DB.prepare(`DELETE FROM user_watchlist WHERE user_key = ?1 AND id = ?2`).bind(session.userId, id).run();
  return json({ ok: true });
};

async function readWatchlistRowBySymbol(db: D1Database, userKey: string, ticker: string, market: string) {
  return db
    .prepare(
      `SELECT id, user_id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
       FROM user_watchlist
       WHERE user_key = ?1 AND ticker = ?2 AND market = ?3`,
    )
    .bind(userKey, ticker, market)
    .first<WatchlistRow>();
}

async function readWatchlistRankingRow(db: D1Database, userKey: string, watchlistId: string) {
  return db
    .prepare(
      `SELECT id, user_key, watchlist_id, company_name, ticker, market, status, model,
              company_quality_score, investment_attractiveness_score, overall_score, verdict,
              summary, content_json, evidence_hash, created_at, updated_at, started_at,
              completed_at, error_message, run_token
       FROM watchlist_ranking_score
       WHERE user_key = ?1 AND watchlist_id = ?2`,
    )
    .bind(userKey, watchlistId)
    .first<WatchlistRankingRow>();
}

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
      "user-agent": "CSTDAlphaWatchlist/1.0",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId, run_token: runToken } }),
  });
  if (!response.ok) throw new Error(`GitHub watchlist ranking dispatch failed: ${response.status}`);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
