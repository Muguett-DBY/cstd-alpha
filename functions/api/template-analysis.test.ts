import { describe, expect, test } from "vitest";
import { FULL_ANALYSIS_TEMPLATE_ID, RESEARCH_TEMPLATES } from "../../src/shared/user-research";
import { buildChildTemplateReportsForPrompt, runFullTemplateChildrenCacheAware, shouldStartFullAnalysis, templateReasoningEffort } from "./template-analysis";

describe("runFullTemplateChildrenCacheAware", () => {
  test("reuses cached templates and warms two uncached jobs before starting the rest concurrently", async () => {
    const cachedIds = new Set([RESEARCH_TEMPLATES[0].id, RESEARCH_TEMPLATES[3].id]);
    const started: string[] = [];
    const released: string[] = [];
    const releaseJobs = new Map<string, () => void>();

    const resultPromise = runFullTemplateChildrenCacheAware({
      readCached: async (template) => (cachedIds.has(template.id) ? `cached:${template.id}` : null),
      runUncached: async (template) => {
        started.push(template.id);
        await new Promise<void>((resolve) => releaseJobs.set(template.id, resolve));
        released.push(template.id);
        return `fresh:${template.id}`;
      },
    });

    await nextTick();

    expect(started).toEqual([RESEARCH_TEMPLATES[1].id]);
    releaseJobs.get(RESEARCH_TEMPLATES[1].id)?.();
    await nextTick();

    expect(started).toEqual([RESEARCH_TEMPLATES[1].id, RESEARCH_TEMPLATES[2].id]);
    expect(released).toEqual([RESEARCH_TEMPLATES[1].id]);
    releaseJobs.get(RESEARCH_TEMPLATES[2].id)?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(RESEARCH_TEMPLATES.filter((template) => !cachedIds.has(template.id)).map((template) => template.id));
    for (const template of RESEARCH_TEMPLATES) releaseJobs.get(template.id)?.();

    await expect(resultPromise).resolves.toEqual(
      RESEARCH_TEMPLATES.map((template) => (cachedIds.has(template.id) ? `cached:${template.id}` : `fresh:${template.id}`)),
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

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
