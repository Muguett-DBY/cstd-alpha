import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { PYODIDE_INDEX_URL, PYODIDE_RUNTIME_VERSION } from "./pyodide-runtime";

describe("pyodide runtime configuration", () => {
  test("loads CDN artifacts that exactly match the installed loader version", () => {
    const installedPyodideVersion = JSON.parse(readFileSync("node_modules/pyodide/package.json", "utf8")) as { version: string };

    expect(PYODIDE_RUNTIME_VERSION).toBe(installedPyodideVersion.version);
    expect(PYODIDE_INDEX_URL).toBe(`https://cdn.jsdelivr.net/pyodide/v${installedPyodideVersion.version}/full/`);
  });

  test("keeps the pyodide loader out of the Vite bundle", () => {
    const source = readFileSync("src/pyodide-runtime.ts", "utf8");

    expect(source).toContain("@vite-ignore");
    expect(source).not.toMatch(/import\s+\{[^}]*\}\s+from\s+["']pyodide["']/);
    expect(source).not.toMatch(/return\s+import\(["']pyodide["']\)/);
  });
});
