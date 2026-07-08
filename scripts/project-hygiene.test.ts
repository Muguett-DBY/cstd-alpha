import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const parseJsoncFile = <T>(path: string): T => {
  const jsonc = readFileSync(path, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");

  return JSON.parse(jsonc) as T;
};

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

  test("keeps Cloudflare compatibility date on the current production baseline", () => {
    const wranglerConfig = parseJsoncFile<{ compatibility_date?: string }>(
      "wrangler.jsonc",
    );
    const compatibilityDate = wranglerConfig.compatibility_date;

    expect(compatibilityDate).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );

    if (compatibilityDate === undefined) {
      throw new Error("wrangler.jsonc must define compatibility_date");
    }

    const compatibilityTimestamp = Date.parse(
      `${compatibilityDate}T00:00:00.000Z`,
    );
    const baselineTimestamp = Date.parse("2026-07-01T00:00:00.000Z");

    expect(compatibilityTimestamp).toBeGreaterThanOrEqual(baselineTimestamp);
  });
});
