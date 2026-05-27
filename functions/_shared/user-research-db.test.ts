import { describe, expect, test } from "vitest";
import { RESEARCH_TEMPLATES, type ResearchTemplate } from "../../src/shared/user-research";
import { analysisRowToResult, saveUserResearchTemplates, watchlistRowToItem, type AnalysisRow, type ResearchTemplateRow, type WatchlistRow } from "./user-research-db";

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
      company: {
        name: "贵州茅台",
        code: "600519",
        marketType: "AStock",
        quoteId: "1.600519",
        secid: "1.600519",
        yahooSymbol: "600519.SS",
      },
    });
  });

  test("repairs legacy watchlist market metadata for A/H candidates", () => {
    const base = {
      user_id: "user-a",
      user_key: "legacy-a",
      exchange_name: null,
      market_type: null,
      source: "eastmoney",
      report_library_id: null,
      added_at: "2026-05-15T00:00:00.000Z",
    };

    expect(
      watchlistRowToItem({
        ...base,
        id: "watch-sh",
        company_name: "贵州茅台",
        ticker: "600519",
        market: "SH-A",
        listing_place: "SH-A",
      }).company,
    ).toMatchObject({
      marketType: "AStock",
      quoteId: "1.600519",
      yahooSymbol: "600519.SS",
      exchange: "上海证券交易所",
    });

    expect(
      watchlistRowToItem({
        ...base,
        id: "watch-sz",
        company_name: "宁德时代",
        ticker: "300750",
        market: "深A",
        listing_place: "深A",
      }).company,
    ).toMatchObject({
      marketType: "AStock",
      quoteId: "0.300750",
      yahooSymbol: "300750.SZ",
      exchange: "深圳证券交易所",
    });

    expect(
      watchlistRowToItem({
        ...base,
        id: "watch-hk",
        company_name: "腾讯控股",
        ticker: "00700",
        market: "HK",
        listing_place: "港股",
        market_type: "HK",
      }).company,
    ).toMatchObject({
      marketType: "HK",
      quoteId: "116.00700",
      yahooSymbol: "0700.HK",
      exchange: "香港交易所",
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

describe("user research template persistence", () => {
  test("saves a deleted template set without per-template lookup queries", async () => {
    const existingRows = RESEARCH_TEMPLATES.map((template, index) => templateRow(template, index + 1));
    const preparedSql: string[] = [];
    const batchedStatementCounts: number[] = [];
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          bind: () => ({
            all: async () => ({ results: sql.includes("deleted_at IS NULL") ? [existingRows[0]] : existingRows }),
            run: async () => undefined,
            first: async () => null,
          }),
          run: async () => undefined,
        };
      },
      batch: async (statements: unknown[]) => {
        batchedStatementCounts.push(statements.length);
        return [];
      },
    } as unknown as D1Database;

    await saveUserResearchTemplates(db, "admin", [RESEARCH_TEMPLATES[0]]);

    expect(preparedSql.some((sql) => sql.includes("WHERE user_key = ?1 AND id = ?2"))).toBe(false);
    expect(batchedStatementCounts).toEqual([1]);
    expect(preparedSql.some((sql) => sql.includes("id NOT IN"))).toBe(true);
  });
});

function templateRow(template: ResearchTemplate, sortOrder: number): ResearchTemplateRow {
  return {
    id: template.id,
    user_id: "admin",
    user_key: "admin",
    title: template.title,
    short_title: template.shortTitle,
    focus: template.focus,
    prompt: template.prompt,
    full_prompt: template.fullPrompt,
    section_requirements_json: JSON.stringify(template.sectionRequirements ?? []),
    enabled: template.enabled === false ? 0 : 1,
    sort_order: sortOrder,
    is_system: template.isSystem ? 1 : 0,
    deleted_at: null,
    default_title: template.title,
    default_short_title: template.shortTitle,
    default_focus: template.focus,
    default_prompt: template.prompt,
    default_full_prompt: template.fullPrompt,
    default_section_requirements_json: JSON.stringify(template.sectionRequirements ?? []),
    default_enabled: template.enabled === false ? 0 : 1,
    default_sort_order: sortOrder,
    default_is_system: template.isSystem ? 1 : 0,
    default_deleted_at: null,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
  };
}
