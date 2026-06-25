import { describe, expect, test } from "vitest";
import { scenarioBarHeight } from "./valuation-scenario-chart-state";

describe("valuation scenario chart", () => {
  test("maps scenario values to stable pixel heights", () => {
    expect(scenarioBarHeight(0, 400)).toBe(32);
    expect(scenarioBarHeight(200, 400)).toBe(86);
    expect(scenarioBarHeight(400, 400)).toBe(140);
  });

  test("keeps invalid or negative values inside the visible chart range", () => {
    expect(scenarioBarHeight(-10, 0)).toBe(32);
    expect(scenarioBarHeight(Number.NaN, 100)).toBe(32);
  });
});
