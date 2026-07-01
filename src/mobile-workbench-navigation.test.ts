import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

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

  test("removes the report generation rail from the mobile mine workspace", () => {
    expect(css).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.app-shell\.view-mine \.input-rail\s*\{\s*display:\s*none;/,
    );
  });

  test("uses a compact tablet rail for the mine workspace instead of the report form", () => {
    expect(css).toMatch(
      /@media \(max-width: 1100px\)[\s\S]*\.app-shell\.view-mine \.report-form,[\s\S]*display:\s*none;/,
    );
  });

  test("exposes the active mobile destination to assistive technology", () => {
    expect(appSource).toContain('aria-current={renderedView === "opportunities" ? "page" : undefined}');
    expect(appSource).toContain('aria-current={renderedView === "research" || renderedView === "mine" || renderedView === "report" ? "page" : undefined}');
    expect(appSource).toContain('aria-current={renderedView === "market" || renderedView === "ranking" || renderedView === "watchlist-ranking" || renderedView === "radar" ? "page" : undefined}');
  });
});
