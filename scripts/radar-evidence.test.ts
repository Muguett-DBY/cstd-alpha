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
      sources?: Array<{ source?: string; query?: string; title?: string; url?: string; sourceType?: string; weight?: number }>;
    };

    expect(snapshot).toMatchObject({
      version: "v1",
      source: "github-actions-python",
    });
    expect(snapshot.evidenceHash).toMatch(/^[a-z0-9]+$/);
    expect(snapshot.sources?.length).toBeGreaterThanOrEqual(36);
    expect(snapshot.sources?.every((source) => source.source && source.query && source.title && typeof source.weight === "number")).toBe(true);
    expect(snapshot.sources?.some((source) => source.sourceType === "hard_data")).toBe(true);
    expect(snapshot.sources?.some((source) => source.sourceType === "market")).toBe(true);
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
