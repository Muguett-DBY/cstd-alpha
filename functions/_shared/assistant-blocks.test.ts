import { describe, expect, test } from "vitest";
import { extractAssistantBlocks, stripRenderedMarkdownTables } from "./assistant-blocks";

describe("assistant structured blocks", () => {
  test("extracts table and chart blocks from markdown tables when chart is requested", () => {
    const text = [
      "结论：先观察。",
      "",
      "| 指标 | 2025 | 2026 |",
      "| --- | ---: | ---: |",
      "| 营收同比 | 12% | 18% |",
      "| 净利润同比 | -5% | 9% |",
    ].join("\n");

    const blocks = extractAssistantBlocks(text, "请画图对比营收和净利润");

    expect(blocks).toEqual([
      expect.objectContaining({ type: "table", columns: ["指标", "2025", "2026"], rows: expect.any(Array) }),
      expect.objectContaining({ type: "chart", chartType: "bar", labels: ["营收同比", "净利润同比"] }),
    ]);
  });

  test("does not create charts when user did not request visualization", () => {
    const text = "| 项目 | 分数 |\n| --- | --- |\n| 证据 | 70 |";
    expect(extractAssistantBlocks(text, "简单总结一下").map((block) => block.type)).toEqual(["table"]);
  });

  test("infers specific table titles instead of generic structured labels", () => {
    const text = [
      "| 反驳点 | 关键证据 | 含义 |",
      "| --- | --- | --- |",
      "| 股息可能下降 | 外部线索 | 高股息不等于稳赚 |",
      "",
      "| 跟踪项 | 频率 | 来源 |",
      "| --- | --- | --- |",
      "| 净息差 | 季度 | 银行季报 |",
    ].join("\n");

    expect(extractAssistantBlocks(text, "如果我认为银行股稳赚高股息，你反驳我。")).toEqual([
      expect.objectContaining({ type: "table", title: "反驳要点表" }),
      expect.objectContaining({ type: "table", title: "跟踪指标表 2" }),
    ]);
  });

  test("strips rendered markdown tables from chat text", () => {
    const text = "前文\n| 项目 | 分数 |\n| --- | --- |\n| 证据 | 70 |\n后文";
    expect(stripRenderedMarkdownTables(text)).toBe("前文\n后文");
  });
});
