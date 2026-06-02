import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildDeepResearchCandidateEnrichmentToolCalls,
  buildDeepResearchExecutionToolCalls,
  ensureDeepResearchAnswerCompleteness,
  findAssistantEvidenceDisciplineIssues,
  sanitizeAssistantAStockTickerPairs,
  sanitizeAssistantEvidenceConfidenceLabels,
  sanitizeAssistantPresentationText,
  sanitizeAssistantQuestionEcho,
  sanitizeAssistantSafetyDisclaimers,
  sanitizeAssistantTechnicalMarketingClaims,
  sanitizeAssistantAnomalousFinancialConclusions,
  sanitizeAssistantUnsupportedIndustrySubsectorVerdicts,
  sanitizeAssistantUnsupportedLeverageLabels,
  shouldContinueAssistantRepair,
  stripAssistantRepairPreamble,
} from "./index";
import type { AssistantDeepResearchWorkerJob } from "../../functions/_shared/assistant-deep-research";

describe("assistant deep research worker", () => {
  test("configures a single-message Queue consumer with an extended CPU budget", () => {
    const config = JSON.parse(readFileSync(resolve("workers/assistant-deep-research/wrangler.jsonc"), "utf8")) as {
      limits: { cpu_ms: number };
      queues: { consumers: Array<{ queue: string; max_batch_size: number }> };
    };

    expect(config.limits.cpu_ms).toBeGreaterThanOrEqual(300_000);
    expect(config.queues.consumers).toEqual([
      expect.objectContaining({
        queue: "cstd-alpha-assistant-deep-research",
        max_batch_size: 1,
      }),
    ]);
  });

  test("adds an auditable staged summary when a stopped job returns an incomplete answer", () => {
    const text = ensureDeepResearchAnswerCompleteness("主判断：中性观察", mockJob(), true, 3);

    expect(text).toContain("这是用户停止后的阶段性总结");
    expect(text).toContain("已整理证据摘要 | 3 条");
    expect(text).toContain("反证条件");
    expect(text).toContain("下一步跟踪");
  });

  test("does not append generic boilerplate to a normal incomplete recommendation answer", () => {
    const text = ensureDeepResearchAnswerCompleteness("推荐口径：优先选择AI产业链龙头。", {
      ...mockJob(),
      query: "从AI相关产业中推荐10支A股股票，10支美股股票",
      researchKind: "selection",
      status: "running",
      stopRequested: false,
    }, false, 8);

    expect(text).toBe("推荐口径：优先选择AI产业链龙头。");
    expect(text).not.toContain("若关键硬数据恶化，按保守情景处理");
  });

  test("normalizes a known company before collecting forecast evidence", () => {
    const calls = buildDeepResearchExecutionToolCalls(mockJob(), {
      siteEvidenceSummary: "",
      modeEvidenceSummary: "",
    });

    expect(calls.find((call) => call.name === "read_tencent_quote")?.query).toBe("600519");
    expect(calls.find((call) => call.name === "read_financial_statements")?.query).toBe("600519");
    expect(calls.find((call) => call.name === "read_filings_news")?.query).toBe("600519");
    expect(calls.find((call) => call.name === "read_tencent_quote")?.query).not.toContain("预测");
  });

  test("collects hard data for both companies in relative comparison questions", () => {
    const calls = buildDeepResearchExecutionToolCalls({
      ...mockJob(),
      query: "五粮液今年收入和利润增速能否超过贵州茅台？请给情景判断。",
      researchKind: "comparison",
    }, {
      siteEvidenceSummary: "",
      modeEvidenceSummary: "",
    });

    expect(calls.find((call) => call.name === "compare_stocks")?.query).toBe("000858,600519");
    expect(calls.find((call) => call.name === "read_tencent_quote")?.query).toBe("000858,600519");
    expect(calls.find((call) => call.name === "read_financial_statements")?.query).toBe("000858,600519");
    expect(calls.find((call) => call.name === "read_reports_concepts")?.query).toBe("000858,600519");
  });

  test("enriches discovered A-share selection candidates with quotes and financial statements", () => {
    const calls = buildDeepResearchCandidateEnrichmentToolCalls({
      ...mockJob(),
      query: "给我三家半导体/AI算力目前最值得买的公司",
      researchKind: "selection",
    }, [{
      source: "Tavily",
      query: "AI算力",
      title: "候选公司",
      summary: "中际旭创 300308、工业富联 601138、海光信息 688041 值得进一步核验。",
      url: "https://example.com/ai",
      content: "",
      sourceType: "news",
      signalType: "external_search",
      weight: 1,
      score: 1,
      freshness: "month",
    }]);

    expect(calls.map((call) => call.name)).toEqual(["read_tencent_quote", "read_financial_statements", "read_reports_concepts"]);
    expect(calls[0]?.query).toBe("300308,601138,688041");
  });

  test("splits candidate enrichment into batches accepted by the internal data tools", () => {
    const calls = buildDeepResearchCandidateEnrichmentToolCalls({
      ...mockJob(),
      query: "推荐八家A股AI公司",
      researchKind: "selection",
    }, [{
      source: "Tavily",
      query: "AI算力",
      title: "候选公司",
      summary: "候选代码 300308、601138、688041、688256、688008、002371、688012、603986。",
      url: "https://example.com/ai",
      content: "",
      sourceType: "news",
      signalType: "external_search",
      weight: 1,
      score: 1,
      freshness: "month",
    }]);

    expect(calls).toHaveLength(6);
    expect(calls.map((call) => call.query)).toEqual([
      "300308,601138,688041,688256,688008",
      "300308,601138,688041,688256,688008",
      "300308,601138,688041,688256,688008",
      "002371,688012,603986",
      "002371,688012,603986",
      "002371,688012,603986",
    ]);
  });

  test("corrects mismatched A-share tickers using verified quote evidence", () => {
    const text = sanitizeAssistantAStockTickerPairs(
      "1. 中际旭创 (002463.SZ)\n2. 工业富联 (601138.SH)",
      [{
        source: "CSTD Alpha",
        query: "300308,601138",
        title: "实时行情快照",
        summary: "中际旭创(300308) 价格123元；工业富联(601138) 价格45元",
        url: "",
        sourceType: "official",
        signalType: "external_search",
        weight: 3,
        score: 3,
        freshness: "today",
      }],
    );

    expect(text).toContain("中际旭创 (300308)");
    expect(text).toContain("工业富联 (601138)");
    expect(text).not.toContain("002463");
  });

  test("removes chatty admin acknowledgements before the answer", () => {
    expect(sanitizeAssistantQuestionEcho(
      "好的，admin。以下是针对您提出的问题。\n\n主判断：中性观察。",
      "光伏行业是否已经出清？",
    )).toBe("主判断：中性观察。");
  });

  test("downgrades unsupported inverter bullish calls and demotes speculative photovoltaic narratives", () => {
    const text = sanitizeAssistantUnsupportedIndustrySubsectorVerdicts(
      [
        "逆变器环节：看好（格局优异）",
        "太空数据中心对光伏供电高度依赖，光伏设备将迎来全新的“轨道级”市场。",
      ].join("\n"),
      [{
        source: "Research summary",
        query: "光伏",
        title: "组件出口线索",
        summary: "组件出口同比改善，辅材企业被机构看好。",
        url: "",
        sourceType: "news",
        signalType: "external_search",
        weight: 1,
        score: 1,
        freshness: "month",
      }],
    );

    expect(text).toContain("逆变器环节：中性观察（本轮缺少逆变器公司级财报、订单、出货或价格硬证据）");
    expect(text).toContain("远期算力绿电线索（待核验）");
    expect(text).toContain("远期待核验市场");
    expect(text).not.toContain("太空数据中心");
    expect(text).not.toContain("轨道级");
  });

  test("downgrades robotics marketing claims and private competitor financial claims", () => {
    const text = sanitizeAssistantTechnicalMarketingClaims([
      "优必选自研Thinker大模型斩获九项全球第一，并开源。",
      "公司是全球唯一全年交付超千台全尺寸人形机器人的企业。",
      "宇树2025年盈利约6亿元，已经明显领先。",
    ].join("\n"));

    expect(text).toContain("公司公开材料称");
    expect(text).toContain("第三方复核");
    expect(text).toContain("是否全球唯一仍需统一口径复核");
    expect(text).toContain("媒体线索称宇树2025年盈利约6亿元");
    expect(text).toContain("非上市公司审计财报");
    expect(text).not.toContain("斩获九项全球第一，并开源");
    expect(text).not.toContain("全球唯一全年交付超千台");
    expect(text).not.toContain("已经明显领先");
  });

  test("flags uncited precise claims and ungrounded high-confidence labels for repair", () => {
    const issues = findAssistantEvidenceDisciplineIssues(
      [
        "工业富联全球AI服务器代工市占率42%，2026Q1净利增长102.6%。",
        "浪潮信息全球市场份额47%，2026Q1净利增长65%。",
        "高置信：多个搜索摘要一致。",
      ].join("\n"),
      [{
        source: "Tavily",
        query: "AI 算力",
        title: "搜索摘要",
        summary: "行业新闻线索，具体口径待核验。",
        url: "https://example.com/ai",
        sourceType: "news",
        signalType: "external_search",
        weight: 1,
        score: 1,
        freshness: "month",
      }],
    );

    expect(issues).toContain("精确数字必须引用本轮 E 编号，否则删除精确数字并改写为定性判断");
    expect(issues).toContain("高置信或中高置信标签必须绑定本轮结构化硬证据 E 编号");
  });

  test("flags uncited historical baseline metrics even inside forecast scenarios", () => {
    const issues = findAssistantEvidenceDisciplineIssues(
      "保守情景：集团利润将显著低于2025年（约315亿元），汽车仍为核心拖累变量。",
      [],
    );

    expect(issues).toContain("情景中的历史基数必须引用本轮 E 编号，否则删除该历史数字");
  });

  test("flags internally contradictory ASP direction explanations", () => {
    const issues = findAssistantEvidenceDisciplineIssues(
      "中性情景：ASP 23-24万元，YU7 GT高配拉低均价。",
      [],
    );

    expect(issues).toContain("高价或高配产品对 ASP 的方向解释自相矛盾，重新核对表述");
  });

  test("flags compact B-unit values that drop decimals from cited evidence", () => {
    const issues = findAssistantEvidenceDisciplineIssues(
      "英伟达 FY2027 Q1 营收 816B（E1），数据中心收入 752B（E1），Q2 指引 910B（E1）。",
      [{
        source: "NVIDIA Investor Relations",
        query: "NVIDIA Q1 FY2027 revenue outlook",
        title: "NVIDIA Announces Financial Results for First Quarter Fiscal 2027",
        summary: "Record quarterly revenue of $81.6 billion, up 20% from Q4 and up 85% from a year ago. Record Data Center revenue of $75.2 billion. Outlook revenue is expected to be $91.0 billion, plus or minus 2%.",
        url: "https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Announces-Financial-Results-for-First-Quarter-Fiscal-2027/",
        sourceType: "official",
        signalType: "external_search",
        weight: 5,
        score: 5,
        freshness: "today",
      }],
    );

    expect(issues).toContain("紧邻 E 编号的 B 单位金额疑似丢失小数点，必须按对应证据原文保留小数和单位");
  });

  test("flags fiscal-year end dates that run backward", () => {
    const issues = findAssistantEvidenceDisciplineIssues(
      "主判断：中性观察。英伟达下一财年（FY2028，至2026年1月）收入增速将回落。",
      [],
    );

    expect(issues).toContain("财年年份与自然年明显倒置，必须删除错误日期或改成可核验口径");
  });

  test("flags likely mistranslation of end-of-decade into end-of-century", () => {
    const issues = findAssistantEvidenceDisciplineIssues(
      "E18指出超大规模数据中心资本支出可能到2027年达1万亿美元，AI基础设施本世纪末3–4万亿。",
      [],
    );

    expect(issues).toContain("“本世纪末”这类超长期表述疑似误译，必须改为证据支持的年份或删除");
  });

  test("flags deterministic conclusions from single-source abnormal financial data", () => {
    const evidence = [{
      source: "CSTD Alpha",
      query: "000858,600519",
      title: "多标的同口径财务报表",
      summary: [
        "【重要核验约束】以下财务报表包含未被第二硬源交叉验证的异常同比或相邻期剧烈反转；只能作为待核验线索。",
        "【五粮液 000858 同口径财务证据】",
        "结构化核验状态：单源异常，缺少 Tushare/第二硬源交叉验证；异常同比只能作为待核验线索。",
        "利润表：2026一季报/营收=228.38亿/营收同比=33.67%(异常波动待核验)/归母净利=80.63亿/归母净利同比=82.57%(异常波动待核验)",
      ].join("\n"),
      url: "",
      sourceType: "official",
      signalType: "external_search",
      weight: 2,
      qualityScore: 0.58,
    }] as Parameters<typeof findAssistantEvidenceDisciplineIssues>[1];
    const issues = findAssistantEvidenceDisciplineIssues(
      "相对主判断：五粮液极大概率超过贵州茅台。高置信：五粮液2026Q1归母净利同比82.57%（E1），几乎全部情景都更强。",
      evidence,
    );

    expect(issues).toContain("单源异常财务数据只能作为待核验线索，不能支撑确定排序、极大概率判断或强烈经营结论");
    expect(issues).toContain("高置信或中高置信标签必须绑定本轮结构化硬证据 E 编号");
  });

  test("replaces Wuliangye versus Moutai abnormal conclusions with a safe relative answer", () => {
    const evidence = [{
      source: "CSTD Alpha",
      query: "000858,600519",
      title: "多标的同口径财务报表",
      summary: "结构化核验状态：单源异常，缺少 Tushare/第二硬源交叉验证；利润表：2026一季报/归母净利同比=82.57%(异常波动待核验)",
      url: "",
      sourceType: "official",
      signalType: "external_search",
      weight: 2,
      qualityScore: 0.58,
    }] as Parameters<typeof sanitizeAssistantAnomalousFinancialConclusions>[2];
    const sanitized = sanitizeAssistantAnomalousFinancialConclusions(
      "相对主判断：五粮液极大概率超过贵州茅台。高置信：五粮液2026Q1归母净利同比82.57%（E1），几乎全部情景都更强。",
      { query: "五粮液今年收入和利润增速能否超过贵州茅台？请给情景判断。", researchKind: "comparison" },
      evidence,
    );

    expect(sanitized).toContain("当前不能把“五粮液增速超过贵州茅台”判成确定结论");
    expect(sanitized).toContain("单源异常");
    expect(sanitized).toContain("保守");
    expect(sanitized).toContain("下一步跟踪");
    expect(findAssistantEvidenceDisciplineIssues(sanitized, evidence)).toEqual([]);
  });

  test("removes chatty acknowledgement and repeated user question from deep research answer", () => {
    expect(
      sanitizeAssistantQuestionEcho(
        "好的，收到你的问题。\n英伟达下一财年收入增速还能维持高增长吗？给保守、中性、乐观三档。\n主判断：中性观察。",
        "英伟达下一财年收入增速还能维持高增长吗？给保守、中性、乐观三档。",
      ),
    ).toBe("主判断：中性观察。");
  });

  test("allows one additional constrained repair pass but stops after the configured limit", () => {
    expect(shouldContinueAssistantRepair(0, ["量化情景结果区间"], false)).toBe(true);
    expect(shouldContinueAssistantRepair(1, ["量化情景结果区间"], false)).toBe(true);
    expect(shouldContinueAssistantRepair(2, ["量化情景结果区间"], false)).toBe(false);
    expect(shouldContinueAssistantRepair(0, ["量化情景结果区间"], true)).toBe(false);
  });

  test("downgrades high-confidence labels that are not tied to structured evidence", () => {
    const text = sanitizeAssistantEvidenceConfidenceLabels(
      "高置信：高盛研报和多个搜索摘要一致。\n中高置信：行业新闻汇总。\n中性情景（中置信，基于E12高置信财报+E13一致预期）",
      [{
        source: "Tavily",
        query: "AI 算力",
        title: "搜索摘要",
        summary: "行业新闻线索。",
        url: "https://example.com/ai",
        sourceType: "news",
        signalType: "external_search",
        weight: 1,
        score: 1,
        freshness: "month",
      }],
    );

    expect(text).not.toContain("高置信");
    expect(text).not.toContain("中高置信");
    expect(text).toContain("中等置信：高盛研报和多个搜索摘要一致。");
    expect(text).toContain("中性情景（中置信，基于E12中等置信财报+E13一致预期）");
  });

  test("strips internal repair preambles before saving final answers", () => {
    const text = stripAssistantRepairPreamble([
      "好的，收到指令。我将严格遵循“CSTD Alpha深研答案修复器”的规则，对原答案进行修复。",
      "核心修复点是：擦除所有未绑定证据的精确数字。",
      "",
      "相对主判断：贵州茅台相对更稳健，五粮液弹性更大但需要核验。",
      "对比表",
      "| 维度 | 贵州茅台 | 五粮液 |",
      "| --- | --- | --- |",
      "| 护城河 | 更强 | 次强 |",
    ].join("\n"));

    expect(text).toMatch(/^相对主判断/);
    expect(text).not.toContain("修复器");
    expect(text).not.toContain("核心修复点");
  });

  test("removes generic public-report safety disclaimers from final answers", () => {
    const text = sanitizeAssistantSafetyDisclaimers([
      "主判断：中性观察",
      "关键证据表",
      "| 证据 | 来源 |",
      "| --- | --- |",
      "| 财报 | 公告 |",
      "免责声明：以上仅为基于公开信息的投研框架，不构成投资建议。市场有风险，投资需谨慎。",
    ].join("\n"));

    expect(text).toContain("主判断：中性观察");
    expect(text).not.toContain("免责声明");
    expect(text).not.toContain("不构成投资建议");
    expect(text).not.toContain("投资需谨慎");
  });

  test("does not mislabel working-capital pressure as high leverage without debt evidence", () => {
    const text = sanitizeAssistantUnsupportedLeverageLabels(
      "五粮液因高杠杆、弱现金流将更脆弱。",
      [{
        source: "CSTD Alpha",
        query: "000858",
        title: "现金流与应收票据",
        summary: "经营现金流转负，应收款项融资上升。",
        url: "",
        sourceType: "official",
        signalType: "external_search",
        weight: 3,
        score: 3,
        freshness: "today",
      }],
    );

    expect(text).toContain("营运压力较高");
    expect(text).not.toContain("高杠杆");
  });

  test("normalizes private-use and unusual spacing characters before presentation", () => {
    expect(sanitizeAssistantPresentationText("2026\uF020Q1\u00A0利润  增长")).toBe("2026 Q1 利润 增长");
  });

  test("normalizes misplaced percent signs before presentation", () => {
    expect(sanitizeAssistantPresentationText("三个客户占数据中心收入%68，风险较高。")).toContain("68%");
  });

  test("cleans awkward mixed-language and speculative presentation terms", () => {
    const text = sanitizeAssistantPresentationText("需求端超预期风险/threat；HJT/太空算力推动设备订单；太空光伏进入扩产。");

    expect(text).toBe("需求端超预期风险；HJT/算力绿电需求推动设备订单；新技术路线进入扩产。");
  });
});

function mockJob(): AssistantDeepResearchWorkerJob {
  return {
    id: "job-1",
    userKey: "admin",
    threadId: "thread-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    query: "茅台明年净利润预测",
    mode: "target",
    researchKind: "forecast",
    status: "stopping",
    progressTitle: "正在整理阶段性总结...",
    progressStage: "synthesize",
    progressCurrent: 3,
    progressTotal: 4,
    stopRequested: true,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}
