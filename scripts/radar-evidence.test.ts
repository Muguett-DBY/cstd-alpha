import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("rolling radar evidence collector", () => {
  test("generates a valid offline evidence snapshot without any DeepSeek dependency", () => {
    const script = "scripts/collect_radar_evidence.py";
    const source = readFileSync(script, "utf8");
    expect(source).not.toMatch(/DEEPSEEK|deepseek/i);

    const outputPath = join(mkdtempSync(join(tmpdir(), "radar-evidence-")), "radar-evidence.json");
    execFileSync("python", [script, "--offline-fixture", "--output", outputPath], { stdio: "pipe" });
    const snapshot = JSON.parse(readFileSync(outputPath, "utf8")) as {
      version?: string;
      source?: string;
      evidenceHash?: string;
      quality?: { googleNewsShare?: number; structuredShare?: number; uniqueSources?: number };
      sources?: Array<{ source?: string; query?: string; title?: string; url?: string; sourceType?: string; weight?: number }>;
    };
    const sources = snapshot.sources ?? [];
    const googleSources = sources.filter((source) => source.source === "Google News");
    const structuredSources = sources.filter((source) => source.source !== "Google News" && source.sourceType !== "news");

    expect(snapshot).toMatchObject({
      version: "v1",
      source: "github-actions-python",
    });
    expect(snapshot.evidenceHash).toMatch(/^[a-z0-9]+$/);
    expect(sources.length).toBeGreaterThanOrEqual(36);
    expect(sources.every((source) => source.source && source.query && source.title && typeof source.weight === "number")).toBe(true);
    expect(sources.some((source) => source.sourceType === "hard_data")).toBe(true);
    expect(sources.some((source) => source.sourceType === "market")).toBe(true);
    expect(googleSources.length / sources.length).toBeLessThanOrEqual(0.5);
    expect(googleSources.every((source) => source.sourceType === "news")).toBe(true);
    expect(structuredSources.length).toBeGreaterThanOrEqual(30);
    expect(snapshot.quality).toMatchObject({
      googleNewsShare: expect.any(Number),
      structuredShare: expect.any(Number),
      uniqueSources: expect.any(Number),
    });
  });

  test("refuses to emit a live-quality snapshot when evidence is only Google News", () => {
    const script = "scripts/collect_radar_evidence.py";
    const outputPath = join(mkdtempSync(join(tmpdir(), "radar-evidence-")), "radar-evidence.json");

    expect(() => execFileSync("python", [script, "--offline-google-only", "--output", outputPath], { stdio: "pipe" })).toThrow();
  });

  test("has a scheduled GitHub Action that uploads evidence but does not call DeepSeek", () => {
    const workflow = ".github/workflows/radar-evidence.yml";

    expect(existsSync(workflow)).toBe(true);
    const text = readFileSync(workflow, "utf8");
    expect(text).toContain("collect_radar_evidence.py");
    expect(text).toContain("RADAR_EVIDENCE_KV_NAMESPACE_ID");
    expect(text).not.toMatch(/DEEPSEEK|deepseek/i);
  });
});
