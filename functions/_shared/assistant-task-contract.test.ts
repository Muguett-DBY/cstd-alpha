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

  test("rejects forecast answers that replace a scenario price range with vague direction text", () => {
    const contract = buildAssistantTaskContract("forecast", "贵州茅台未来12个月净利润和股价大概怎么估？给保守、中性、乐观区间。");
    const result = validateAssistantTaskAnswer([
      "主判断：中性观察",
      "当前股价：约 1420 元。",
      "| 情景 | 归母净利润 | 12个月股价区间 |",
      "| --- | --- | --- |",
      "| 保守 | 820-840亿元 | 无精确区间，方向大概率低于当前价 |",
      "| 中性 | 850-870亿元 | 1350-1500元 |",
      "| 乐观 | 890-930亿元 | 1550-1750元 |",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "反证条件：批价继续回落。",
      "下一步跟踪：跟踪批价。",
    ].join("\n"), contract);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("保守/中性/乐观数字区间");
  });

  test("accepts forecast answers with numeric ranges for every scenario", () => {
    const contract = buildAssistantTaskContract("forecast", "贵州茅台未来12个月净利润和股价大概怎么估？给保守、中性、乐观区间。");
    const result = validateAssistantTaskAnswer([
      "主判断：中性观察",
      "当前股价：约 1420 元。",
      "| 情景 | 归母净利润 | 12个月股价区间 |",
      "| --- | --- | --- |",
      "| 保守 | 820-840亿元 | 1180-1320元 |",
      "| 中性 | 850-870亿元 | 1350-1500元 |",
      "| 乐观 | 890-930亿元 | 1550-1750元 |",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "反证条件：批价继续回落。",
      "下一步跟踪：跟踪批价。",
    ].join("\n"), contract);

    expect(result.valid).toBe(true);
  });

  test("requires every compared subject to appear in comparison output", () => {
    const contract = buildAssistantTaskContract("comparison", "把贵州茅台和五粮液做一个简单对比表，最后给主判断");
    const result = validateAssistantTaskAnswer([
      "主判断：贵州茅台相对更稳。",
      "| 公司 | 判断 |",
      "| --- | --- |",
      "| 贵州茅台 | 稳健 |",
      "两者相比，贵州茅台优势更明确。",
      "反证条件：渠道继续走弱。",
      "下一步跟踪：跟踪批价。",
    ].join("\n"), contract);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("覆盖对比对象：五粮液");
  });

  test("accepts comparison answers with relative judgment instead of four-grade verdict", () => {
    const contract = buildAssistantTaskContract("comparison", "把贵州茅台和五粮液做一个简单对比表，最后给主判断");
    const result = validateAssistantTaskAnswer([
      "主判断：贵州茅台相对更稳，五粮液弹性更高但验证压力更大；排序为贵州茅台 > 五粮液。",
      "| 公司 | 核心证据 | 风险 |",
      "| --- | --- | --- |",
      "| 贵州茅台 | 品牌和现金流更强 | 批价下行 |",
      "| 五粮液 | 弹性更高 | 渠道和库存验证不足 |",
      "反证条件：若五粮液现金流和批价显著改善，对比结论需要重算。",
      "下一步跟踪：跟踪批价、合同负债、经营现金流和渠道库存。",
    ].join("\n"), contract);

    expect(result.valid).toBe(true);
  });

  test("rejects comparison answers that only give a four-grade label without relative conclusion", () => {
    const contract = buildAssistantTaskContract("comparison", "把贵州茅台和五粮液做一个简单对比表，最后给主判断");
    const result = validateAssistantTaskAnswer([
      "主判断：看好",
      "| 公司 | 证据 | 判断 |",
      "| --- | --- | --- |",
      "| 贵州茅台 | 品牌 | 稳健 |",
      "| 五粮液 | 渠道 | 弹性 |",
      "反证条件：批价继续走弱。",
      "下一步跟踪：跟踪批价。",
    ].join("\n"), contract);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("对比相对结论");
  });
});
