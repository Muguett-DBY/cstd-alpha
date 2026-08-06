import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const parseJsoncFile = <T>(path: string): T => {
  const jsonc = readFileSync(path, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");

  return JSON.parse(jsonc) as T;
};

const readWorkflow = (name: string) => readFileSync(`.github/workflows/${name}`, "utf8");

describe("project hygiene", () => {
  test("keeps required install scripts explicitly approved", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      allowScripts?: Record<string, boolean>;
    };

    expect(packageJson.allowScripts).toMatchObject({
      "esbuild@0.28.1": true,
      "workerd@1.20260801.1": true,
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

  test("serializes long-running evidence and AI job workflows", () => {
    const longRunningWorkflows = [
      "company-evidence.yml",
      "radar-evidence.yml",
      "radar-analysis.yml",
      "template-analysis.yml",
      "watchlist-ranking.yml",
    ];

    for (const workflow of longRunningWorkflows) {
      const content = readWorkflow(workflow);

      expect(content).toMatch(/\nconcurrency:\n/);
      expect(content).toMatch(/cancel-in-progress:\s*false/);
    }

    for (const workflow of [
      "template-analysis.yml",
      "watchlist-ranking.yml",
    ]) {
      expect(readWorkflow(workflow)).toMatch(/\$\{\{\s*inputs\.job_id\s*\}\}/);
    }

    expect(readWorkflow("radar-analysis.yml")).toMatch(/group:\s*radar-analysis\s*$/m);

    for (const workflow of ["radar-analysis.yml", "template-analysis.yml", "watchlist-ranking.yml"]) {
      const content = readWorkflow(workflow);
      expect(content).toMatch(/run_token:/);
      expect(content).toMatch(/\$\{\{\s*inputs\.run_token\s*\}\}/);
    }
  });

  test("prepares the required R2 bucket before production deployment", () => {
    const deployment = readWorkflow("pages.yml");

    expect(deployment).toContain("ensure_assistant_bucket");
    expect(deployment).toContain("wrangler r2 bucket list");
    expect(deployment).toContain("wrangler r2 bucket create cstd-alpha-report-library");
  });
});
