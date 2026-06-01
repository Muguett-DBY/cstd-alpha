import { describe, expect, test } from "vitest";
import { buildAssistantTaskContract, validateAssistantTaskAnswer } from "./assistant-task-contract";

describe("assistant task contracts", () => {
  test("captures explicit A-share and US-stock recommendation counts", () => {
    const contract = buildAssistantTaskContract("selection", "从AI相关产业中推荐10支A股股票，10支美股股票，A股着重看全球业务与国产替代");

    expect(contract).toMatchObject({
      kind: "selection",
      requestedMarkets: ["A股", "美股"],
      requestedCounts: { "A股": 10, "美股": 10 },
      needsDirectRecommendations: true,
    });
  });

  test("rejects recommendation answers that hide or omit requested lists", () => {
    const contract = buildAssistantTaskContract("selection", "从AI相关产业中推荐10支A股股票，10支美股股票");
    const result = validateAssistantTaskAnswer([
      "推荐口径：优先选择AI产业链龙头。",
      "反证条件：资本开支下修。",
      "下一步跟踪：跟踪财报。",
    ].join("\n"), contract);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("A股推荐名单至少 10 家");
    expect(result.missing).toContain("美股推荐名单至少 10 家");
  });

  test("rejects stock-price forecasts that do not answer the current price first", () => {
    const contract = buildAssistantTaskContract("forecast", "茅台当前股价是多少，预测明年股价");
    const result = validateAssistantTaskAnswer([
      "主判断：中性观察",
      "保守情景：利润低于预期。",
      "中性情景：利润平稳。",
      "乐观情景：利润加速。",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "反证条件：批价继续回落。",
      "下一步跟踪：跟踪批价。",
    ].join("\n"), contract);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("当前股价口径和数值");
  });

  test("requires every compared subject to appear in comparison output", () => {
    const contract = buildAssistantTaskContract("comparison", "把贵州茅台和五粮液做一个简单对比表，最后给主判断");
    const result = validateAssistantTaskAnswer([
      "主判断：中性观察",
      "| 公司 | 判断 |",
      "| --- | --- |",
      "| 贵州茅台 | 稳健 |",
      "反证条件：渠道继续走弱。",
      "下一步跟踪：跟踪批价。",
    ].join("\n"), contract);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("覆盖对比对象：五粮液");
  });
});
