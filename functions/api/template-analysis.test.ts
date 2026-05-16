import { describe, expect, test } from "vitest";
import { FULL_ANALYSIS_TEMPLATE_ID, RESEARCH_TEMPLATES } from "../../src/shared/user-research";
import {
  buildChildTemplateReportsForPrompt,
  isUsableTemplateAnalysisCache,
  normalizeGeneratedAnalysis,
  runFullTemplateChildrenCacheAware,
  shouldStartFullAnalysis,
  templateReasoningEffort,
} from "./template-analysis";

describe("runFullTemplateChildrenCacheAware", () => {
  test("reuses cached templates and warms two uncached jobs before starting the rest concurrently", async () => {
    const activeTemplates = RESEARCH_TEMPLATES.slice(0, 3);
    const cachedIds = new Set([activeTemplates[0].id]);
    const started: string[] = [];
    const released: string[] = [];
    const releaseJobs = new Map<string, () => void>();

    const resultPromise = runFullTemplateChildrenCacheAware({
      templates: activeTemplates,
      readCached: async (template) => (cachedIds.has(template.id) ? `cached:${template.id}` : null),
      runUncached: async (template) => {
        started.push(template.id);
        await new Promise<void>((resolve) => releaseJobs.set(template.id, resolve));
        released.push(template.id);
        return `fresh:${template.id}`;
      },
    });

    await nextTick();

    expect(started).toEqual([activeTemplates[1].id]);
    releaseJobs.get(activeTemplates[1].id)?.();
    await nextTick();

    expect(started).toEqual([activeTemplates[1].id, activeTemplates[2].id]);
    expect(released).toEqual([activeTemplates[1].id]);
    releaseJobs.get(activeTemplates[2].id)?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(activeTemplates.filter((template) => !cachedIds.has(template.id)).map((template) => template.id));
    for (const template of activeTemplates) releaseJobs.get(template.id)?.();

    await expect(resultPromise).resolves.toEqual(
      activeTemplates.map((template) => (cachedIds.has(template.id) ? `cached:${template.id}` : `fresh:${template.id}`)),
    );
  });
});

describe("shouldStartFullAnalysis", () => {
  test("does not duplicate a running full analysis unless forced", () => {
    expect(shouldStartFullAnalysis(null, false)).toBe(true);
    expect(shouldStartFullAnalysis({ status: "running" } as Parameters<typeof shouldStartFullAnalysis>[0], false)).toBe(false);
    expect(shouldStartFullAnalysis({ status: "running" } as Parameters<typeof shouldStartFullAnalysis>[0], true)).toBe(true);
    expect(shouldStartFullAnalysis({ status: "failed_retryable" } as Parameters<typeof shouldStartFullAnalysis>[0], false)).toBe(true);
  });
});

describe("templateReasoningEffort", () => {
  test("uses high for single templates and max for full synthesis", () => {
    expect(templateReasoningEffort(RESEARCH_TEMPLATES[0].id)).toBe("high");
    expect(templateReasoningEffort(FULL_ANALYSIS_TEMPLATE_ID)).toBe("max");
  });
});

describe("buildChildTemplateReportsForPrompt", () => {
  test("includes bounded child markdown excerpts for full synthesis", () => {
    const reports = buildChildTemplateReportsForPrompt([
      {
        templateTitle: "模板一",
        summary: "摘要",
        verdict: "观察",
        score: 70,
        keyPoints: ["要点"],
        riskFlags: ["风险"],
        followUps: ["跟踪"],
        markdown: "A".repeat(8000),
      } as Parameters<typeof buildChildTemplateReportsForPrompt>[0][number],
    ]);

    expect(reports[0].markdownChars).toBe(8000);
    expect(reports[0].markdownExcerpt).toContain("后文因上下文长度限制截断");
    expect((reports[0].markdownExcerpt ?? "").length).toBeLessThanOrEqual(7050);
  });
});

describe("isUsableTemplateAnalysisCache", () => {
  test("requires completed status, object key and minimum markdown length", () => {
    const base = {
      templateId: RESEARCH_TEMPLATES[0].id,
      status: "completed",
      objectKey: "user-research/v1/u/w/template.md",
      markdown: "深度报告正文".repeat(1200),
    } as Parameters<typeof isUsableTemplateAnalysisCache>[0];

    expect(isUsableTemplateAnalysisCache(base)).toBe(true);
    expect(isUsableTemplateAnalysisCache({ ...base, markdown: "太短" })).toBe(false);
    expect(isUsableTemplateAnalysisCache({ ...base, objectKey: undefined })).toBe(false);
    expect(isUsableTemplateAnalysisCache({ ...base, status: "running" })).toBe(false);
  });
});

describe("normalizeGeneratedAnalysis score discipline", () => {
  test("caps high scores from custom templates when the report identifies hard red flags", () => {
    const analysis = normalizeGeneratedAnalysis(
      {
        title: "差公司模板报告",
        score: 92,
        verdict: "买入",
        summary: "公司处于行业衰退期，主营收入持续下滑，经营现金流为负，负债率高企，治理混乱。",
        keyPoints: ["估值看似便宜"],
        riskFlags: ["行业衰退", "经营现金流为负", "负债率高企", "治理混乱", "明显高估"],
        followUps: ["复核现金流"],
        markdown:
          "## 结论\n公司处于行业衰退期，主营收入持续下滑，经营现金流为负，负债率高企，治理混乱，明显不适合长期股权投资。",
      },
      customTemplate(),
    );

    expect(analysis.score).toBeLessThanOrEqual(49);
    expect(analysis.verdict).toContain("回避");
    expect(analysis.riskFlags).toContain("后端保守评分约束：报告识别到重大经营、财务、治理、估值或产业红线，已限制模板总分。");
  });

  test("caps top-level scores that are far above the markdown item-score average", () => {
    const analysis = normalizeGeneratedAnalysis(
      {
        title: "分项偏弱模板报告",
        score: 88,
        verdict: "持有",
        summary: "分项评分整体偏弱，顶层分数不应明显高于分项平均。",
        keyPoints: ["仍有少量资产价值"],
        riskFlags: ["增长疲弱"],
        followUps: ["跟踪利润修复"],
        markdown: [
          "## 1. 商业模式评估（35分）",
          "## 2. 财务健康度（40分）",
          "## 3. 治理质量（45分）",
          "## 4. 估值安全边际（50分）",
        ].join("\n\n"),
      },
      customTemplate(),
    );

    expect(analysis.score).toBeLessThanOrEqual(48);
    expect(analysis.riskFlags).toContain("后端保守评分约束：顶层分数明显高于正文分项平均，已按分项均值限制总分。");
  });
});

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function customTemplate() {
  return {
    id: "custom-strict-template",
    title: "自定义严格模板",
    shortTitle: "自定义",
    focus: "自定义模板也应继承后端评分约束。",
    prompt: "给出评分。",
    fullPrompt: "请严格评分。",
  };
}
