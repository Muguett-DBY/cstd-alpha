import { describe, expect, test, vi } from "vitest";
import { RESEARCH_TEMPLATES, type ResearchTemplate } from "../../src/shared/user-research";
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

  test("rejects watchlist ranking callbacks that omit the required component scores", async () => {
    const db = watchlistRankingCompletionDb();

    const response = await onWatchlistRankingJobPost(context("https://alpha.custard.top/api/watchlist-ranking-job", db.db, {
      jobId: "ranking-job-1",
      runToken: "current-run-token",
      generated: {
        companyQualityScore: "bad",
        investmentAttractivenessScore: { score: 70 },
        overallScore: null,
        verdict: 123,
        summary: "",
        keyPoints: [123],
        riskFlags: [{ risk: "missing" }],
      },
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(422);
    expect(body.error).toBe("自选排行评分结果缺少有效的公司质量分或投资吸引力分。");
    expect(db.sqls.some((sql) => /SET status = 'completed'/i.test(sql))).toBe(false);
  });

  test("rejects malformed template analysis generated payloads before report writes", async () => {
    const db = templateAnalysisCompletionDb(RESEARCH_TEMPLATES[0]);

    const response = await onTemplateAnalysisJobPost(context("https://alpha.custard.top/api/template-analysis-job", db.db, {
      jobId: "template-job-1",
      runToken: "current-run-token",
      generated: "not-an-object",
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("缺少模板生成结果。");
    expect(db.sqls.some((sql) => /INSERT INTO template_analysis/i.test(sql))).toBe(false);
  });

  test("rejects a stale watchlist ranking run token before any completion write", async () => {
    const db = watchlistRankingCompletionDb();

    const response = await onWatchlistRankingJobPost(context("https://alpha.custard.top/api/watchlist-ranking-job", db.db, {
      jobId: "ranking-job-1",
      runToken: "stale-run-token",
      generated: {
        companyQualityScore: 80,
        investmentAttractivenessScore: 65,
        verdict: "观察",
        summary: "质量较好，估值仍需复核。",
      },
    }));

    expect(response.status).toBe(409);
    expect(db.sqls.some((sql) => /SET status = 'completed'/i.test(sql))).toBe(false);
  });

  test("rejects a stale template analysis run token before writing report objects", async () => {
    const template = RESEARCH_TEMPLATES[0];
    const db = templateAnalysisCompletionDb(template);
    const bucketPut = vi.fn(async () => undefined);

    const response = await onTemplateAnalysisJobPost(context("https://alpha.custard.top/api/template-analysis-job", db.db, {
      jobId: "template-job-1",
      runToken: "stale-run-token",
      generated: {
        title: "贵州茅台模板分析",
        score: 80,
        verdict: "观察",
        summary: "证据完整。",
        keyPoints: ["盈利质量稳定"],
        riskFlags: ["估值需复核"],
        followUps: ["跟踪最新财报"],
        sections: [],
        markdown: "# 贵州茅台模板分析",
      },
    }, bucketPut));

    expect(response.status).toBe(409);
    expect(bucketPut).not.toHaveBeenCalled();
    expect(db.sqls.some((sql) => /INSERT INTO template_analysis/i.test(sql))).toBe(false);
  });

  test("claims and completes the current watchlist ranking run atomically", async () => {
    const db = watchlistRankingCompletionDb();

    const response = await onWatchlistRankingJobPost(context("https://alpha.custard.top/api/watchlist-ranking-job", db.db, {
      jobId: "ranking-job-1",
      runToken: "current-run-token",
      generated: {
        companyQualityScore: 80,
        investmentAttractivenessScore: 65,
        verdict: "观察",
        summary: "质量较好，估值仍需复核。",
        keyPoints: ["盈利质量稳定"],
        riskFlags: ["估值需复核"],
      },
    }));

    expect(response.status).toBe(200);
    const rankingClaim = db.binds.find((item) => /SET run_token = \?1/i.test(item.sql))?.args;
    expect(rankingClaim?.[0]).toBe("finalizing:current-run-token");
    expect(rankingClaim?.slice(-2)).toEqual(["ranking-job-1", "current-run-token"]);
    expect(db.binds.find((item) => /SET status = 'completed'/i.test(item.sql))?.args.at(-1)).toBe("finalizing:current-run-token");
  });

  test("claims and completes the current template analysis run with an attempt-scoped object", async () => {
    const template = RESEARCH_TEMPLATES[0];
    const db = templateAnalysisCompletionDb(template);
    const bucketPut = vi.fn(async () => undefined);

    const response = await onTemplateAnalysisJobPost(context("https://alpha.custard.top/api/template-analysis-job", db.db, {
      jobId: "template-job-1",
      runToken: "current-run-token",
      generated: {
        title: "贵州茅台模板分析",
        score: 80,
        verdict: "观察",
        summary: "证据完整。",
        keyPoints: ["盈利质量稳定"],
        riskFlags: ["估值需复核"],
        followUps: ["跟踪最新财报"],
        sections: [],
        markdown: "# 贵州茅台模板分析",
      },
    }, bucketPut));

    expect(response.status).toBe(200);
    expect(bucketPut.mock.calls[0]?.[0]).toContain("current-run-token.md");
    const templateClaim = db.binds.find((item) => /SET run_token = \?1/i.test(item.sql))?.args;
    expect(templateClaim?.[0]).toBe("finalizing:current-run-token");
    expect(templateClaim?.slice(-2)).toEqual(["template-job-1", "current-run-token"]);
    expect(db.binds.find((item) => /SET model = \?1, status = \?2/i.test(item.sql))?.args.at(-1)).toBe("finalizing:current-run-token");
  });
});

function context(url: string, db: D1Database, body: unknown, bucketPut = vi.fn(async () => undefined)) {
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
      REPORT_LIBRARY_BUCKET: { put: bucketPut } as unknown as R2Bucket,
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

function watchlistRankingCompletionDb() {
  const sqls: string[] = [];
  const binds: Array<{ sql: string; args: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    const statement = {
      bind(...args: unknown[]) {
        binds.push({ sql, args });
        return statement;
      },
      async run() {
        return { success: true };
      },
      async first<T>() {
        if (/FROM watchlist_ranking_score/i.test(sql) && /WHERE id = \?1/i.test(sql)) {
          return {
            id: "ranking-job-1",
            user_key: "user-1",
            watchlist_id: "watch-1",
            company_name: "贵州茅台",
            ticker: "600519",
            market: "SH-A",
            status: "running",
            model: "deepseek-v4-flash",
            company_quality_score: null,
            investment_attractiveness_score: null,
            overall_score: null,
            verdict: "评分中",
            summary: "后台正在基于公司证据包重新评分。",
            content_json: "{}",
            evidence_hash: "evidence-a",
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-07-01T00:00:00.000Z",
            started_at: "2026-07-01T00:00:00.000Z",
            completed_at: null,
            error_message: null,
            run_token: "current-run-token",
          } as T;
        }
        if (/FROM user_watchlist/i.test(sql)) {
          return {
            id: "watch-1",
            user_id: "user-1",
            user_key: "user-1",
            company_name: "贵州茅台",
            ticker: "600519",
            market: "SH-A",
            exchange_name: "上海证券交易所",
            listing_place: "SH-A",
            market_type: "AStock",
            source: "eastmoney",
            report_library_id: null,
            added_at: "2026-07-01T00:00:00.000Z",
          } as T;
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
    db: {
      prepare,
      batch: vi.fn(async () => []),
    } as unknown as D1Database,
    sqls,
    binds,
  };
}

function templateAnalysisCompletionDb(template: ResearchTemplate) {
  const sqls: string[] = [];
  const binds: Array<{ sql: string; args: unknown[] }> = [];
  const now = new Date().toISOString();
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    const statement = {
      bind(...args: unknown[]) {
        binds.push({ sql, args });
        return statement;
      },
      async run() {
        return { success: true };
      },
      async first<T>() {
        if (/FROM template_analysis/i.test(sql) && /WHERE id = \?1/i.test(sql)) {
          return {
            id: "template-job-1",
            user_id: "user-1",
            user_key: "user-1",
            watchlist_id: "watch-1",
            template_id: template.id,
            template_title: template.title,
            company_name: "贵州茅台",
            ticker: "600519",
            market: "SH-A",
            model: "deepseek-v4-flash",
            status: "running",
            title: "贵州茅台模板分析",
            score: null,
            verdict: "待生成",
            summary: "模板深度报告正在生成。",
            content_json: "{}",
            object_key: null,
            created_at: now,
            updated_at: now,
            started_at: now,
            completed_at: null,
            error_message: null,
            template_hash: "template-hash",
            evidence_hash: "evidence-a",
            template_snapshot_json: JSON.stringify(template),
            run_token: "current-run-token",
          } as T;
        }
        if (/FROM user_watchlist/i.test(sql)) {
          return {
            id: "watch-1",
            user_id: "user-1",
            user_key: "user-1",
            company_name: "贵州茅台",
            ticker: "600519",
            market: "SH-A",
            exchange_name: "上海证券交易所",
            listing_place: "SH-A",
            market_type: "AStock",
            source: "eastmoney",
            report_library_id: null,
            added_at: "2026-07-01T00:00:00.000Z",
          } as T;
        }
        return null as T;
      },
      async all<T>() {
        if (/FROM user_research_templates/i.test(sql)) {
          return { results: [templateRow(template)] } as T;
        }
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
    binds,
  };
}

function templateRow(template: ResearchTemplate) {
  return {
    id: template.id,
    user_id: "user-1",
    user_key: "user-1",
    title: template.title,
    short_title: template.shortTitle,
    focus: template.focus,
    prompt: template.prompt,
    full_prompt: template.fullPrompt,
    section_requirements_json: JSON.stringify(template.sectionRequirements ?? []),
    enabled: 1,
    sort_order: template.sortOrder ?? 1,
    is_system: template.isSystem ? 1 : 0,
    deleted_at: null,
    default_title: template.title,
    default_short_title: template.shortTitle,
    default_focus: template.focus,
    default_prompt: template.prompt,
    default_full_prompt: template.fullPrompt,
    default_section_requirements_json: JSON.stringify(template.sectionRequirements ?? []),
    default_enabled: 1,
    default_sort_order: template.sortOrder ?? 1,
    default_is_system: template.isSystem ? 1 : 0,
    default_deleted_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
}
