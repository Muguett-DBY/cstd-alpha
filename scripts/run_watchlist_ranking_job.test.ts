import { afterEach, describe, expect, test, vi } from "vitest";
import { completeJob, readJob, StaleWatchlistRankingJobError } from "./run_watchlist_ranking_job";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("run_watchlist_ranking_job stale handling", () => {
  test("treats deleted watchlist completion as stale instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "自选股不存在。" }), { status: 404 })));

    await expect(completeJob({ jobId: "job-1", runToken: "run-1", error: "model failed" }, { endpoint: "https://example.test/job", token: "token" }))
      .resolves.toEqual({ stale: true, message: JSON.stringify({ error: "自选股不存在。" }) });
  });

  test("throws a typed stale error when the job cannot be read anymore", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 404 })));

    await expect(readJob("job-1", "run-1", { endpoint: "https://example.test/job", token: "token" }))
      .rejects.toBeInstanceOf(StaleWatchlistRankingJobError);
  });

  test("treats a superseded run-token completion as stale", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "任务运行已更新。" }), { status: 409 })));

    await expect(completeJob({ jobId: "job-1", runToken: "run-1", error: "model failed" }, { endpoint: "https://example.test/job", token: "token" }))
      .resolves.toEqual({ stale: true, message: JSON.stringify({ error: "任务运行已更新。" }) });
  });

  test("sends the run token when reading a job", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job: { id: "job-1" }, watchlist: {}, evidence: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await readJob("job-1", "run-token-1", { endpoint: "https://example.test/job", token: "token" });

    expect(fetchMock).toHaveBeenCalledWith("https://example.test/job?jobId=job-1&runToken=run-token-1", expect.any(Object));
  });
});
