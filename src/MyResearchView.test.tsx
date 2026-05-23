import { describe, expect, test } from "vitest";
import { normalizeMarkdownForReading } from "./markdown-report";
import { RESEARCH_TEMPLATES, type TemplateAnalysisResult, type WatchlistItem } from "./shared/user-research";
import { buildFullAnalysisTemplateCardState, resolveTemplateManagerView, shouldScrollTemplateEditor } from "./template-manager-state";
import { filterWatchlistItems, summarizeWatchlistAnalysis } from "./my-research-state";

describe("template manager navigation", () => {
  test("keeps a valid template edit screen selected", () => {
    expect(resolveTemplateManagerView("edit", RESEARCH_TEMPLATES[0].id, RESEARCH_TEMPLATES)).toEqual({
      view: "edit",
      editingTemplateId: RESEARCH_TEMPLATES[0].id,
    });
  });

  test("returns to the list when the edited template no longer exists", () => {
    expect(resolveTemplateManagerView("edit", "missing-template", RESEARCH_TEMPLATES)).toEqual({
      view: "list",
      editingTemplateId: "",
    });
  });

  test("returns to the overview when no templates remain", () => {
    expect(resolveTemplateManagerView("edit", "missing-template", [])).toEqual({
      view: "summary",
      editingTemplateId: "",
    });
  });

  test("scrolls the editor into view when opening or switching template edits", () => {
    expect(shouldScrollTemplateEditor("list", "", "edit", RESEARCH_TEMPLATES[10].id)).toBe(true);
    expect(shouldScrollTemplateEditor("edit", RESEARCH_TEMPLATES[0].id, "edit", RESEARCH_TEMPLATES[10].id)).toBe(true);
    expect(shouldScrollTemplateEditor("edit", RESEARCH_TEMPLATES[0].id, "edit", RESEARCH_TEMPLATES[0].id)).toBe(false);
    expect(shouldScrollTemplateEditor("edit", RESEARCH_TEMPLATES[0].id, "list", "")).toBe(false);
  });
});

describe("full analysis template card", () => {
  test("keeps the full analysis entry available when templates are enabled", () => {
    expect(buildFullAnalysisTemplateCardState(3, "ready")).toEqual({
      title: "全部模板全面分析",
      focus: "先生成 3 个启用模板的深度报告，再汇总成最终全面分析。",
      disabled: false,
    });
  });

  test("disables full analysis only when no templates are enabled or generation is running", () => {
    expect(buildFullAnalysisTemplateCardState(0, "ready").disabled).toBe(true);
    expect(buildFullAnalysisTemplateCardState(3, "generating").disabled).toBe(true);
  });
});

describe("markdown report normalization", () => {
  test("turns escaped newlines from model output into real markdown breaks", () => {
    const markdown = "## 估值分析\\n\\n### DCF\\n使用TTM自由现金流。\\n\\n| 项目 | 分数 |\\n| --- | --- |\\n| 财务 | 95 |";

    const normalized = normalizeMarkdownForReading(markdown);

    expect(normalized).toContain("## 估值分析\n\n### DCF");
    expect(normalized).toContain("| 项目 | 分数 |\n| --- | --- |");
    expect(normalized).not.toContain("\\n");
  });
});

describe("my research watchlist state", () => {
  test("filters watchlist items by company name, ticker, market, and exchange", () => {
    const items = [
      watchlistItem("1", "英伟达", "NVDA", "美股", "NASDAQ"),
      watchlistItem("2", "腾讯控股", "00700", "港股", "HKEX"),
      watchlistItem("3", "贵州茅台", "600519", "A股", "SSE"),
    ];

    expect(filterWatchlistItems(items, "nvda").map((item) => item.id)).toEqual(["1"]);
    expect(filterWatchlistItems(items, "港股").map((item) => item.id)).toEqual(["2"]);
    expect(filterWatchlistItems(items, "sse").map((item) => item.id)).toEqual(["3"]);
    expect(filterWatchlistItems(items, "腾讯").map((item) => item.id)).toEqual(["2"]);
  });

  test("returns all watchlist items for empty search and no items for misses", () => {
    const items = [watchlistItem("1", "英伟达", "NVDA", "美股", "NASDAQ")];

    expect(filterWatchlistItems(items, "")).toHaveLength(1);
    expect(filterWatchlistItems(items, "不存在")).toHaveLength(0);
  });

  test("summarizes completed and running template analyses for the selected company", () => {
    const analyses = [
      analysis("a1", "watch-a", "completed"),
      analysis("a2", "watch-a", "running"),
      analysis("a3", "watch-a", "failed_retryable"),
      analysis("a4", "watch-b", "completed"),
    ];

    expect(summarizeWatchlistAnalysis(analyses, "watch-a")).toEqual({
      total: 3,
      completed: 1,
      running: 1,
      failed: 1,
    });
  });
});

function watchlistItem(id: string, name: string, code: string, listingPlace: string, exchange: string): WatchlistItem {
  return {
    id,
    userId: "admin",
    company: {
      id: code,
      name,
      code,
      exchange,
      currency: listingPlace === "美股" ? "USD" : "CNY",
      listingPlace,
      marketType: listingPlace,
    },
    addedAt: "2026-05-24T00:00:00.000Z",
  };
}

function analysis(id: string, watchlistId: string, status: TemplateAnalysisResult["status"]): TemplateAnalysisResult {
  return {
    id,
    userId: "admin",
    watchlistId,
    templateId: "template-1",
    templateTitle: "模板",
    templateShortTitle: "模板",
    company: watchlistItem(watchlistId, "英伟达", "NVDA", "美股", "NASDAQ").company,
    status,
    model: "deepseek-v4-flash",
    score: null,
    conclusion: "",
    summary: "",
    markdown: "",
    strengths: [],
    risks: [],
    followUps: [],
    evidenceIds: [],
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
}
