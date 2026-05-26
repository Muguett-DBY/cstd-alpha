import { describe, expect, test } from "vitest";
import { parseAssistantMarkdown } from "./assistant-markdown";

describe("assistant markdown parser", () => {
  test("parses headings, horizontal rules, and markdown tables instead of leaving raw syntax", () => {
    const blocks = parseAssistantMarkdown(
      [
        "结论：先观察。",
        "",
        "### 证据等级 中",
        "",
        "---",
        "",
        "| 驱动 | 当前作用 |",
        "| --- | --- |",
        "| 利润修复 | 主导驱动 |",
        "| 回购 | 次要但重要 |",
      ].join("\n"),
    );

    expect(blocks).toEqual([
      { type: "paragraph", text: "结论：先观察。" },
      { type: "heading", level: 3, text: "证据等级 中" },
      { type: "hr" },
      {
        type: "table",
        headers: ["驱动", "当前作用"],
        rows: [
          ["利润修复", "主导驱动"],
          ["回购", "次要但重要"],
        ],
      },
    ]);
  });

  test("cleans malformed heading markers instead of rendering raw hashes", () => {
    const blocks = parseAssistantMarkdown(
      [
        "结论：可以继续观察。",
        "###",
        "###证据等级 中",
        "普通段落",
      ].join("\n"),
    );

    expect(blocks).toEqual([
      { type: "paragraph", text: "结论：可以继续观察。" },
      { type: "heading", level: 3, text: "证据等级 中" },
      { type: "paragraph", text: "普通段落" },
    ]);
  });
});
