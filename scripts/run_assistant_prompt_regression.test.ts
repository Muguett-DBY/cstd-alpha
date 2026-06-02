import { describe, expect, test } from "vitest";
import { __test__ } from "./run_assistant_prompt_regression";

describe("assistant prompt regression evaluator", () => {
  test("flags single-stock action verdicts in comparison prompts", () => {
    expect(
      __test__.evaluateCompareAnswer("贵州茅台和五粮液长期回报谁更稳？请列表对比。", "结论：贵州茅台当前更适合持有。\n证据等级：中。\n风险：批价下行。\n下一步跟踪：批价。"),
    ).toContain("missing compared subject: 五粮液");
    expect(
      __test__.evaluateCompareAnswer("贵州茅台和五粮液长期回报谁更稳？请列表对比。", "结论：持有。\n贵州茅台和五粮液都有品牌优势。\n风险：需求下行。\n下一步跟踪：批价。"),
    ).toContain("single-stock action verdict in comparison");
  });

  test("accepts relative comparison answers covering both subjects", () => {
    expect(
      __test__.evaluateCompareAnswer(
        "贵州茅台和五粮液长期回报谁更稳？请列表对比。",
        "结论：贵州茅台相对更稳，五粮液弹性更高但库存和价格风险更大。\n| 对象 | 优势 | 风险 |\n|---|---|---|\n| 贵州茅台 | 品牌强 | 批价 |\n| 五粮液 | 弹性 | 库存 |\n下一步跟踪：批价。",
      ),
    ).toEqual([]);
  });

  test("does not flag populated markdown sections as empty heading leaks", () => {
    expect(__test__.hasEmptyMarkdownHeadingLeak("### 下一步跟踪\n\n1. 跟踪批价。\n2. 跟踪中报。")).toBe(false);
    expect(__test__.hasEmptyMarkdownHeadingLeak("### 下一步跟踪\n\n---\n\n### 反证条件")).toBe(true);
  });

  test("flags forecast answers with vague scenario ranges", () => {
    expect(
      __test__.evaluateForecastAnswer(
        "贵州茅台未来12个月净利润和股价大概怎么估？给保守、中性、乐观区间。",
        [
          "主判断：中性观察",
          "当前股价：约 1420 元。",
          "| 情景 | 归母净利润 | 12个月股价区间 |",
          "| --- | --- | --- |",
          "| 保守 | 820-840亿元 | 无精确区间，方向大概率低于当前价 |",
          "| 中性 | 850-870亿元 | 1350-1500元 |",
          "| 乐观 | 890-930亿元 | 1550-1750元 |",
          "| 证据 | 来源 |",
          "| 财报 | 公告 |",
          "反证条件：批价继续回落。",
          "下一步跟踪：跟踪批价。",
        ].join("\n"),
      ),
    ).toContain("保守/中性/乐观数字区间");
  });

  test("flags explicit count requirements without treating months as list counts", () => {
    expect(__test__.evaluateExplicitCountRequirement("给我推荐三支A股股票。", "1. 贵州茅台\n2. 宁德时代")).toContain("explicit count not satisfied: expected at least 3");
    expect(__test__.evaluateExplicitCountRequirement("贵州茅台未来12个月净利润和股价大概怎么估？", "主判断：中性观察")).toEqual([]);
  });

  test("requires concrete evidence instead of generic evidence words", () => {
    expect(__test__.hasConcreteEvidence("结论：看好。反证和跟踪如下。")).toBe(false);
    expect(__test__.hasConcreteEvidence("E1：2026Q1营收同比增长 6.5%。")).toBe(true);
    expect(__test__.hasConcreteEvidence("| 证据 | 内容 |\n|---|---|\n| 财报 | 净利润 100 亿元 |")).toBe(true);
  });
});
