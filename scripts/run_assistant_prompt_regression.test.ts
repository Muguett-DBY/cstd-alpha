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
});
