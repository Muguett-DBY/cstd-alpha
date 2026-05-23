import { describe, expect, test } from "vitest";
import { normalizeMarkdownForReading } from "./markdown-report";
import { filterWatchlistItems, summarizeWatchlistAnalysis } from "./my-research-state";
import { RESEARCH_TEMPLATES } from "./shared/user-research";
import type { TemplateAnalysisResult, WatchlistItem } from "./shared/user-research";
import { buildFullAnalysisTemplateCardState, resolveTemplateManagerView, shouldScrollTemplateEditor } from "./template-manager-state";

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
  const watchlist: WatchlistItem[] = [
    watchlistItem("1", { name: "贵州茅台", code: "600519", listingPlace: "沪A", exchange: "上海证券交易所", marketType: "A股" }),
    watchlistItem("2", { name: "腾讯控股", code: "00700", listingPlace: "港股", exchange: "HKEX", marketType: "港股" }),
    watchlistItem("3", { name: "NVIDIA", code: "NVDA", listingPlace: "美股", exchange: "NASDAQ", marketType: "美股" }),
  ];

  test("filters watchlist items by company name, ticker, market, and exchange", () => {
    expect(filterWatchlistItems(watchlist, "茅台").map((item) => item.id)).toEqual(["1"]);
    expect(filterWatchlistItems(watchlist, "00700").map((item) => item.id)).toEqual(["2"]);
    expect(filterWatchlistItems(watchlist, "nasdaq").map((item) => item.id)).toEqual(["3"]);
    expect(filterWatchlistItems(watchlist, "港股").map((item) => item.id)).toEqual(["2"]);
  });

  test("returns all watchlist items for empty search and no items for misses", () => {
    expect(filterWatchlistItems(watchlist, "").map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(filterWatchlistItems(watchlist, "不存在").map((item) => item.id)).toEqual([]);
  });

  test("summarizes completed and running template analyses for the selected company", () => {
    const analyses = [
      analysis("a1", "1", "completed"),
      analysis("a2", "1", "completed"),
      analysis("a3", "1", "running"),
      analysis("a4", "2", "completed"),
      analysis("a5", "1", "failed"),
    ];

    expect(summarizeWatchlistAnalysis(analyses, "1")).toEqual({
      total: 4,
      completed: 2,
      running: 1,
      failed: 1,
    });
  });
});

function watchlistItem(id: string, company: Partial<WatchlistItem["company"]>): WatchlistItem {
  return {
    id,
    userId: "admin",
    addedAt: "2026-05-24T00:00:00.000Z",
    company: {
      id,
      name: company.name || "",
      code: company.code || "",
      market: company.marketType || "",
      exchange: company.exchange || "",
      listingPlace: company.listingPlace || "",
      marketType: company.marketType || "",
      source: "test",
    },
  };
}

function analysis(id: string, watchlistId: string, status: TemplateAnalysisResult["status"]): TemplateAnalysisResult {
  return {
    id,
    userId: "admin",
    watchlistId,
    templateId: "template",
    templateTitle: "模板",
    companyName: "公司",
    ticker: "000001",
    market: "A股",
    model: "deepseek-v4-flash",
    status,
    title: "报告",
    verdict: "观察",
    summary: "",
    keyPoints: [],
    riskFlags: [],
    followUps: [],
    sections: [],
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
}
