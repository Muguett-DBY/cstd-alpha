import { describe, expect, test } from "vitest";
import { FULL_ANALYSIS_TEMPLATE_ID, RESEARCH_TEMPLATES, isRetryableTemplateStatus } from "./user-research";

describe("user research templates", () => {
  test("uses full source templates for every deep template analysis", () => {
    expect(RESEARCH_TEMPLATES).toHaveLength(10);
    for (const template of RESEARCH_TEMPLATES) {
      expect(template.fullPrompt.length).toBeGreaterThan(400);
      expect(template.fullPrompt).toContain("模板");
    }
  });

  test("marks model limit failures as retryable template tasks", () => {
    expect(isRetryableTemplateStatus("failed_retryable")).toBe(true);
    expect(isRetryableTemplateStatus("failed")).toBe(false);
    expect(FULL_ANALYSIS_TEMPLATE_ID).toBe("full");
  });
});
