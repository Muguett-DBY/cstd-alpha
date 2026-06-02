import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function trackedFiles() {
  return execSync("git ls-files", { encoding: "utf8" })
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => !file.startsWith("node_modules/") && !file.startsWith("dist/") && !file.startsWith(".wrangler/"));
}

describe("model routing security", () => {
  test("does not reintroduce official DeepSeek API routes or legacy switches", () => {
    const forbiddenPatterns = [
      ["DEEPSEEK", "_API", "_KEY"].join(""),
      ["api", "deepseek", "com"].join("."),
      ["Direct", "DeepSeek", "Api"].join(""),
    ];

    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      if (file === "scripts/model-routing-security.test.ts") continue;
      const text = readFileSync(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        if (text.includes(pattern)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
