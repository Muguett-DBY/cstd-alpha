import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("project hygiene", () => {
  test("keeps required install scripts explicitly approved", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      allowScripts?: Record<string, boolean>;
    };

    expect(packageJson.allowScripts).toMatchObject({
      "esbuild@0.28.1": true,
      "sharp@0.34.5": true,
      "workerd@1.20260625.1": true,
    });
  });

  test("does not hide batch script failures behind empty catch blocks", () => {
    const batchScript = readFileSync("scripts/opencode-report-batch.ps1", "utf8");

    expect(batchScript).not.toMatch(/catch\s*\{\s*\}/);
    expect(batchScript).toContain("Could not remove stale lock");
    expect(batchScript).toContain("malformed opencode event line");
    expect(batchScript).toContain("Could not remove lock");
  });
});
