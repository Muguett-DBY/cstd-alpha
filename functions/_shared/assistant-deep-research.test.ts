import { describe, expect, test } from "vitest";
import {
  ASSISTANT_DEEP_RESEARCH_STALE_MS,
  buildAssistantDeepResearchToolCalls,
  classifyAssistantDeepResearch,
  expandDeepResearchIndustrySubject,
  extractDeepResearchCompanyQueries,
  hasRequiredDeepResearchAnswerSections,
  isAssistantDeepResearchJobStale,
  shouldStartAssistantDeepResearch,
} from "./assistant-deep-research";

describe("assistant deep research contract", () => {
  test("routes high-value investment prompts to background research but keeps concept chat realtime", () => {
    expect(classifyAssistantDeepResearch("茅台当前股价是多少，预测明年股价", "chat")).toBe("forecast");
    expect(classifyAssistantDeepResearch("给我三家半导体/AI算力最值得买的公司", "chat")).toBe("selection");
    expect(classifyAssistantDeepResearch("贵州茅台和五粮液谁更值得长期持有？", "chat")).toBe("comparison");
    expect(classifyAssistantDeepResearch("五粮液今年收入和利润增速能否超过贵州茅台？请给情景判断。", "target")).toBe("comparison");
    expect(classifyAssistantDeepResearch("港股互联网吸引力来自利润修复、回购，还是估值修复？请排序。", "industry")).toBe("comparison");
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

  test("splits comparison questions into per-company hard-data tool calls", () => {
    const companies = extractDeepResearchCompanyQueries("五粮液今年收入和利润增速能否超过贵州茅台？请给情景判断。");
    expect(companies.map((company) => company.companyQuery)).toEqual(["五粮液 000858", "贵州茅台 600519"]);

    const calls = buildAssistantDeepResearchToolCalls("comparison", "五粮液今年收入和利润增速能否超过贵州茅台？请给情景判断。");
    const evidenceQueries = calls.filter((call) => call.name === "read_company_evidence").map((call) => call.query);
    expect(evidenceQueries).toEqual(["五粮液 000858", "贵州茅台 600519"]);
    expect(calls.find((call) => call.name === "read_tencent_quote")?.query).toBe("000858,600519");
    expect(calls.find((call) => call.name === "read_financial_statements")?.query).toBe("000858,600519");
    expect(calls.find((call) => call.name === "read_filings_news")?.query).toBe("000858,600519");
  });

  test("expands AI compute industry research to cover critical profit pools", () => {
    const expanded = expandDeepResearchIndustrySubject("AI算力产业链最确定的利润环节");
    expect(expanded).toContain("GPU/AI芯片");
    expect(expanded).toContain("HBM/存储");
    expect(expanded).toContain("光模块/光器件");
    expect(expanded).toContain("先进制程/封装");
    expect(expanded).toContain("AI服务器");
    expect(expanded).toContain("PCB/交换芯片");

    const calls = buildAssistantDeepResearchToolCalls("industry", "AI算力产业链现在最确定的利润环节在哪里？");
    const researchQueries = calls.filter((call) => call.name === "read_radar_result" || call.name.startsWith("search_")).map((call) => call.query).join("\n");
    expect(researchQueries).toContain("光模块/光器件");
    expect(researchQueries).toContain("HBM/存储");
    expect(researchQueries).toContain("电源散热");
  });

  test("expands consumer outbound research without drifting into industrial exports", () => {
    const expanded = expandDeepResearchIndustrySubject("中国消费出海公司现在是长期机会还是阶段性高估？");
    expect(expanded).toContain("消费品牌出海");
    expect(expanded).toContain("潮玩/IP");
    expect(expanded).toContain("新茶饮");
    expect(expanded).toContain("家电");
    expect(expanded).toContain("跨境平台");
    expect(expanded).toContain("泡泡玛特");
    expect(expanded).toContain("安克创新");
    expect(expanded).not.toContain("光模块");

    const calls = buildAssistantDeepResearchToolCalls("industry", "中国消费出海公司现在是长期机会还是阶段性高估？");
    const researchQueries = calls.filter((call) => call.name === "read_radar_result" || call.name.startsWith("search_")).map((call) => call.query).join("\n");
    expect(researchQueries).toContain("名创优品");
    expect(researchQueries).toContain("海外收入");
    expect(researchQueries).not.toContain("AI服务器");
  });

  test("requires verdict, scenarios, evidence table, counter evidence and tracking", () => {
    const complete = [
      "主判断：中性观察",
      "保守情景：利润区间 800-830 亿元，股价区间 1100-1250 元。",
      "中性情景：利润区间 850-880 亿元，股价区间 1300-1500 元。",
      "乐观情景：利润区间 900-1000 亿元，股价区间 1600-2000 元。",
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

  test("comparison answers use relative conclusions rather than mandatory four-grade verdicts", () => {
    const comparison = [
      "主判断：贵州茅台相对更稳，五粮液弹性更高但渠道和库存验证压力更大；排序为贵州茅台 > 五粮液。",
      "| 公司 | 核心证据 | 风险 |",
      "| --- | --- | --- |",
      "| 贵州茅台 | 品牌和现金流更强 | 批价下行 |",
      "| 五粮液 | 弹性更高 | 渠道库存压力 |",
      "反证条件：若五粮液现金流和批价显著改善，对比结论需要重算。",
      "下一步跟踪：跟踪批价、合同负债、经营现金流和渠道库存。",
    ].join("\n");

    expect(hasRequiredDeepResearchAnswerSections(comparison, "comparison", "把贵州茅台和五粮液做一个简单对比表，最后给主判断")).toBe(true);
    expect(hasRequiredDeepResearchAnswerSections("主判断：看好\n| 公司 | 证据 | 判断 |\n| --- | --- | --- |\n| 贵州茅台 | 品牌 | 稳健 |\n| 五粮液 | 渠道 | 弹性 |\n反证条件：批价继续走弱。\n下一步跟踪：跟踪批价。", "comparison", "把贵州茅台和五粮液做一个简单对比表，最后给主判断")).toBe(false);
  });

  test("selection answers must include direct A-share and US-stock recommendation lists", () => {
    const buriedScenarioOnly = [
      "推荐口径：AI产业链只按证据强度和赔率排序，不等同于无脑买入。",
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
      "推荐口径：AI产业链整体可参与，但只推荐同时具备业务弹性和证据支撑的标的。",
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

  test("selection list answers do not need four-grade verdict wording", () => {
    const answer = [
      "筛选口径：只列AI算力链条中证据较强、全球业务或国产替代逻辑明确的公司。",
      "A股推荐：",
      "| 排名 | 公司 | 代码 | 核心理由 |",
      "| --- | --- | --- | --- |",
      "| 1 | 中际旭创 | 300308 | 光模块 |",
      "美股推荐：",
      "| 排名 | 公司 | 代码 | 核心理由 |",
      "| --- | --- | --- | --- |",
      "| 1 | NVIDIA | NVDA | GPU |",
      "保守情景：只买龙头。",
      "中性情景：按排序分散。",
      "乐观情景：提高弹性股权重。",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| AI资本开支 | 搜索线索 |",
      "反证条件：资本开支下修。",
      "下一步跟踪：跟踪财报和订单。",
    ].join("\n");

    expect(answer).not.toMatch(/主判断[：:]\s*(看好|中性观察|谨慎回避|反对)/);
    expect(hasRequiredDeepResearchAnswerSections(answer, "selection", "推荐A股和美股AI股票")).toBe(true);
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
