import {
  ensureUserResearchSchema,
  json,
  normalizeCompany,
  requireUserSession,
  sha256,
  watchlistRowToItem,
  type WatchlistRow,
} from "../_shared/user-research-db";

type Env = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const result = await env.REPORT_LIBRARY_DB.prepare(
    `SELECT id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
     FROM user_watchlist
     WHERE user_key = ?1
     ORDER BY added_at DESC`,
  )
    .bind(session.userKey)
    .all<WatchlistRow>();
  return json({ items: (result.results ?? []).map(watchlistRowToItem), user: { username: session.username, userKey: session.userKey } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);

  const body = (await request.json().catch(() => null)) as { company?: unknown; reportLibraryId?: string } | null;
  const company = normalizeCompany(body?.company);
  if (!company) return json({ error: "公司信息不完整，无法加入自选。" }, 400);

  const now = new Date().toISOString();
  const id = await sha256(`${session.userKey}:${company.listingPlace}:${company.code}`);
  await env.REPORT_LIBRARY_DB.prepare(
    `INSERT INTO user_watchlist (
      id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    ON CONFLICT(user_key, ticker, market) DO UPDATE SET
      company_name = excluded.company_name,
      exchange_name = excluded.exchange_name,
      listing_place = excluded.listing_place,
      market_type = excluded.market_type,
      source = excluded.source,
      report_library_id = COALESCE(excluded.report_library_id, user_watchlist.report_library_id)`,
  )
    .bind(id, session.userKey, company.name, company.code, company.listingPlace, company.exchange, company.listingPlace, company.marketType, company.source, body?.reportLibraryId || null, now)
    .run();

  const row = await readWatchlistRow(env.REPORT_LIBRARY_DB, session.userKey, id);
  return json({ item: row ? watchlistRowToItem(row) : null });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return json({ error: "缺少自选股 ID。" }, 400);
  await env.REPORT_LIBRARY_DB.prepare(`DELETE FROM user_watchlist WHERE user_key = ?1 AND id = ?2`).bind(session.userKey, id).run();
  return json({ ok: true });
};

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
