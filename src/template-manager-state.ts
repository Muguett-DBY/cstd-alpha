import type { ResearchTemplate } from "./shared/user-research";

export type TemplateManagerView = "summary" | "list" | "edit";

export function resolveTemplateManagerView(
  view: TemplateManagerView,
  editingTemplateId: string,
  templates: ResearchTemplate[],
): { view: TemplateManagerView; editingTemplateId: string } {
  if (view !== "edit") return { view, editingTemplateId: "" };
  if (templates.some((template) => template.id === editingTemplateId)) return { view, editingTemplateId };
  return { view: templates.length ? "list" : "summary", editingTemplateId: "" };
}
