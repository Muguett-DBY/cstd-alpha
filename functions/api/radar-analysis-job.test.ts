import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { claimRadarAnalysisJobPublication, queueRadarAnalysisJob, readCurrentRadarAnalysisJob } from "../_shared/radar-jobs";
import { onRequestPost } from "./radar-analysis-job";

afterEach(() => {
  vi.useRealTimers();
});

describe("radar analysis worker callback", () => {
  test("requires worker authentication before reading state", async () => {
    const db = sqliteD1();
    const cache = kvWith({});

    const response = await onRequestPost(context(db, cache, { action: "start", jobId: "radar-1-12345678", runToken: crypto.randomUUID() }, "wrong-token"));

    expect(response.status).toBe(401);
    expect(cache.put).not.toHaveBeenCalled();
  });

  test("rejects malformed run identifiers before writing KV", async () => {
    const db = sqliteD1();
    const cache = kvWith({});

    const response = await onRequestPost(context(db, cache, { action: "complete", jobId: "bad", runToken: "bad" }));

    expect(response.status).toBe(400);
    expect(cache.put).not.toHaveBeenCalled();
  });

  test("rejects a superseded completion without publishing any KV key", async () => {
    const db = sqliteD1();
    const cache = kvWith({});
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T00:00:00.000Z");
    const stale = await queueRadarAnalysisJob(db, "evidence-a");
    vi.setSystemTime("2026-07-13T00:21:00.000Z");
    await queueRadarAnalysisJob(db, "evidence-b");

    const response = await onRequestPost(context(db, cache, completionBody(stale.job.id, stale.runToken!)));

    expect(response.status).toBe(409);
    expect(cache.put).not.toHaveBeenCalled();
  });

  test("starts and publishes the current completion exactly once", async () => {
    const db = sqliteD1();
    const store: Record<string, unknown> = {};
    const cache = kvWith(store);
    const queued = await queueRadarAnalysisJob(db, "evidence-a");

    const started = await onRequestPost(context(db, cache, {
      action: "start",
      jobId: queued.job.id,
      runToken: queued.runToken,
    }));
    expect(started.status).toBe(200);

    cache.put.mockClear();
    const completed = await onRequestPost(context(db, cache, completionBody(queued.job.id, queued.runToken!)));

    expect(completed.status).toBe(200);
    expect(cache.put).toHaveBeenCalledTimes(3);
    expect(store["radar-scan:v2:latest"]).toMatchObject({ version: "v2", radar: { generatedAt: "2026-07-13T00:02:00.000Z" } });
    expect(store[`radar-analysis:job:${queued.job.id}`]).toMatchObject({ id: queued.job.id, status: "completed" });
    expect(store["radar-analysis:job:latest"]).toMatchObject({ id: queued.job.id, status: "completed", tokenUsage: { totalTokens: 120 } });
    await expect(readCurrentRadarAnalysisJob(db)).resolves.toMatchObject({ state: "completed", job: { status: "completed", tokenUsage: { totalTokens: 120 } } });

    cache.put.mockClear();
    const replay = await onRequestPost(context(db, cache, completionBody(queued.job.id, queued.runToken!)));
    expect(replay.status).toBe(409);
    expect(cache.put).not.toHaveBeenCalled();
  });

  test("publishes a current failure without replacing the radar result", async () => {
    const db = sqliteD1();
    const store: Record<string, unknown> = { "radar-scan:v2:latest": { version: "v2", radar: { id: "stable" } } };
    const cache = kvWith(store);
    const queued = await queueRadarAnalysisJob(db, "evidence-a");

    const response = await onRequestPost(context(db, cache, {
      action: "fail",
      jobId: queued.job.id,
      runToken: queued.runToken,
      error: "model failed",
    }));

    expect(response.status).toBe(200);
    expect(store["radar-scan:v2:latest"]).toEqual({ version: "v2", radar: { id: "stable" } });
    expect(store["radar-analysis:job:latest"]).toMatchObject({ id: queued.job.id, status: "failed", message: "本次刷新失败，已保留上次扫描。" });
    await expect(readCurrentRadarAnalysisJob(db)).resolves.toMatchObject({ state: "failed", job: { status: "failed" } });
  });

  test("closes a claimed publication as failed when KV publication fails", async () => {
    const db = sqliteD1();
    const cache = kvWith({});
    const queued = await queueRadarAnalysisJob(db, "evidence-a");
    await onRequestPost(context(db, cache, { action: "start", jobId: queued.job.id, runToken: queued.runToken }));
    cache.put.mockClear();
    cache.put.mockRejectedValueOnce(new Error("KV unavailable"));

    const response = await onRequestPost(context(db, cache, completionBody(queued.job.id, queued.runToken!)));

    expect(response.status).toBe(500);
    await expect(readCurrentRadarAnalysisJob(db)).resolves.toMatchObject({ state: "failed", job: { status: "failed" } });
  });

  test("rejects a second publisher after the current run is already claimed", async () => {
    const db = sqliteD1();
    const cache = kvWith({});
    const queued = await queueRadarAnalysisJob(db, "evidence-a");
    await onRequestPost(context(db, cache, { action: "start", jobId: queued.job.id, runToken: queued.runToken }));
    await claimRadarAnalysisJobPublication(db, queued.job.id, queued.runToken!);
    cache.put.mockClear();

    const response = await onRequestPost(context(db, cache, completionBody(queued.job.id, queued.runToken!)));

    expect(response.status).toBe(409);
    expect(cache.put).not.toHaveBeenCalled();
  });

  test("waits for all in-flight publication writes before making the run retryable", async () => {
    const db = sqliteD1();
    const cache = kvWith({});
    const queued = await queueRadarAnalysisJob(db, "evidence-a");
    await onRequestPost(context(db, cache, { action: "start", jobId: queued.job.id, runToken: queued.runToken }));
    let releaseRadarWrite!: () => void;
    const radarWrite = new Promise<void>((resolve) => {
      releaseRadarWrite = resolve;
    });
    cache.put.mockImplementation(async (key: string) => {
      if (key === "radar-scan:v2:latest") return radarWrite;
      if (key === `radar-analysis:job:${queued.job.id}`) throw new Error("per-job write failed");
    });

    let settled = false;
    const pending = onRequestPost(context(db, cache, completionBody(queued.job.id, queued.runToken!))).then((response) => {
      settled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).toBe(false);
    await expect(readCurrentRadarAnalysisJob(db)).resolves.toMatchObject({ state: "publishing" });
    releaseRadarWrite();
    const response = await pending;
    expect(response.status).toBe(500);
    await expect(readCurrentRadarAnalysisJob(db)).resolves.toMatchObject({ state: "failed" });
  });
});

function completionBody(jobId: string, runToken: string) {
  return {
    action: "complete",
    jobId,
    runToken,
    radarCache: {
      version: "v2",
      cachedAt: "2026-07-13T00:02:00.000Z",
      radar: {
        id: "radar-result-1",
        generatedAt: "2026-07-13T00:02:00.000Z",
      },
    },
    job: {
      id: jobId,
      status: "completed",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:02:00.000Z",
      radarGeneratedAt: "2026-07-13T00:02:00.000Z",
      tokenUsage: {
        model: "deepseek-v4-flash",
        promptTokens: 100,
        promptCacheHitTokens: 70,
        promptCacheMissTokens: 30,
        completionTokens: 20,
        totalTokens: 120,
        cacheHitRate: 0.7,
      },
    },
  };
}

function context(db: D1Database, cache: ReturnType<typeof kvWith>, body: unknown, token = "worker-token") {
  return {
    request: new Request("https://alpha.custard.top/api/radar-analysis-job", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env: {
      TEMPLATE_ANALYSIS_WORKER_TOKEN: "worker-token",
      REPORT_LIBRARY_DB: db,
      REPORT_CACHE: cache,
    },
  } as unknown as Parameters<typeof onRequestPost>[0];
}

function kvWith(store: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store[key] = JSON.parse(value) as unknown;
    }),
  };
}

function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  const db = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      let prepared: StatementSync | undefined;
      const statement = {
        bind(...args: unknown[]) {
          bindings = args;
          return statement;
        },
        async run() {
          prepared ??= sqlite.prepare(sql);
          const result = prepared.run(...bindings);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
        async first<T>() {
          prepared ??= sqlite.prepare(sql);
          return (prepared.get(...bindings) ?? null) as T | null;
        },
        async all<T>() {
          prepared ??= sqlite.prepare(sql);
          return { success: true, results: prepared.all(...bindings) } as T;
        },
      };
      return statement;
    },
  };
  return db as unknown as D1Database;
}
