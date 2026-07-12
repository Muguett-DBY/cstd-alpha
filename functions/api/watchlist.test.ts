import { describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./watchlist";
import type { WatchlistRow } from "../_shared/user-research-db";

vi.mock("../_shared/auth", () => ({
  readSessionCookie: vi.fn(async () => ({
    userId: "user-1",
    username: "analyst",
    displayName: "Analyst",
    role: "admin",
    sessionId: "session-1",
    expiresAt: "2026-07-01T00:00:00.000Z",
  })),
}));

describe("/api/watchlist", () => {
  test("returns created status for a new watchlist company", async () => {
    const db = watchlistDb();

    const response = await onRequestPost(context(db, companyPayload()));
    const body = await response.json() as { item?: { id: string; company: { name: string; code: string } }; status?: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("created");
    expect(body.item?.company).toMatchObject({ name: "贵州茅台", code: "600519" });
  });

  test("returns updated status and the stored row id for an existing company", async () => {
    const db = watchlistDb({
      id: "legacy-row-id",
      user_id: "user-1",
      user_key: "user-1",
      company_name: "贵州茅台",
      ticker: "600519",
      market: "A股",
      exchange_name: "上海证券交易所",
      listing_place: "A股",
      market_type: "AStock",
      source: "eastmoney",
      report_library_id: null,
      added_at: "2026-06-01T00:00:00.000Z",
    });

    const response = await onRequestPost(context(db, companyPayload()));
    const body = await response.json() as { item?: { id: string }; status?: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("updated");
    expect(body.item?.id).toBe("legacy-row-id");
  });

  test("returns a server error when the saved watchlist row cannot be read back", async () => {
    const db = watchlistDb(null, { persistWrites: false });

    const response = await onRequestPost(context(db, companyPayload()));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe("自选股保存失败。");
  });

  test("ignores malformed report library ids before persisting a watchlist row", async () => {
    const db = watchlistDb();

    const response = await onRequestPost(context(db, {
      ...companyPayload(),
      reportLibraryId: { id: "report-1" },
    }));
    const body = await response.json() as { item?: { reportLibraryId?: unknown }; status?: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("created");
    expect(body.item?.reportLibraryId).toBeUndefined();
  });
});

function context(db: D1Database, body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "cstd_alpha_session=session-1.token" },
      body: JSON.stringify(body),
    }),
    env: {
      AUTH_SECRET: "test-secret",
      REPORT_LIBRARY_DB: db,
    },
    waitUntil: vi.fn(),
  } as unknown as Parameters<typeof onRequestPost>[0];
}

function companyPayload() {
  return {
    company: {
      id: "eastmoney:1.600519",
      name: "贵州茅台",
      code: "600519",
      exchange: "上海证券交易所",
      listingPlace: "A股",
      marketType: "AStock",
      source: "eastmoney",
    },
  };
}

function watchlistDb(initialRow: WatchlistRow | null = null, options: { persistWrites?: boolean } = {}) {
  let storedRow: WatchlistRow | null = initialRow ? { ...initialRow } : null;
  const prepare = vi.fn((sql: string) => {
    let args: unknown[] = [];
    const statement = {
      bind(...nextArgs: unknown[]) {
        args = nextArgs;
        return statement;
      },
      async run() {
        if (/INSERT INTO user_watchlist/i.test(sql) && options.persistWrites !== false) {
          const [
            id,
            userId,
            userKey,
            companyName,
            ticker,
            market,
            exchangeName,
            listingPlace,
            marketType,
            source,
            reportLibraryId,
            addedAt,
          ] = args as string[];
          storedRow = {
            id: storedRow?.id ?? id,
            user_id: userId,
            user_key: userKey,
            company_name: companyName,
            ticker,
            market,
            exchange_name: exchangeName,
            listing_place: listingPlace,
            market_type: marketType,
            source,
            report_library_id: reportLibraryId || storedRow?.report_library_id || null,
            added_at: storedRow?.added_at ?? addedAt,
          };
        }
        return { success: true };
      },
      async first<T>() {
        if (/FROM user_watchlist/i.test(sql) && /ticker = \?2/i.test(sql)) {
          const [userKey, ticker, market] = args;
          if (storedRow?.user_key === userKey && storedRow.ticker === ticker && storedRow.market === market) return storedRow as T;
          return null as T;
        }
        if (/FROM user_watchlist/i.test(sql) && /id = \?2/i.test(sql)) {
          const [userKey, id] = args;
          if (storedRow?.user_key === userKey && storedRow.id === id) return storedRow as T;
          return null as T;
        }
        return null as T;
      },
      async all<T>() {
        return { results: [] } as T;
      },
    };
    return statement;
  });
  return {
    prepare,
    batch: vi.fn(async () => []),
  } as unknown as D1Database;
}
