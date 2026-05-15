import { describe, expect, test } from "vitest";
import {
  FULL_ANALYSIS_MARKDOWN_MIN_CHARS,
  FULL_ANALYSIS_TEMPLATE_ID,
  RESEARCH_TEMPLATES,
  TEMPLATE_MARKDOWN_MIN_CHARS,
  completedTemplateAnalysesForFull,
  isFullAnalysisReady,
  isRetryableTemplateStatus,
  minimumResearchMarkdownChars,
  missingTemplateIdsForFull,
  type TemplateAnalysisResult,
} from "./user-research";

describe("user research templates", () => {
  test("uses full source templates for every deep template analysis", () => {
    expect(RESEARCH_TEMPLATES).toHaveLength(10);
    expect(RESEARCH_TEMPLATES.reduce((sum, template) => sum + template.fullPrompt.length, 0)).toBeGreaterThan(18000);
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

  test("requires every exact template to complete before a full ten-template analysis is ready", () => {
    const completed = RESEARCH_TEMPLATES.map((template, index) => analysisFor(template.id, index));

    expect(isFullAnalysisReady(completed)).toBe(true);
    expect(completedTemplateAnalysesForFull(completed).map((analysis) => analysis.templateId)).toEqual(RESEARCH_TEMPLATES.map((template) => template.id));
    expect(missingTemplateIdsForFull(completed)).toEqual([]);

    const missingOne = completed.slice(0, -1);
    expect(isFullAnalysisReady(missingOne)).toBe(false);
    expect(missingTemplateIdsForFull(missingOne)).toEqual([RESEARCH_TEMPLATES.at(-1)?.id]);

    const withFailedAndFullSummaryOnly = [
      ...missingOne,
      { ...analysisFor(RESEARCH_TEMPLATES.at(-1)?.id || "", 99), status: "failed_retryable" as const },
      analysisFor(FULL_ANALYSIS_TEMPLATE_ID, 100),
    ];
    expect(isFullAnalysisReady(withFailedAndFullSummaryOnly)).toBe(false);
    expect(completedTemplateAnalysesForFull(withFailedAndFullSummaryOnly)).toHaveLength(RESEARCH_TEMPLATES.length - 1);
  });

  test("keeps long-form minimum lengths explicit for model quality gates", () => {
    for (const template of RESEARCH_TEMPLATES) {
      expect(minimumResearchMarkdownChars(template.id)).toBe(TEMPLATE_MARKDOWN_MIN_CHARS);
    }
    expect(minimumResearchMarkdownChars(FULL_ANALYSIS_TEMPLATE_ID)).toBe(FULL_ANALYSIS_MARKDOWN_MIN_CHARS);
    expect(TEMPLATE_MARKDOWN_MIN_CHARS).toBeGreaterThanOrEqual(4500);
    expect(FULL_ANALYSIS_MARKDOWN_MIN_CHARS).toBeGreaterThanOrEqual(5000);
  });
});

function analysisFor(templateId: string, index: number): TemplateAnalysisResult {
  return {
    id: `analysis-${index}`,
    userId: "user-a",
    watchlistId: "watch-1",
    templateId,
    templateTitle: `模板 ${index}`,
    companyName: "贵州茅台",
    ticker: "600519",
    market: "SH-A",
    model: "deepseek-v4-flash-free",
    status: "completed",
    title: "贵州茅台专项分析",
    verdict: "观察",
    summary: "摘要",
    keyPoints: [],
    riskFlags: [],
    followUps: [],
    sections: [],
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}
