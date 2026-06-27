import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Vite modulepreload policy", () => {
  test("defers heavy authenticated chunks from the HTML login shell", () => {
    const source = readFileSync("vite.config.ts", "utf8");

    expect(source).toContain("deferredEntryPreloadChunks");
    expect(source).toContain("vendor-react");
    expect(source).toContain("vendor-docx");
    expect(source).toContain("vendor-tanstack");
    expect(source).toContain("resolveDependencies");
    expect(source).toContain("/node_modules/");
  });
});
