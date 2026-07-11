import { describe, expect, test, vi } from "vitest";
import { onRequestPost as onTemplateAnalysisJobPost } from "./template-analysis-job";
import { onRequestPost as onWatchlistRankingJobPost } from "./watchlist-ranking-job";

describe("worker job callback payload validation", () => {
  test("rejects malformed template analysis job ids before reading jobs", async () => {
    const db = jobCallbackDb();

    const response = await onTemplateAnalysisJobPost(context("https://alpha.custard.top/api/template-analysis-job", db.db, {
      jobId: { id: "template-job-1" },
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("缺少模板任务 ID。");
    expect(db.sqls.some((sql) => /FROM template_analysis/i.test(sql))).toBe(false);
  });

  test("rejects malformed watchlist ranking job ids before reading jobs", async () => {
    const db = jobCallbackDb();

    const response = await onWatchlistRankingJobPost(context("https://alpha.custard.top/api/watchlist-ranking-job", db.db, {
      jobId: { id: "ranking-job-1" },
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("缺少自选排行任务 ID。");
    expect(db.sqls.some((sql) => /FROM watchlist_ranking_score/i.test(sql))).toBe(false);
  });
});

function context(url: string, db: D1Database, body: unknown) {
  return {
    request: new Request(url, {
      method: "POST",
      headers: {
        authorization: "Bearer worker-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env: {
      TEMPLATE_ANALYSIS_WORKER_TOKEN: "worker-token",
      WATCHLIST_RANKING_WORKER_TOKEN: "worker-token",
      REPORT_LIBRARY_DB: db,
      REPORT_LIBRARY_BUCKET: {} as R2Bucket,
    },
  } as unknown as Parameters<typeof onTemplateAnalysisJobPost>[0] & Parameters<typeof onWatchlistRankingJobPost>[0];
}

function jobCallbackDb() {
  const sqls: string[] = [];
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    const statement = {
      bind() {
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
    sqls,
  };
}
