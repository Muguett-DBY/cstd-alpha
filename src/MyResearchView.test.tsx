import { describe, expect, test } from "vitest";
import { normalizeMarkdownForReading } from "./markdown-report";
import { RESEARCH_TEMPLATES } from "./shared/user-research";
import { buildFullAnalysisTemplateCardState, resolveTemplateManagerView } from "./template-manager-state";

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
