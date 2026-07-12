import { describe, expect, test } from "vitest";
import {
  FULL_ANALYSIS_MARKDOWN_MIN_CHARS,
  FULL_ANALYSIS_TEMPLATE_ID,
  RESEARCH_TEMPLATES,
  completedTemplateAnalysesForFull,
  describeTemplateResearchDataHealth,
  isFullAnalysisReady,
  isRetryableTemplateStatus,
  missingTemplateIdsForFull,
  normalizeTemplateSectionRequirements,
  type TemplateAnalysisResult,
} from "./user-research";

describe("user research templates", () => {
  test("uses full source templates for every deep template analysis", () => {
    expect(RESEARCH_TEMPLATES).toHaveLength(11);
    expect(RESEARCH_TEMPLATES.at(-1)).toMatchObject({
      id: "template-11-capital-allocation",
      shortTitle: "资金配置",
    });
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

  test("describes skipped template research data with a reload action", () => {
    expect(describeTemplateResearchDataHealth(1, 2, 8, 11)).toEqual({
      title: "模板研究已跳过 3 条异常记录",
      detail: "异常范围：1 条模板报告、2 个模板。本次保留 8 条可用模板报告、11 个可用模板；源数据未被修改，可重新读取检查是否已恢复。",
      actionLabel: "重新读取",
    });
    expect(describeTemplateResearchDataHealth(0, 0, 8, 11)).toBeNull();
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

  test("can evaluate full analysis readiness against the user's enabled templates", () => {
    const enabledTemplates = RESEARCH_TEMPLATES.slice(0, 2);
    const completed = enabledTemplates.map((template, index) => analysisFor(template.id, index));

    expect(isFullAnalysisReady(completed, enabledTemplates)).toBe(true);
    expect(completedTemplateAnalysesForFull(completed, enabledTemplates).map((analysis) => analysis.templateId)).toEqual(enabledTemplates.map((template) => template.id));
    expect(missingTemplateIdsForFull(completed, enabledTemplates)).toEqual([]);
    expect(isFullAnalysisReady(completed.slice(0, 1), enabledTemplates)).toBe(false);
  });

  test("derives per-section completion requirements instead of a global markdown length gate", () => {
    for (const template of RESEARCH_TEMPLATES) {
      const requirements = normalizeTemplateSectionRequirements(template);
      expect(requirements.length).toBeGreaterThan(0);
      expect(requirements.every((item) => item.minChars >= 80)).toBe(true);
      expect(requirements.every((item) => item.requiredPoints.includes("结论"))).toBe(true);
      expect(requirements.every((item) => item.requiredPoints.includes("证据依据"))).toBe(true);
    }
    expect(FULL_ANALYSIS_MARKDOWN_MIN_CHARS).toBeGreaterThanOrEqual(5000);
  });

  test("normalizes custom template section requirements for newly added templates", () => {
    const requirements = normalizeTemplateSectionRequirements({
      id: "custom-operator",
      title: "模板12：经营者视角",
      shortTitle: "经营者",
      focus: "按经营者视角分析。",
      prompt: "分析公司。",
      fullPrompt: "1. 商业模式\n2. 团队治理\n3. 估值纪律\n请按照以上模板分析（      ）公司。",
      sectionRequirements: [
        { id: "business", title: "商业模式", minChars: 40, requiredPoints: ["结论"] },
        { id: "", title: "", minChars: 1000, requiredPoints: [] },
      ],
    });

    expect(requirements).toEqual([
      { id: "business", title: "商业模式", minChars: 80, requiredPoints: ["结论", "证据依据", "反证条件", "跟踪指标"] },
      { id: "section-2", title: "第 2 项", minChars: 800, requiredPoints: ["结论", "证据依据", "反证条件", "跟踪指标"] },
    ]);
  });

  test("bounds custom template section requirement text before model prompts use it", () => {
    const requirements = normalizeTemplateSectionRequirements({
      id: "custom-operator",
      title: "模板12：经营者视角",
      shortTitle: "经营者",
      focus: "按经营者视角分析。",
      prompt: "分析公司。",
      fullPrompt: "1. 商业模式\n请按照以上模板分析（      ）公司。",
      sectionRequirements: [
        {
          id: "business",
          title: "商业模式",
          minChars: 180,
          requiredPoints: ["x".repeat(240), "结论", "证据依据", "反证条件", "跟踪指标", "额外观察"],
        },
      ],
    });

    expect(requirements).toHaveLength(1);
    expect(requirements[0].requiredPoints).toEqual(["结论", "证据依据", "反证条件", "跟踪指标", "x".repeat(120), "额外观察"]);
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
    model: "deepseek-v4-flash",
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
