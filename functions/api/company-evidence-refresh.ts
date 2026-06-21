import { fetchAndStoreCompanyEvidence, writeCompanyEvidenceFailure } from "../_shared/company-evidence";
import { ensureUserResearchSchema, json, type WatchlistRow } from "../_shared/user-research-db";
import { writeActualReviewsForWatchlist } from "../_shared/research-workbench-db";

type Env = {
  COMPANY_EVIDENCE_REFRESH_TOKEN?: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
  TUSHARE_TOKEN?: string;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) return json({ error: "REPORT_LIBRARY_DB/REPORT_LIBRARY_BUCKET is not configured." }, 500);
  const expected = env.COMPANY_EVIDENCE_REFRESH_TOKEN?.trim();
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || actual !== expected) return json({ error: "Unauthorized." }, 401);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const body = (await request.json().catch(() => null)) as { userId?: string; watchlistId?: string; limit?: number; offset?: number } | null;
  const limit = Math.min(Math.max(body?.limit ?? 50, 1), 200);
  const offset = Math.min(Math.max(body?.offset ?? 0, 0), 10_000);
  const rows = await readWatchlistRows(env.REPORT_LIBRARY_DB, body?.userId, body?.watchlistId, limit, offset);
  const refreshed: Array<{ watchlistId: string; ticker: string; evidenceHash: string }> = [];
  const failed: Array<{ watchlistId: string; ticker: string; error: string }> = [];
  const reviewFailed: Array<{ watchlistId: string; ticker: string; error: string }> = [];
  const useTushareForThisRefresh = Boolean(body?.watchlistId) || rows.length <= 1;

  for (const row of rows) {
    const userId = row.user_id || row.user_key;
    try {
      const pkg = await fetchAndStoreCompanyEvidence({
        env: {
          REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB,
          REPORT_LIBRARY_BUCKET: env.REPORT_LIBRARY_BUCKET,
          TUSHARE_TOKEN: useTushareForThisRefresh ? env.TUSHARE_TOKEN : undefined,
        },
        userId,
        watchlist: row,
        signal: request.signal,
      });
      await writeActualReviewsForWatchlist(env.REPORT_LIBRARY_DB, userId, row.id, pkg).catch((error) => {
        reviewFailed.push({ watchlistId: row.id, ticker: row.ticker, error: error instanceof Error ? error.message : String(error ?? "review failed") });
      });
      refreshed.push({ watchlistId: row.id, ticker: row.ticker, evidenceHash: pkg.evidenceHash });
    } catch (error) {
      await writeCompanyEvidenceFailure(env.REPORT_LIBRARY_DB, userId, row, error);
      failed.push({ watchlistId: row.id, ticker: row.ticker, error: error instanceof Error ? error.message : String(error ?? "refresh failed") });
    }
  }

  return json({ refreshed, failed, reviewFailed, count: rows.length, refreshedCount: refreshed.length, failedCount: failed.length, reviewFailedCount: reviewFailed.length, limit, offset });
};

async function readWatchlistRows(db: D1Database, userId?: string, watchlistId?: string, limit = 50, offset = 0) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (userId?.trim()) {
    params.push(userId.trim());
    where.push(`user_key = ?${params.length}`);
  }
  if (watchlistId?.trim()) {
    params.push(watchlistId.trim());
    where.push(`id = ?${params.length}`);
  }
  params.push(limit, offset);
  const result = await db
    .prepare(
      `SELECT id, user_id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
       FROM user_watchlist
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY added_at DESC
       LIMIT ?${params.length - 1}
       OFFSET ?${params.length}`,
    )
    .bind(...params)
    .all<WatchlistRow>();
  return result.results ?? [];
}
