import { afterEach, describe, expect, test, vi } from "vitest";
import { completeJob, readJob, StaleWatchlistRankingJobError } from "./run_watchlist_ranking_job";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("run_watchlist_ranking_job stale handling", () => {
  test("treats deleted watchlist completion as stale instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "自选股不存在。" }), { status: 404 })));

    await expect(completeJob({ jobId: "job-1", error: "model failed" }, { endpoint: "https://example.test/job", token: "token" }))
      .resolves.toEqual({ stale: true, message: JSON.stringify({ error: "自选股不存在。" }) });
  });

  test("throws a typed stale error when the job cannot be read anymore", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 404 })));

    await expect(readJob("job-1", { endpoint: "https://example.test/job", token: "token" }))
      .rejects.toBeInstanceOf(StaleWatchlistRankingJobError);
  });
});
