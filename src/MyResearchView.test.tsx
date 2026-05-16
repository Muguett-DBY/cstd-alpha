import { describe, expect, test } from "vitest";
import { RESEARCH_TEMPLATES } from "./shared/user-research";
import { resolveTemplateManagerView } from "./template-manager-state";

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
