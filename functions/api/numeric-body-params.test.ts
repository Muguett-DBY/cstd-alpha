import { describe, expect, test, vi } from "vitest";
import { onRequestPost as onCompanyEvidenceRefreshPost } from "./company-evidence-refresh";
import { onRequestPost as onWatchlistRankingPost } from "./watchlist-ranking";

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

describe("numeric body parameter validation", () => {
  test("company evidence refresh ignores malformed filters and falls back to bounded paging", async () => {
    const db = bodyParamDb();

    const response = await onCompanyEvidenceRefreshPost(companyEvidenceRefreshContext(db.db, {
      userId: 123,
      watchlistId: { id: "watch-1" },
      limit: "many",
      offset: { value: 20 },
    }));
    const body = await response.json() as { count?: number; limit?: number; offset?: number };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ count: 0, limit: 50, offset: 0 });
    expect(db.binds.some((args) => args.some((arg) => Number.isNaN(arg)))).toBe(false);
  });

  test("watchlist ranking ignores malformed filters and falls back to the default limit", async () => {
    const db = bodyParamDb();

    const response = await onWatchlistRankingPost(watchlistRankingContext(db.db, {
      watchlistId: { id: "watch-1" },
      limit: "all",
      forceRefresh: "true",
    }));
    const body = await response.json() as { entries?: unknown[]; queued?: string[] };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ entries: [], queued: [] });
    expect(db.binds.some((args) => args.some((arg) => Number.isNaN(arg)))).toBe(false);
    expect(db.binds.some((args) => args.includes(20))).toBe(true);
  });
});

function companyEvidenceRefreshContext(db: D1Database, body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/company-evidence-refresh", {
      method: "POST",
      headers: {
        authorization: "Bearer refresh-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env: {
      COMPANY_EVIDENCE_REFRESH_TOKEN: "refresh-token",
      REPORT_LIBRARY_DB: db,
      REPORT_LIBRARY_BUCKET: {} as R2Bucket,
    },
  } as unknown as Parameters<typeof onCompanyEvidenceRefreshPost>[0];
}

function watchlistRankingContext(db: D1Database, body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/watchlist-ranking", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "cstd_alpha_session=session-1.token" },
      body: JSON.stringify(body),
    }),
    env: {
      AUTH_SECRET: "test-secret",
      REPORT_LIBRARY_DB: db,
      REPORT_LIBRARY_BUCKET: {} as R2Bucket,
    },
    waitUntil: vi.fn(),
  } as unknown as Parameters<typeof onWatchlistRankingPost>[0];
}

function bodyParamDb() {
  const binds: unknown[][] = [];
  const prepare = vi.fn(() => {
    const statement = {
      bind(...args: unknown[]) {
        binds.push(args);
        return statement;
      },
      async run() {
        return { success: true };
      },
      async first<T>() {
        return null as T;
      },
      async all<T>() {
        return { results: [] } as T;
      },
    };
    return statement;
  });
  return {
    db: {
      prepare,
      batch: vi.fn(async () => []),
    } as unknown as D1Database,
    binds,
  };
}
