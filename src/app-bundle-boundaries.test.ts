import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("app shell bundle boundaries", () => {
  test("does not statically import authenticated heavy views into the login shell", () => {
    const source = readFileSync("src/App.tsx", "utf8");
    const staticImportLines = source
      .split(/\r?\n/)
      .filter((line) => /^import\s+(?!type).*\sfrom\s+["']/.test(line.trim()));
    const staticViewImports = [
      "./ReportView",
      "./RadarView",
      "./ResearchWorkspace",
      "./MarketWorkspace",
      "./ValuationLabView",
      "./ReportCharts",
    ];

    for (const moduleName of staticViewImports) {
      expect(staticImportLines.some((line) => line.includes(`from "${moduleName}"`) || line.includes(`from '${moduleName}'`))).toBe(false);
    }
  });
});
