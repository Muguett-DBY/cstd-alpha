import { describe, expect, test } from "vitest";
import { guardAssistantOutputLanguage } from "./assistant-output-guards";

describe("assistant output guards", () => {
  test("removes raw markdown heading markers and generic table labels from chat text", () => {
    const guarded = guardAssistantOutputLanguage(
      [
        "### 证据等级",
        "中（外部搜索线索为主）。",
        "",
        "结构化表格 2",
        "| 项目 | 判断 |",
        "| --- | --- |",
        "| 利润修复 | 需要验证 |",
      ].join("\n"),
      "港股互联网现在投资吸引力来自利润修复、回购还是估值修复？",
    );

    expect(guarded).toContain("证据等级");
    expect(guarded).not.toContain("###");
    expect(guarded).not.toContain("结构化表格");
  });
});
