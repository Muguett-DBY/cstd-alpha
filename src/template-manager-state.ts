import type { ResearchTemplate } from "./shared/user-research";

export type TemplateManagerView = "summary" | "list" | "edit";
export type TemplateGenerationPhase = "loading" | "ready" | "generating" | "error";

export function resolveTemplateManagerView(
  view: TemplateManagerView,
  editingTemplateId: string,
  templates: ResearchTemplate[],
): { view: TemplateManagerView; editingTemplateId: string } {
  if (view !== "edit") return { view, editingTemplateId: "" };
  if (templates.some((template) => template.id === editingTemplateId)) return { view, editingTemplateId };
  return { view: templates.length ? "list" : "summary", editingTemplateId: "" };
}

export function buildFullAnalysisTemplateCardState(
  enabledTemplateCount: number,
  phase: TemplateGenerationPhase,
): { title: string; focus: string; disabled: boolean } {
  return {
    title: "全部模板全面分析",
    focus: `先生成 ${enabledTemplateCount} 个启用模板的深度报告，再汇总成最终全面分析。`,
    disabled: phase === "generating" || enabledTemplateCount <= 0,
  };
}
