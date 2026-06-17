import { describe, expect, test } from "vitest";
import { formatLocalizedIndustry, localizedCompanyName, localizedIndustry } from "./market-display";

describe("localizedCompanyName", () => {
  test("returns Chinese name for known US ticker", () => {
    expect(localizedCompanyName("Apple Inc.", "AAPL", "美股")).toBe("苹果");
  });

  test("returns Chinese name for known HK ticker", () => {
    expect(localizedCompanyName("Tencent Holdings", "00700", "港股")).toBe("腾讯控股");
  });

  test("pads short HK ticker to 5 digits", () => {
    expect(localizedCompanyName("Tencent Holdings", "700", "港股")).toBe("腾讯控股");
  });

  test("normalizes US ticker separators", () => {
    expect(localizedCompanyName("Berkshire Hathaway", "BRK.B", "美股")).toBe("伯克希尔");
  });

  test("falls back to raw name for unknown ticker", () => {
    expect(localizedCompanyName("Unknown Corp", "ZZZZ", "美股")).toBe("Unknown Corp");
  });

  test("falls back to ticker string when name and mapping are missing", () => {
    expect(localizedCompanyName(undefined, "ZZZZ", "美股")).toBe("ZZZZ");
  });

  test("returns empty string for completely empty inputs", () => {
    expect(localizedCompanyName(undefined, undefined, "美股")).toBe("");
  });

  test("handles null market", () => {
    expect(localizedCompanyName("Test Co.", "TEST", null)).toBe("Test Co.");
  });

  test("returns empty string when all inputs are null", () => {
    expect(localizedCompanyName(null, null, null)).toBe("");
  });
});

describe("localizedIndustry", () => {
  test("returns known industry for AAPL", () => {
    const result = localizedIndustry("AAPL", "美股");
    expect(result).toEqual({ group: "电子", detail: "消费电子" });
  });

  test("returns known industry for NVDA", () => {
    const result = localizedIndustry("NVDA", "美股");
    expect(result).toEqual({ group: "电子", detail: "半导体" });
  });

  test("returns known industry for HK stock with known industry mapping", () => {
    const result = localizedIndustry("00700", "港股");
    expect(result).toEqual({ group: "传媒", detail: "游戏" });
  });

  test("uses industry label fallback for unknown ticker", () => {
    const result = localizedIndustry("ZZZZ", "美股", "半导体");
    expect(result.group).toBe("电子");
    expect(result.detail).toBe("半导体");
  });

  test("uses sector label when industry is missing", () => {
    const result = localizedIndustry("ZZZZ", "美股", undefined, "Healthcare");
    expect(result.group).toBe("医药生物");
  });

  test("uses fallback when both industry and sector are missing", () => {
    const result = localizedIndustry("ZZZZ", "美股", undefined, undefined, "Technology");
    expect(result.group).toBe("计算机");
  });

  test("returns raw label as group for unrecognized industry labels", () => {
    const result = localizedIndustry("ZZZZ", "美股", "SomethingUnknown");
    expect(result.group).toBe("SomethingUnknown");
    expect(result.detail).toBeUndefined();
  });

  test("handles null ticker and market with recognized Chinese detail", () => {
    const result = localizedIndustry(null, null, "半导体");
    expect(result.group).toBe("电子");
  });

  test("handles null industry with null ticker", () => {
    const result = localizedIndustry(null, null, null);
    expect(result).toEqual({ group: "未分类", detail: undefined });
  });

  test("resolves generic industry labels", () => {
    const result = localizedIndustry("ZZZZ", "美股", "可选消费");
    expect(result.group).toBe("商贸零售");
  });

  test("resolves generic industry labels from fallback", () => {
    const result = localizedIndustry("ZZZZ", "美股", undefined, undefined, "金融");
    expect(result.group).toBe("非银金融");
  });

  test("strips detail when it matches group", () => {
    const result = localizedIndustry("ZZZZ", "美股", "银行");
    expect(result).toEqual({ group: "银行", detail: undefined });
  });
});

describe("formatLocalizedIndustry", () => {
  test("formats group and detail", () => {
    expect(formatLocalizedIndustry({ group: "电子", detail: "半导体" })).toBe("电子 / 半导体");
  });

  test("formats group without detail", () => {
    expect(formatLocalizedIndustry({ group: "银行", detail: undefined })).toBe("银行");
  });
});
