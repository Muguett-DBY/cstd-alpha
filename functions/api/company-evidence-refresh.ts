import { fetchAndStoreCompanyEvidence, writeCompanyEvidenceFailure } from "../_shared/company-evidence";
import { ensureUserResearchSchema, json, type WatchlistRow } from "../_shared/user-research-db";

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

  const body = (await request.json().catch(() => null)) as { userId?: string; watchlistId?: string; limit?: number } | null;
  const rows = await readWatchlistRows(env.REPORT_LIBRARY_DB, body?.userId, body?.watchlistId, Math.min(Math.max(body?.limit ?? 50, 1), 200));
  const refreshed: Array<{ watchlistId: string; ticker: string; evidenceHash: string }> = [];
  const failed: Array<{ watchlistId: string; ticker: string; error: string }> = [];
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
      refreshed.push({ watchlistId: row.id, ticker: row.ticker, evidenceHash: pkg.evidenceHash });
    } catch (error) {
      await writeCompanyEvidenceFailure(env.REPORT_LIBRARY_DB, userId, row, error);
      failed.push({ watchlistId: row.id, ticker: row.ticker, error: error instanceof Error ? error.message : String(error ?? "refresh failed") });
    }
  }

  return json({ refreshed, failed, count: rows.length, refreshedCount: refreshed.length, failedCount: failed.length });
};

async function readWatchlistRows(db: D1Database, userId?: string, watchlistId?: string, limit = 50) {
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
  params.push(limit);
  const result = await db
    .prepare(
      `SELECT id, user_id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
       FROM user_watchlist
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY added_at DESC
       LIMIT ?${params.length}`,
    )
    .bind(...params)
    .all<WatchlistRow>();
  return result.results ?? [];
}
