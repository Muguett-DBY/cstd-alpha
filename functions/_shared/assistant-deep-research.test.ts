import { describe, expect, test } from "vitest";
import { buildAssistantDeepResearchToolCalls, classifyAssistantDeepResearch, hasRequiredDeepResearchAnswerSections, shouldStartAssistantDeepResearch } from "./assistant-deep-research";

describe("assistant deep research contract", () => {
  test("routes high-value investment prompts to background research but keeps concept chat realtime", () => {
    expect(classifyAssistantDeepResearch("茅台当前股价是多少，预测明年股价", "chat")).toBe("forecast");
    expect(classifyAssistantDeepResearch("给我三家半导体/AI算力最值得买的公司", "chat")).toBe("selection");
    expect(classifyAssistantDeepResearch("贵州茅台和五粮液谁更值得长期持有？", "chat")).toBe("comparison");
    expect(classifyAssistantDeepResearch("银行股是不是稳赚高股息？请反驳我", "chat")).toBe("contrarian");
    expect(shouldStartAssistantDeepResearch("用两句话解释自由现金流为什么重要。", "chat")).toBe(false);
  });

  test("builds typed minimum evidence packs", () => {
    expect(buildAssistantDeepResearchToolCalls("forecast", "茅台明年净利润预测").map((call) => call.name)).toEqual([
      "read_company_evidence",
      "read_tencent_quote",
      "read_financial_statements",
      "read_filings_news",
      "search_exa",
    ]);
    expect(buildAssistantDeepResearchToolCalls("selection", "三家半导体公司排序").map((call) => call.name)).toEqual([
      "read_radar_result",
      "read_market_data",
      "search_tavily",
      "search_brave",
      "search_exa",
    ]);
  });

  test("requires verdict, scenarios, evidence table, counter evidence and tracking", () => {
    const complete = [
      "主判断：中性观察",
      "保守情景：利润下降。",
      "中性情景：利润持平。",
      "乐观情景：利润增长。",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "反证条件：订单不及预期。",
      "下一步跟踪：跟踪现金流。",
    ].join("\n");
    expect(hasRequiredDeepResearchAnswerSections(complete, "forecast")).toBe(true);
    expect(hasRequiredDeepResearchAnswerSections(complete.replace("主判断：中性观察", "主判断：**中性观察**"), "forecast")).toBe(true);
    expect(hasRequiredDeepResearchAnswerSections("结论：看好", "forecast")).toBe(false);
  });
});
