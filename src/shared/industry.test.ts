import { describe, expect, test } from "vitest";

import { formatIndustryLabel, normalizeIndustryLabel } from "./industry";

describe("industry labels", () => {
  test("normalizes placeholders to the formal unknown label", () => {
    expect(formatIndustryLabel("行业待验证")).toBe("未分类");
    expect(formatIndustryLabel("AStock")).toBe("未分类");
  });

  test("translates common English market labels", () => {
    expect(normalizeIndustryLabel("Diversified")).toBe("综合");
    expect(formatIndustryLabel("Healthcare")).toBe("医疗保健");
    expect(formatIndustryLabel("Medical Instruments")).toBe("医疗器械");
  });
});
