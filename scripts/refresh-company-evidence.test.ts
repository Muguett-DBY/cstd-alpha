import { describe, expect, test, vi } from "vitest";
import { parseRefreshConfig, refreshCompanyEvidence } from "./refresh-company-evidence.mjs";

describe("refresh company evidence action helper", () => {
  test("splits scheduled refresh into bounded batches with offsets", async () => {
    const calls: Array<{ limit: number; offset: number }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { limit: number; offset: number };
      calls.push({ limit: body.limit, offset: body.offset });
      const count = body.offset >= 10 ? 0 : body.limit;
      return new Response(JSON.stringify({ count, refreshedCount: count, failedCount: 0, refreshed: [], failed: [] }), { status: 200 });
    });

    const result = await refreshCompanyEvidence({
      env: {
        COMPANY_EVIDENCE_REFRESH_TOKEN: "token",
        COMPANY_EVIDENCE_LIMIT: "12",
        COMPANY_EVIDENCE_BATCH_SIZE: "5",
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    });

    expect(calls).toEqual([
      { limit: 5, offset: 0 },
      { limit: 5, offset: 5 },
      { limit: 2, offset: 10 },
    ]);
    expect(result.refreshedCount).toBe(10);
  });

  test("splits a timed-out batch into single-company requests", async () => {
    const calls: Array<{ limit: number; offset: number }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { limit: number; offset: number };
      calls.push({ limit: body.limit, offset: body.offset });
      if (body.limit > 1) return new Response("timeout", { status: 524 });
      return new Response(JSON.stringify({ count: 1, refreshedCount: 1, failedCount: 0, refreshed: [], failed: [] }), { status: 200 });
    });

    const result = await refreshCompanyEvidence({
      env: {
        COMPANY_EVIDENCE_REFRESH_TOKEN: "token",
        COMPANY_EVIDENCE_LIMIT: "3",
        COMPANY_EVIDENCE_BATCH_SIZE: "3",
        COMPANY_EVIDENCE_MAX_RETRIES: "1",
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    });

    expect(calls).toEqual([
      { limit: 3, offset: 0 },
      { limit: 3, offset: 0 },
      { limit: 1, offset: 0 },
      { limit: 1, offset: 1 },
      { limit: 1, offset: 2 },
    ]);
    expect(result.refreshedCount).toBe(3);
  });

  test("uses a single direct request for explicit watchlist refresh", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { watchlistId?: string; limit: number; offset: number };
      expect(body).toMatchObject({ watchlistId: "w1", limit: 1, offset: 0 });
      return new Response(JSON.stringify({ count: 1, refreshedCount: 1, failedCount: 0, refreshed: [], failed: [] }), { status: 200 });
    });

    await refreshCompanyEvidence({
      env: {
        COMPANY_EVIDENCE_REFRESH_TOKEN: "token",
        COMPANY_EVIDENCE_WATCHLIST_ID: "w1",
        COMPANY_EVIDENCE_LIMIT: "80",
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("does not hide auth or other non-retryable HTTP failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("Unauthorized", { status: 401 }));

    await expect(
      refreshCompanyEvidence({
        env: {
          COMPANY_EVIDENCE_REFRESH_TOKEN: "bad-token",
          COMPANY_EVIDENCE_LIMIT: "5",
          COMPANY_EVIDENCE_BATCH_SIZE: "5",
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: silentLogger(),
      }),
    ).rejects.toThrow("401");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("clamps invalid env values to safe defaults", () => {
    expect(parseRefreshConfig({ COMPANY_EVIDENCE_REFRESH_TOKEN: "token", COMPANY_EVIDENCE_LIMIT: "999", COMPANY_EVIDENCE_BATCH_SIZE: "0" })).toMatchObject({
      totalLimit: 200,
      batchLimit: 5,
      token: "token",
    });
  });
});

function silentLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
  };
}
