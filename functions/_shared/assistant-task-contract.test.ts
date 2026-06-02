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

  test("accepts relative judgment for a comparison-shaped forecast question", () => {
    const contract = buildAssistantTaskContract("forecast", "五粮液今年收入和利润增速能否超过贵州茅台？请给情景判断。");
    const result = validateAssistantTaskAnswer([
      "## 相对主判断",
      "五粮液今年收入和利润增速大概率超过贵州茅台，但茅台现金流质量更稳。",
      "| 情景 | 五粮液营收增速 | 贵州茅台营收增速 |",
      "| --- | --- | --- |",
      "| 保守 | 10%-15% | 5%-7% |",
      "| 中性 | 20%-25% | 7%-9% |",
      "| 乐观 | 30%-35% | 9%-11% |",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "反证条件：若五粮液中报增速显著回落，对比结论需要重算。",
      "下一步跟踪：跟踪半年报、批价和经营现金流。",
    ].join("\n"), contract);

    expect(contract.needsRelativeJudgment).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.missing).not.toContain("四档主判断");
  });

  test("accepts forecast scenario ranges written below section headings", () => {
    const contract = buildAssistantTaskContract("forecast", "五粮液今年收入和利润增速能否超过贵州茅台？请给情景判断。");
    const result = validateAssistantTaskAnswer([
      "## 相对主判断",
      "五粮液今年增速大概率超过贵州茅台，但增速质量更弱。",
      "### 中性情景",
      "- 五粮液净利增速 60%-90%，茅台约 3%-5%。",
      "### 保守情景",
      "- 五粮液净利增速 30%-50%，茅台约 5%-8%。",
      "### 乐观情景",
      "- 五粮液净利增速 90%-120%，茅台约 4%。",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "反证条件：若五粮液中报增速显著回落，对比结论需要重算。",
      "下一步跟踪：跟踪半年报、批价和经营现金流。",
    ].join("\n"), contract);

    expect(result.valid).toBe(true);
  });

  test("rejects quantified forecasts that only quantify assumptions but leave outcomes vague", () => {
    const contract = buildAssistantTaskContract("forecast", "小米集团今年汽车业务会拖累还是提升整体利润？请量化关键假设。");
    const result = validateAssistantTaskAnswer([
      "主判断：中性观察",
      "### 保守情景",
      "- 核心假设：全年交付量 35-40 万辆，毛利率 16%-18%。",
      "- 结果：汽车业务全年经营亏损可能显著扩大，拖累集团利润。",
      "### 中性情景",
      "- 核心假设：全年交付量 50-55 万辆，毛利率 19%-21%。",
      "- 结果：汽车业务全年经营亏损大幅收窄。",
      "### 乐观情景",
      "- 核心假设：全年交付量 60-65 万辆，毛利率 22%-24%。",
      "- 结果：汽车业务接近盈亏平衡。",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "反证条件：若交付不及预期，结论需要下修。",
      "下一步跟踪：跟踪交付量、毛利率和经营亏损。",
    ].join("\n"), contract);

    expect(contract.needsQuantifiedOutcomes).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("量化情景结果区间");
  });

  test("accepts quantified forecasts when each scenario gives assumptions and outcome ranges", () => {
    const contract = buildAssistantTaskContract("forecast", "小米集团今年汽车业务会拖累还是提升整体利润？请量化关键假设。");
    const result = validateAssistantTaskAnswer([
      "主判断：中性观察",
      "### 保守情景",
      "- 核心假设：全年交付量 35-40 万辆，毛利率 16%-18%。",
      "- 结果：汽车业务全年经营亏损预计为 90-120 亿元，拖累集团利润。",
      "### 中性情景",
      "- 核心假设：全年交付量 50-55 万辆，毛利率 19%-21%。",
      "- 结果：汽车业务全年经营亏损预计为 35-60 亿元。",
      "### 乐观情景",
      "- 核心假设：全年交付量 60-65 万辆，毛利率 22%-24%。",
      "- 结果：汽车业务全年经营利润预计为 -10 至 10 亿元。",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "反证条件：若交付不及预期，结论需要下修。",
      "下一步跟踪：跟踪交付量、毛利率和经营亏损。",
    ].join("\n"), contract);

    expect(result.valid).toBe(true);
  });

  test("accepts quantified forecast outcome ranges in a scenario table", () => {
    const contract = buildAssistantTaskContract("forecast", "小米集团今年汽车业务会拖累还是提升整体利润？请量化关键假设。");
    const result = validateAssistantTaskAnswer([
      "主判断：谨慎回避",
      "| 情景 | 关键输入假设 | 汽车分部全年经营利润/亏损区间 | 对集团利润的影响 |",
      "| --- | --- | --- | --- |",
      "| **保守** | 交付 50 万辆，毛利率 19.5% | **亏损约 55‑80 亿元** | 拖累集团利润约 15‑20 个百分点 |",
      "| **中性** | 交付 55 万辆，毛利率 21.0% | **亏损约 5‑25 亿元** | 拖累集团利润约 1‑6 个百分点 |",
      "| **乐观** | 交付 65 万辆，毛利率 23.5% | **盈利约 15‑40 亿元** | 提升集团利润约 4‑10 个百分点 |",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "反证条件：若交付不及预期，结论需要下修。",
      "下一步跟踪：跟踪交付量、毛利率和经营亏损。",
    ].join("\n"), contract);

    expect(result.valid).toBe(true);
  });

  test("rejects quantified forecast tables that use vague input directions instead of assumption ranges", () => {
    const contract = buildAssistantTaskContract("forecast", "小米集团今年汽车业务会拖累还是提升整体利润？请量化关键假设。");
    const result = validateAssistantTaskAnswer([
      "主判断：谨慎回避",
      "| 情景 | 关键输入假设 | 汽车分部全年经营利润 | 集团全年经调整净利润 |",
      "| --- | --- | --- | --- |",
      "| **保守** | 交付量远低于55万辆目标；ASP低于23.51万元；毛利率低于20.1% | **亏损120–150亿元** | **200–250亿元** |",
      "| **中性** | 交付量达到55万辆目标；ASP接近23.51万元；毛利率略高于20.1% | **亏损50–70亿元** | **300–350亿元** |",
      "| **乐观** | 交付量显著超过55万辆目标；ASP明显提升；毛利率显著改善 | **亏损10–30亿元** | **380–420亿元** |",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "反证条件：若交付不及预期，结论需要下修。",
      "下一步跟踪：跟踪交付量、毛利率和经营亏损。",
    ].join("\n"), contract);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("量化情景输入假设区间");
  });

  test("accepts quantified forecast tables with full-width tildes and signed profit ranges", () => {
    const contract = buildAssistantTaskContract("forecast", "小米集团今年汽车业务会拖累还是提升整体利润？请量化关键假设。");
    const result = validateAssistantTaskAnswer([
      "主判断：谨慎回避",
      "| 情景 | 核心输入假设 | 分部经营利润估算区间 |",
      "| --- | --- | --- |",
      "| **乐观情景** | 交付量 55～60 万辆；毛利率 23%～26%；分部费用 280～320 亿元（基于季度经营亏损年化调整） | 经营利润 +70～+110 亿元 |",
      "| **中性情景** | 交付量 52～55 万辆；毛利率 22%～24%；分部费用 300～330 亿元（基于季度经营亏损年化调整） | 经营亏损 -30～+5 亿元 |",
      "| **保守情景** | 交付量 45～50 万辆；毛利率 20%～21.5%；分部费用 330～360 亿元（基于季度经营亏损年化调整） | 经营亏损 -120～-80 亿元 |",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "反证条件：若交付不及预期，结论需要下修。",
      "下一步跟踪：跟踪交付量、毛利率和经营亏损。",
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
