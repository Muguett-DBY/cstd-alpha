import { afterEach, describe, expect, test, vi } from "vitest";
import { completeRadarAnalysisJob, failRadarAnalysisJob, startRadarAnalysisJob } from "./radar-analysis-job-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

const options = {
  endpoint: "https://alpha.custard.top/api/radar-analysis-job",
  token: "worker-token",
  jobId: "radar-1720828800000-1234abcd",
  runToken: "12345678-1234-4123-8123-123456789abc",
};

describe("radar analysis job client", () => {
  test("starts a run with both guarded identifiers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job: { status: "running" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startRadarAnalysisJob(options)).resolves.toEqual({ stale: false });

    expect(fetchMock).toHaveBeenCalledWith(options.endpoint, expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer worker-token" }),
      body: JSON.stringify({ action: "start", jobId: options.jobId, runToken: options.runToken }),
    }));
  });

  test("treats a superseded completion as a successful skip", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "雷达任务运行已更新" }), { status: 409 })));

    await expect(completeRadarAnalysisJob({ radarCache: { version: "v2" }, job: { id: options.jobId } }, options)).resolves.toMatchObject({ stale: true });
  });

  test("sends failures through the same guarded callback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job: { status: "failed" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(failRadarAnalysisJob(options)).resolves.toEqual({ stale: false });

    expect(fetchMock).toHaveBeenCalledWith(options.endpoint, expect.objectContaining({
      body: JSON.stringify({ action: "fail", jobId: options.jobId, runToken: options.runToken }),
    }));
  });
});
