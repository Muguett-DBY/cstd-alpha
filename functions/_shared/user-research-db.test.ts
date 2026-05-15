import { describe, expect, test } from "vitest";
import { analysisRowToResult, watchlistRowToItem, type AnalysisRow, type WatchlistRow } from "./user-research-db";

describe("user research row mapping", () => {
  test("keeps watchlist rows isolated by fixed account user id", () => {
    const row: WatchlistRow = {
      id: "watch-1",
      user_id: "user-a",
      user_key: "legacy-a",
      company_name: "贵州茅台",
      ticker: "600519",
      market: "SH-A",
      exchange_name: "上海证券交易所",
      listing_place: "SH-A",
      market_type: "AStock",
      source: "eastmoney",
      report_library_id: "library-1",
      added_at: "2026-05-15T00:00:00.000Z",
    };

    expect(watchlistRowToItem(row)).toMatchObject({
      id: "watch-1",
      userId: "user-a",
      company: { name: "贵州茅台", code: "600519" },
    });
  });

  test("maps template task status and R2 markdown key into analysis metadata", () => {
    const row: AnalysisRow = {
      id: "analysis-1",
      user_id: "user-a",
      user_key: "legacy-a",
      watchlist_id: "watch-1",
      template_id: "template-01-company-value",
      template_title: "模板01：公司价值分析",
      company_name: "贵州茅台",
      ticker: "600519",
      market: "SH-A",
      model: "deepseek-v4-flash",
      title: "贵州茅台公司价值分析",
      score: 82,
      verdict: "持有",
      summary: "摘要",
      status: "completed",
      object_key: "user-research/v1/user-a/watch-1/template.md",
      content_json: JSON.stringify({ keyPoints: ["品牌"], riskFlags: ["估值"], followUps: ["批价"], sections: [] }),
      created_at: "2026-05-15T00:00:00.000Z",
      updated_at: "2026-05-15T00:00:00.000Z",
      started_at: "2026-05-15T00:00:00.000Z",
      completed_at: "2026-05-15T00:05:00.000Z",
      error_message: null,
    };

    expect(analysisRowToResult(row)).toMatchObject({
      id: "analysis-1",
      userId: "user-a",
      status: "completed",
      objectKey: "user-research/v1/user-a/watch-1/template.md",
    });
  });
});
