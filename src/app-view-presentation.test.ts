import { describe, expect, test } from "vitest";
import { resolveAppViewPresentation } from "./app-view-presentation";

describe("resolveAppViewPresentation", () => {
  test("keeps the selected workbench visible for a mobile admin", () => {
    expect(resolveAppViewPresentation("research", { isMobileViewport: true, role: "admin" })).toEqual({
      renderedView: "research",
      mobileAssistantLayout: false,
    });
  });

  test("uses the mobile assistant layout only when a mobile admin selects assistant", () => {
    expect(resolveAppViewPresentation("assistant", { isMobileViewport: true, role: "admin" })).toEqual({
      renderedView: "assistant",
      mobileAssistantLayout: true,
    });
  });

  test("leaves desktop and non-admin view selection unchanged", () => {
    expect(resolveAppViewPresentation("market", { isMobileViewport: false, role: "admin" })).toEqual({
      renderedView: "market",
      mobileAssistantLayout: false,
    });
    expect(resolveAppViewPresentation("valuation", { isMobileViewport: true, role: "user" })).toEqual({
      renderedView: "valuation",
      mobileAssistantLayout: false,
    });
  });
});
