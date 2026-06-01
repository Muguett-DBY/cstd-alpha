import { describe, expect, test } from "vitest";
import {
  ASSISTANT_DEEP_RESEARCH_STALE_MS,
  buildAssistantDeepResearchToolCalls,
  classifyAssistantDeepResearch,
  hasRequiredDeepResearchAnswerSections,
  isAssistantDeepResearchJobStale,
  shouldStartAssistantDeepResearch,
} from "./assistant-deep-research";

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

  test("selection answers must include direct A-share and US-stock recommendation lists", () => {
    const buriedScenarioOnly = [
      "主判断：看好",
      "保守情景：龙头集中。",
      "中性情景（基准推荐）：",
      "| 情景 | 推荐组合 |",
      "| --- | --- |",
      "| 中性 | A股：中际旭创、工业富联、海光信息、澜起科技、北方华创、寒武纪、天孚通信、中微公司、科大讯飞、韦尔股份；美股：NVIDIA、Broadcom、TSMC、Microsoft、Alphabet、Amazon、Super Micro、AMD、Micron、Meta |",
      "关键证据表：",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| AI景气 | 搜索线索 |",
      "反证条件：AI资本开支下修。",
      "下一步跟踪：跟踪财报。",
    ].join("\n");

    const directLists = [
      "主判断：看好",
      "A 股 Top10推荐：",
      "| 排名 | 公司 | 代码 | 核心理由 |",
      "| --- | --- | --- | --- |",
      "| 1 | 中际旭创 | 300308 | 全球光模块 |",
      "| 2 | 工业富联 | 601138 | AI服务器 |",
      "| 3 | 海光信息 | 688041 | 国产替代 |",
      "| 4 | 澜起科技 | 688008 | 内存接口 |",
      "| 5 | 北方华创 | 002371 | 半导体设备 |",
      "| 6 | 寒武纪 | 688256 | AI芯片 |",
      "| 7 | 天孚通信 | 300394 | 光器件 |",
      "| 8 | 中微公司 | 688012 | 刻蚀设备 |",
      "| 9 | 科大讯飞 | 002230 | AI应用 |",
      "| 10 | 韦尔股份 | 603501 | AI视觉 |",
      "美 股 Top10推荐：",
      "| 排名 | 公司 | 代码 | 核心理由 |",
      "| --- | --- | --- | --- |",
      "| 1 | NVIDIA | NVDA | GPU龙头 |",
      "| 2 | Broadcom | AVGO | ASIC网络 |",
      "| 3 | TSMC | TSM | 先进制程 |",
      "| 4 | Microsoft | MSFT | 云AI |",
      "| 5 | Alphabet | GOOGL | TPU云AI |",
      "| 6 | Amazon | AMZN | AWS AI |",
      "| 7 | Super Micro | SMCI | AI服务器 |",
      "| 8 | AMD | AMD | AI GPU |",
      "| 9 | Micron | MU | HBM存储 |",
      "| 10 | Meta | META | AI广告 |",
      "保守情景：集中龙头。",
      "中性情景：AI资本开支持续。",
      "乐观情景：国产替代加速。",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| AI景气 | 搜索线索 |",
      "反证条件：AI资本开支下修。",
      "下一步跟踪：跟踪财报。",
    ].join("\n");

    const query = "从ai相关产业中推荐10支A股股票，10支美股股票，A股着重看是否为全球业务与国产替代";
    expect(hasRequiredDeepResearchAnswerSections(buriedScenarioOnly, "selection", query)).toBe(false);
    expect(hasRequiredDeepResearchAnswerSections(directLists, "selection", query)).toBe(true);
  });

  test("detects stale active jobs without expiring terminal jobs", () => {
    const now = Date.parse("2026-06-01T10:20:00.000Z");
    const staleUpdatedAt = new Date(now - ASSISTANT_DEEP_RESEARCH_STALE_MS - 1_000).toISOString();
    const freshUpdatedAt = new Date(now - 5 * 60 * 1_000).toISOString();

    expect(isAssistantDeepResearchJobStale({
      status: "running",
      createdAt: staleUpdatedAt,
      startedAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    }, now)).toBe(true);
    expect(isAssistantDeepResearchJobStale({
      status: "running",
      createdAt: freshUpdatedAt,
      startedAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
    }, now)).toBe(false);
    expect(isAssistantDeepResearchJobStale({
      status: "completed",
      createdAt: staleUpdatedAt,
      startedAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    }, now)).toBe(false);
  });
});
