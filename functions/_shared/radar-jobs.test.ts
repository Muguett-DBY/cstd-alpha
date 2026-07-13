import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  claimRadarAnalysisJobFailure,
  claimRadarAnalysisJobPublication,
  completeRadarAnalysisJobRun,
  finishRadarAnalysisJobFailure,
  queueRadarAnalysisJob,
  readCurrentRadarAnalysisJob,
  readLatestRadarJob,
  startRadarAnalysisJobRun,
  writeRadarJob,
} from "./radar-jobs";

afterEach(() => {
  vi.useRealTimers();
});

describe("radar analysis D1 run state", () => {
  test("atomically reuses an active run and does not disclose its token", async () => {
    const db = sqliteD1();
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T00:00:00.000Z");

    const first = await queueRadarAnalysisJob(db, "evidence-a");
    vi.setSystemTime("2026-07-13T00:01:00.000Z");
    const second = await queueRadarAnalysisJob(db, "evidence-b");

    expect(first).toMatchObject({ created: true, runToken: expect.any(String) });
    expect(second).toEqual({ created: false, job: first.job });
    expect((second as { runToken?: string }).runToken).toBeUndefined();
  });

  test("replaces a stale run and rejects every transition from its old token", async () => {
    const db = sqliteD1();
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-13T00:00:00.000Z");
    const stale = await queueRadarAnalysisJob(db, "evidence-a");
    expect(stale.runToken).toBeDefined();

    vi.setSystemTime("2026-07-13T00:21:00.000Z");
    const current = await queueRadarAnalysisJob(db, "evidence-b");

    expect(current.created).toBe(true);
    expect(current.job.id).not.toBe(stale.job.id);
    await expect(startRadarAnalysisJobRun(db, stale.job.id, stale.runToken!)).resolves.toBeNull();
    await expect(claimRadarAnalysisJobPublication(db, stale.job.id, stale.runToken!)).resolves.toBeNull();
    await expect(claimRadarAnalysisJobFailure(db, stale.job.id, stale.runToken!)).resolves.toBeNull();
  });

  test("allows only the current run to publish and preserves its token usage", async () => {
    const db = sqliteD1();
    const queued = await queueRadarAnalysisJob(db, "evidence-a");

    await expect(startRadarAnalysisJobRun(db, queued.job.id, "wrong-token")).resolves.toBeNull();
    await expect(startRadarAnalysisJobRun(db, queued.job.id, queued.runToken!)).resolves.toMatchObject({ state: "running" });
    await expect(claimRadarAnalysisJobPublication(db, queued.job.id, queued.runToken!)).resolves.toMatchObject({ state: "publishing" });
    await expect(claimRadarAnalysisJobFailure(db, queued.job.id, queued.runToken!)).resolves.toBeNull();

    await expect(completeRadarAnalysisJobRun(db, queued.job.id, "wrong-token", {
      radarGeneratedAt: "2026-07-13T00:02:00.000Z",
    })).resolves.toBe(false);
    await expect(completeRadarAnalysisJobRun(db, queued.job.id, queued.runToken!, {
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
    })).resolves.toBe(true);

    await expect(readCurrentRadarAnalysisJob(db)).resolves.toMatchObject({
      state: "completed",
      job: {
        status: "completed",
        radarGeneratedAt: "2026-07-13T00:02:00.000Z",
        tokenUsage: { promptTokens: 100, promptCacheHitTokens: 70, totalTokens: 120 },
      },
    });
  });

  test("reserves failure before closing the current run", async () => {
    const db = sqliteD1();
    const queued = await queueRadarAnalysisJob(db, "evidence-a");

    await expect(claimRadarAnalysisJobFailure(db, queued.job.id, queued.runToken!)).resolves.toMatchObject({ state: "failing" });
    await expect(claimRadarAnalysisJobPublication(db, queued.job.id, queued.runToken!)).resolves.toBeNull();
    await expect(finishRadarAnalysisJobFailure(db, queued.job.id, queued.runToken!, "dispatch failed")).resolves.toBe(true);
    await expect(readCurrentRadarAnalysisJob(db)).resolves.toMatchObject({
      state: "failed",
      job: { status: "failed", message: "dispatch failed" },
    });
  });
});

describe("radar job normalization", () => {
  test("keeps valid model token usage when reading a KV compatibility job", async () => {
    const now = new Date().toISOString();
    const job = {
      id: "radar-job-1",
      status: "completed",
      createdAt: now,
      updatedAt: now,
      tokenUsage: {
        model: "deepseek-v4-flash",
        calls: 1,
        promptTokens: 100,
        promptCacheHitTokens: 75,
        promptCacheMissTokens: 25,
        completionTokens: 20,
        totalTokens: 120,
        cacheHitRate: 0.75,
      },
    };
    const env = {
      REPORT_CACHE: {
        get: vi.fn(async () => job),
      } as unknown as KVNamespace,
    };

    await expect(readLatestRadarJob(env, "radar-analysis:job:latest")).resolves.toMatchObject({
      tokenUsage: {
        model: "deepseek-v4-flash",
        promptTokens: 100,
        promptCacheHitTokens: 75,
        totalTokens: 120,
      },
    });
  });

  test("waits for every KV mirror write to settle before reporting a failure", async () => {
    let releaseLatest!: () => void;
    const latestWrite = new Promise<void>((resolve) => {
      releaseLatest = resolve;
    });
    const cache = {
      put: vi.fn()
        .mockRejectedValueOnce(new Error("per-job write failed"))
        .mockImplementationOnce(() => latestWrite),
    } as unknown as KVNamespace;
    const now = new Date().toISOString();
    const pending = writeRadarJob(
      { REPORT_CACHE: cache },
      { id: "radar-job-1", status: "queued", createdAt: now, updatedAt: now },
      "radar-analysis:job:",
      "radar-analysis:job:latest",
    );
    let outcome = "pending";
    const observed = pending.then(
      () => { outcome = "resolved"; },
      (error) => {
        outcome = "rejected";
        throw error;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toBe("pending");
    releaseLatest();
    await expect(observed).rejects.toThrow("per-job write failed");
  });
});

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
