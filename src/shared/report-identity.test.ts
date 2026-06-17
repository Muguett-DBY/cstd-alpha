import { describe, expect, test } from "vitest";
import { normalizeIdentity, reportIdentityKey, stockCodeIdentity } from "./report-identity";

describe("reportIdentityKey", () => {
  test("uses ticker when available", () => {
    const result = reportIdentityKey({ company: { ticker: "AAPL", market: "US", name: "Apple" } });
    expect(result).toBe("US:AAPL");
  });

  test("falls back to name when ticker is missing", () => {
    const result = reportIdentityKey({ company: { name: "Apple", market: "US" } });
    expect(result).toBe("US:APPLE");
  });

  test("handles missing market", () => {
    const result = reportIdentityKey({ company: { ticker: "AAPL" } });
    expect(result).toBe(":AAPL");
  });

  test("handles completely empty company", () => {
    const result = reportIdentityKey({ company: {} });
    expect(result).toBe(":");
  });

  test("normalizes values to uppercase", () => {
    const result = reportIdentityKey({ company: { ticker: "aapl", market: "us", name: "apple" } });
    expect(result).toBe("US:AAPL");
  });

  test("trims whitespace", () => {
    const result = reportIdentityKey({ company: { ticker: "  AAPL  ", market: "  US  " } });
    expect(result).toBe("US:AAPL");
  });
});

describe("normalizeIdentity", () => {
  test("returns empty string for null", () => {
    expect(normalizeIdentity(null)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(normalizeIdentity(undefined)).toBe("");
  });

  test("converts numbers to uppercase string", () => {
    expect(normalizeIdentity(700)).toBe("700");
  });

  test("trims and uppercases strings", () => {
    expect(normalizeIdentity("  hello world  ")).toBe("HELLO WORLD");
  });
});

describe("stockCodeIdentity", () => {
  test("extracts 6-digit code", () => {
    expect(stockCodeIdentity("600941")).toBe("CN:600941");
  });

  test("returns empty when code is not word-bounded", () => {
    expect(stockCodeIdentity("SH600941")).toBe("");
  });

  test("returns empty for non-6-digit codes", () => {
    expect(stockCodeIdentity("AAPL")).toBe("");
  });

  test("returns empty for null", () => {
    expect(stockCodeIdentity(null)).toBe("");
  });

  test("returns empty for undefined", () => {
    expect(stockCodeIdentity(undefined)).toBe("");
  });

  test("handles number input", () => {
    expect(stockCodeIdentity(600941)).toBe("CN:600941");
  });
});
