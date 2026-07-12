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
  test("company evidence refresh rejects malformed filters instead of widening the refresh scope", async () => {
    const db = bodyParamDb();

    const response = await onCompanyEvidenceRefreshPost(companyEvidenceRefreshContext(db.db, {
      userId: 123,
      watchlistId: { id: "watch-1" },
      limit: "many",
      offset: { value: 20 },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("参数格式") });
    expect(db.binds).toEqual([]);
  });

  test("watchlist ranking rejects malformed filters instead of queueing the default batch", async () => {
    const db = bodyParamDb();

    const response = await onWatchlistRankingPost(watchlistRankingContext(db.db, {
      watchlistId: { id: "watch-1" },
      limit: "all",
      forceRefresh: "true",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("参数格式") });
    expect(db.binds).toEqual([]);
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
