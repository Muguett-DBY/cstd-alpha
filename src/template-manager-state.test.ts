import { describe, expect, test } from "vitest";
import { buildFullAnalysisTemplateCardState, resolveTemplateManagerView, shouldScrollTemplateEditor } from "./template-manager-state";
import type { ResearchTemplate } from "./shared/user-research";

function makeTemplate(overrides: Partial<ResearchTemplate> = {}): ResearchTemplate {
  return {
    id: "t1",
    title: "Test Template",
    shortTitle: "Test",
    focus: "Testing",
    prompt: "Analyze {{company_name}}",
    enabled: true,
    group: "quality",
    ...overrides,
  };
}

describe("resolveTemplateManagerView", () => {
  test("returns non-edit views unchanged", () => {
    expect(resolveTemplateManagerView("summary", "t1", [])).toEqual({ view: "summary", editingTemplateId: "" });
    expect(resolveTemplateManagerView("list", "t1", [])).toEqual({ view: "list", editingTemplateId: "" });
  });

  test("keeps edit view when editingTemplateId exists in templates", () => {
    const templates = [makeTemplate({ id: "t1" })];
    expect(resolveTemplateManagerView("edit", "t1", templates)).toEqual({ view: "edit", editingTemplateId: "t1" });
  });

  test("falls back to list when editingTemplateId is missing from templates and templates exist", () => {
    const templates = [makeTemplate({ id: "t2" })];
    expect(resolveTemplateManagerView("edit", "t1", templates)).toEqual({ view: "list", editingTemplateId: "" });
  });

  test("falls back to summary when no templates exist", () => {
    expect(resolveTemplateManagerView("edit", "t1", [])).toEqual({ view: "summary", editingTemplateId: "" });
  });
});

describe("shouldScrollTemplateEditor", () => {
  test("returns true when entering edit mode with valid id", () => {
    expect(shouldScrollTemplateEditor("list", "", "edit", "t1")).toBe(true);
  });

  test("returns false when already editing the same template", () => {
    expect(shouldScrollTemplateEditor("edit", "t1", "edit", "t1")).toBe(false);
  });

  test("returns false when not in edit mode", () => {
    expect(shouldScrollTemplateEditor("list", "", "list", "")).toBe(false);
  });

  test("returns false when editingTemplateId is empty", () => {
    expect(shouldScrollTemplateEditor("list", "", "edit", "")).toBe(false);
  });
});

describe("buildFullAnalysisTemplateCardState", () => {
  test("returns enabled state with template count", () => {
    const result = buildFullAnalysisTemplateCardState(5, "ready");
    expect(result.title).toBe("全部模板全面分析");
    expect(result.focus).toContain("5 个启用模板");
    expect(result.disabled).toBe(false);
  });

  test("returns disabled state when generating", () => {
    const result = buildFullAnalysisTemplateCardState(5, "generating");
    expect(result.disabled).toBe(true);
  });

  test("returns disabled state when no templates enabled", () => {
    const result = buildFullAnalysisTemplateCardState(0, "ready");
    expect(result.disabled).toBe(true);
  });
});
