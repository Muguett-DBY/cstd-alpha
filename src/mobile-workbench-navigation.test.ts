import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");

describe("mobile workbench navigation", () => {
  test("removes the duplicate rail navigation when the bottom navigation is active", () => {
    expect(css).toMatch(
      /\.app-shell:not\(\.view-assistant\) \.workbench-nav-rail \.view-tabs\s*\{\s*display:\s*none;/,
    );
  });

  test("removes duplicate input rail navigation on compact non-assistant pages", () => {
    expect(css).toMatch(
      /\.app-shell:not\(\.view-assistant\) \.input-rail \.view-tabs\s*\{\s*display:\s*none;/,
    );
  });

  test("hides the desktop rail explanation on compact workbench screens", () => {
    expect(css).toMatch(
      /\.app-shell:not\(\.view-assistant\) \.workbench-nav-rail \.rail-copy\s*\{\s*display:\s*none;/,
    );
  });
});
