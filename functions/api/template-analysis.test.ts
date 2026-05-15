import { describe, expect, test } from "vitest";
import { RESEARCH_TEMPLATES } from "../../src/shared/user-research";
import { runFullTemplateChildrenCacheAware, shouldStartFullAnalysis } from "./template-analysis";

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

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
