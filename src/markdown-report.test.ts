import { describe, expect, test } from "vitest";
import { normalizeMarkdownForReading } from "./markdown-report";

describe("normalizeMarkdownForReading", () => {
  test("replaces Windows line endings", () => {
    expect(normalizeMarkdownForReading("line1\r\nline2")).toBe("line1\nline2");
  });

  test("replaces escaped newlines", () => {
    expect(normalizeMarkdownForReading("line1\\nline2")).toBe("line1\nline2");
  });

  test("replaces escaped tabs", () => {
    expect(normalizeMarkdownForReading("col1\\tcol2")).toBe("col1  col2");
  });

  test("adds spacing before numbered list items", () => {
    const result = normalizeMarkdownForReading("text 1. item");
    expect(result).toBe("text\n\n1. item");
  });

  test("adds heading markers before section titles followed by word characters", () => {
    const result = normalizeMarkdownForReading("text 总结review");
    expect(result).toBe("text\n\n## 总结review");
  });

  test("does not add heading markers when title is not preceded by whitespace", () => {
    const result = normalizeMarkdownForReading("pre估值与仓位规则");
    expect(result).toBe("pre估值与仓位规则");
  });

  test("adds newline before bold counter-evidence markers", () => {
    const result = normalizeMarkdownForReading("text **反证条件：**more");
    expect(result).toBe("text\n**反证条件：**more");
  });

  test("trims the result", () => {
    const result = normalizeMarkdownForReading("  hello world  ");
    expect(result).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(normalizeMarkdownForReading("")).toBe("");
  });

  test("handles escaped sequences together", () => {
    const result = normalizeMarkdownForReading("line1\\r\\nline2\\tcontinued");
    expect(result).toBe("line1\nline2  continued");
  });
});
