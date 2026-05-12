import { describe, expect, test } from "vitest";
import {
  applyRiskCaps,
  calculateWeightedScore,
  MODULE_WEIGHTS,
  SCORE_ITEMS_20,
  stabilizeReportScores,
  validateReportPayload,
  type ModuleScore,
  type ScoreItem,
} from "./report";

const moduleScores: ModuleScore[] = MODULE_WEIGHTS.map((module, index) => ({
  id: module.id,
  name: module.name,
  weight: module.weight,
  score: 50 + index,
  weightedScore: 0,
  summary: "summary",
  evidence: ["evidence"],
  concerns: ["concern"],
}));

const scoreItems20: ScoreItem[] = SCORE_ITEMS_20.map((item, index) => ({
  ...item,
  score: 45 + index,
  label: "一般",
  evidence: ["公开证据"],
  deductions: ["扣分点"],
  recentChange: "无明显变化；对分数影响：0",
  reason: "逐项评分理由。",
}));

describe("report scoring", () => {
  test("module weights sum to 100", () => {
    expect(MODULE_WEIGHTS.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
    expect(SCORE_ITEMS_20.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
  });

  test("calculates weighted scores from module scores", () => {
    const result = calculateWeightedScore(moduleScores);

    expect(result.modules[0].weightedScore).toBe(5);
    expect(result.total).toBe(53.82);
  });

  test("risk caps override raw investment attractiveness", () => {
    expect(applyRiskCaps(88, [{ label: "重大财务造假", cap: 30, severity: "critical" }])).toBe(30);
    expect(applyRiskCaps(58, [{ label: "估值透支", cap: 65, severity: "warning" }])).toBe(58);
  });

  test("stabilizes same-company refresh scores against the previous report", () => {
    const previous = validateReportPayload({
      company: { name: "Stable Co.", ticker: "600000", market: "沪A" },
      scoreItems20: scoreItems20.map((item) => ({ ...item, score: 60, reason: "上一版评分理由。" })),
      evidence: [
        {
          title: "Quote",
          source: "Public quote",
          url: "https://example.com/quote",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
        {
          title: "Financials",
          source: "Public financials",
          url: "https://example.com/financials",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
    });
    const volatileRefresh = validateReportPayload({
      company: { name: "Stable Co.", ticker: "600000", market: "沪A" },
      scoreItems20: scoreItems20.map((item) => ({ ...item, score: 20, reason: "本次模型评分理由。" })),
      evidence: previous.evidence,
    });

    const stabilized = stabilizeReportScores(volatileRefresh, previous);

    expect(stabilized.scoreItems20[0]).toMatchObject({
      score: 48,
      label: "差",
      reason: "本次模型评分理由。",
    });
    expect(Math.abs(stabilized.cqs - previous.cqs)).toBeLessThanOrEqual(12);
    expect(Math.abs(stabilized.ias - previous.ias)).toBeLessThanOrEqual(12);
    expect(stabilized.moduleScores.every((module) => Math.abs(module.score - 48) <= 0.01)).toBe(true);
  });
});

describe("report validation", () => {
  test("accepts a complete report payload", () => {
    const report = validateReportPayload({
      company: { name: "Example Inc.", ticker: "EXM", market: "US" },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "观察",
      oneSentence: "A test company.",
      cqs: 71,
      ias: 64,
      moduleScores,
      scoreItems20,
      redFlags: [],
      evidence: [
        {
          title: "Quote",
          source: "Yahoo Finance",
          url: "https://query1.finance.yahoo.com",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
      sections: {
        companyOverview: "overview",
        industry: "industry",
        businessModel: "model",
        moat: "moat",
        governance: "governance",
        financialQuality: "financials",
        growth: "growth",
        valuation: "valuation",
        risks: "risks",
        finalConclusion: "final",
      },
      summaryDashboard: {
        valuationView: "合理",
        positionAdvice: "观察仓",
        investmentHorizon: "至少 5 年",
        keyReasons: ["理由 1", "理由 2", "理由 3"],
        keyRisks: ["风险 1"],
        trackingMetrics: ["经营现金流"],
      },
      qualitativeAnalysis: {
        companyHistory: "history",
        lifecycle: "mature",
        businessStructure: "structure",
        shareholderPosition: "position",
      },
      financialTenYear: {
        rows: [{ metric: "营业收入", values: { "2026": "100" }, trend: "上升", interpretation: "增长" }],
        interpretation: "十年财务解读",
      },
      valuationAnalysis: {
        currentPrice: "10",
        fairValueRange: "8-12",
        buyRange: "8 以下",
        sellReduceRange: "15 以上",
        methods: ["历史估值", "同业对比", "十年反推"],
        scenarios: [{ name: "中性", assumptions: "稳定", value: "10", expectedReturn: "8%", probability: "50%" }],
        conclusion: "估值结论",
      },
      riskMatrix: [{ type: "行业风险", risk: "需求下降", probability: "中", impact: "高", warningMetric: "销量", response: "观察" }],
      accountRules: {
        companyGrade: "B",
        maxPosition: "观察仓",
        addCondition: "基本面未恶化且估值更低",
        reduceCondition: "高估或基本面恶化",
        reviewTiming: "财报后",
      },
      fullSections: {
        onePageConclusion: "一页结论",
        companyOverview: "公司概况",
        industryTrack: "行业赛道",
        businessModel: "商业模式",
        moat: "护城河",
        governance: "治理",
        financialQuality: "财务质量",
        growthInflection: "成长转折",
        valuation: "估值",
        risks: "风险",
        finalConclusion: "最终结论",
        accountRules: "账户规则",
      },
      disclaimer: "Research only.",
    });

    expect(report.company.name).toBe("Example Inc.");
    expect(report.scoreItems20).toHaveLength(20);
    expect(report.fullSections.onePageConclusion).toBe("一页结论");
  });

  test("normalizes missing deep sections into explicit data-unavailable text", () => {
    const report = validateReportPayload({
      company: { name: "Example Inc." },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "观察",
      oneSentence: "A test company.",
      cqs: 71,
      ias: 64,
      moduleScores,
      redFlags: [],
      evidence: [],
      sections: { companyOverview: "overview" },
      disclaimer: "Research only.",
    });

    expect(report.scoreItems20).toHaveLength(20);
    expect(report.fullSections.finalConclusion).toContain("数据不足");
  });

  test("cleans internal score detail placeholders when loading cached reports", () => {
    const report = validateReportPayload({
      company: { name: "Placeholder Co." },
      scoreItems20: SCORE_ITEMS_20.map((item) => ({
        ...item,
        score: 55,
        evidence: ["公开证据"],
        deductions: ["需在后续复核中补充更细的扣分依据。"],
        recentChange: "未提供最近 12 个月变化判断；对分数影响：0",
        reason: "基于公开证据给出中性评分。",
      })),
      evidence: [
        {
          title: "Quote",
          source: "Public quote",
          url: "https://example.com/quote",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
        {
          title: "Financials",
          source: "Public financials",
          url: "https://example.com/financials",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
    });

    expect(report.scoreItems20[0].deductions).toEqual(["该项缺少足够强的正面证据，按保守口径扣分：基于公开证据给出中性评分。"]);
    expect(report.scoreItems20[0].recentChange).toBe("最近 12 个月变化需结合公开财务和行情证据复核；本项暂不额外调整分数。");
  });

  test("rewrites score detail data-insufficient placeholders into conservative deductions", () => {
    const report = validateReportPayload({
      company: { name: "Tencent" },
      scoreItems20: SCORE_ITEMS_20.map((item) => ({
        ...item,
        score: 70,
        label: "好",
        evidence: item.id === "industryCyclicality" ? ["互联网需求相对稳定但受宏观影响"] : ["公开证据"],
        deductions: item.id === "industryCyclicality" ? ["周期性数据不足"] : ["扣分点"],
        recentChange: item.id === "industryCyclicality" ? "无" : "最近 12 个月稳定。",
        reason: item.id === "industryCyclicality" ? "游戏社交需求稳定，云业务增长" : "基于公开证据评分。",
      })),
      evidence: [
        {
          title: "Quote",
          source: "Public quote",
          url: "https://example.com/quote",
          retrievedAt: "2026-05-12T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
        {
          title: "Financials",
          source: "Public financials",
          url: "https://example.com/financials",
          retrievedAt: "2026-05-12T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
    });

    const item = report.scoreItems20.find((scoreItem) => scoreItem.id === "industryCyclicality");

    expect(item?.deductions).toEqual(["该项缺少足够强的正面证据，按保守口径扣分：游戏社交需求稳定，云业务增长"]);
    expect(JSON.stringify(item)).not.toContain("数据不足");
  });

  test("caps low-evidence reports instead of allowing high investment scores", () => {
    const report = validateReportPayload({
      company: { name: "Weak Evidence Co." },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "买入",
      oneSentence: "A high score without evidence.",
      cqs: 95,
      ias: 95,
      scoreItems20: scoreItems20.map((item) => ({ ...item, score: 95, evidence: [] })),
      redFlags: [],
      evidence: [],
      sections: { companyOverview: "overview" },
      disclaimer: "Research only.",
    });

    expect(report.ias).toBeLessThanOrEqual(50);
    expect(report.conclusion).toBe("观察");
  });

  test("rescales 0-10 model score output when high-score signals show the model intended tenths", () => {
    const report = validateReportPayload({
      company: { name: "Apple" },
      conclusion: "观察",
      oneSentence: "优质公司但估值需观察。",
      cqs: 77,
      ias: 74,
      scoreItems20: SCORE_ITEMS_20.map((item, index) => ({
        ...item,
        score: index % 5 === 0 ? 10 : 7,
        label: "好",
        evidence: ["SEC 年报显示现金流充足"],
        deductions: ["估值安全边际待验证"],
        recentChange: "最近 12 个月基本面稳定。",
        reason: "公司质量较高，但估值需要确认。",
      })),
      redFlags: [],
      evidence: [
        {
          title: "SEC",
          source: "SEC EDGAR",
          url: "https://data.sec.gov",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
        {
          title: "Quote",
          source: "Public quote",
          url: "https://example.com",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
      accountRules: {
        companyGrade: "A（优质公司，CQS约77）",
      },
    });

    expect(report.scoreItems20[0]).toMatchObject({ score: 100, label: "极好" });
    expect(report.scoreItems20[1]).toMatchObject({ score: 70, label: "好" });
    expect(report.moduleScores[0].score).toBeGreaterThanOrEqual(80);
    expect(report.cqs).toBeGreaterThan(70);
    expect(report.ias).toBeGreaterThan(70);
    expect(report.qualitativeBand).toBe("优质");
    expect(report.accountRules.companyGrade).toContain("A");
  });

  test("keeps true 0-10 bad-company scores low and derives labels from final score", () => {
    const report = validateReportPayload({
      company: { name: "Bad Co." },
      conclusion: "回避",
      cqs: 7,
      ias: 7,
      scoreItems20: SCORE_ITEMS_20.map((item) => ({
        ...item,
        score: 7,
        label: "差",
        evidence: ["证据显示经营恶化"],
        deductions: ["现金流差"],
        recentChange: "最近 12 个月继续恶化。",
        reason: "财务质量和经营趋势都很差。",
      })),
      redFlags: [],
      evidence: [
        {
          title: "Financials",
          source: "Public financials",
          url: "https://example.com",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
        {
          title: "Quote",
          source: "Public quote",
          url: "https://example.com/quote",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
      accountRules: { companyGrade: "A（优质公司，CQS约77）" },
    });

    expect(report.scoreItems20[0]).toMatchObject({ score: 7, label: "差" });
    expect(report.cqs).toBe(7);
    expect(report.ias).toBe(7);
    expect(report.qualitativeBand).toBe("高风险垃圾股");
    expect(report.conclusion).toBe("回避");
    expect(report.accountRules.companyGrade).toContain("D");
  });

  test("derives valuation view from valuation ranges when dashboard value is missing", () => {
    const report = validateReportPayload({
      company: { name: "Range Co." },
      evidence: [
        {
          title: "Quote",
          source: "Public quote",
          url: "https://example.com",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
        {
          title: "Financials",
          source: "Public financials",
          url: "https://example.com/financials",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
      redFlags: [],
      scoreItems20,
      summaryDashboard: {
        positionAdvice: "观察仓",
      },
      valuationAnalysis: {
        currentPrice: "1372.99",
        fairValueRange: "1300-1600",
        buyRange: "低于1100",
        sellReduceRange: "高于1800",
        conclusion: "当前价格位于合理价值区间内，但安全边际不厚。",
      },
    });

    expect(report.summaryDashboard.valuationView).toBe("合理");
  });

  test("drops placeholder valuation scenarios and risk rows instead of rendering unnamed empty items", () => {
    const report = validateReportPayload({
      company: { name: "五粮液" },
      evidence: [
        {
          title: "Quote",
          source: "Public quote",
          url: "https://example.com/quote",
          retrievedAt: "2026-05-11T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
        {
          title: "Financials",
          source: "Public financials",
          url: "https://example.com/financials",
          retrievedAt: "2026-05-11T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
      scoreItems20,
      valuationAnalysis: {
        currentPrice: "91.8",
        fairValueRange: "120-160",
        buyRange: "80-110",
        sellReduceRange: "190 以上",
        scenarios: [
          { name: "", assumptions: "", value: "", expectedReturn: "", probability: "" },
          { assumptions: "待验证", value: "待验证", expectedReturn: "待验证", probability: "待验证" },
          { name: "保守情景", assumptions: "利润零增长，PE 10 倍", value: "90", expectedReturn: "4%", probability: "30%" },
        ],
      },
      riskMatrix: [
        { type: "", risk: "", probability: "", impact: "", warningMetric: "", response: "" },
        { type: "未分类风险", risk: "待验证", probability: "待验证", impact: "待验证", warningMetric: "待验证观察", response: "观察" },
        { type: "行业风险", risk: "库存去化慢于预期", probability: "中", impact: "高", warningMetric: "批价与合同负债", response: "降低仓位" },
      ],
    });

    expect(report.valuationAnalysis.scenarios).toEqual([
      { name: "保守情景", assumptions: "利润零增长，PE 10 倍", value: "90", expectedReturn: "4%", probability: "30%" },
    ]);
    expect(report.riskMatrix).toEqual([
      { type: "行业风险", risk: "库存去化慢于预期", probability: "中", impact: "高", warningMetric: "批价与合同负债", response: "降低仓位" },
    ]);
  });

  test("replaces placeholder risk warning metrics with risk-specific tracking indicators", () => {
    const report = validateReportPayload({
      company: { name: "Risk Detail Co." },
      evidence: [
        {
          title: "Financials",
          source: "Public financials",
          url: "https://example.com/financials",
          retrievedAt: "2026-05-12T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
      riskMatrix: [
        { type: "核心风险", risk: "财务杠杆过高，流动性危机", probability: "中", impact: "偿债能力不足", warningMetric: "待验证", response: "观察" },
        { type: "核心风险", risk: "行业需求持续萎缩", probability: "高", impact: "收入利润进一步下滑", warningMetric: "待验证", response: "观察" },
        { type: "核心风险", risk: "高估值回调", probability: "高", impact: "小股东损失", warningMetric: "待验证", response: "观察" },
      ],
    });

    expect(report.riskMatrix.map((item) => item.warningMetric)).toEqual([
      "资产负债率、货币资金/短期债务、经营现金流",
      "营业收入同比、新签订单、毛利率",
      "PE/PB、股价相对合理价值区间、成交量",
    ]);
    expect(JSON.stringify(report.riskMatrix)).not.toContain("待验证");
  });

  test("derives buy action and standard position for high scores with reasonable-low valuation", () => {
    const report = validateReportPayload({
      company: { name: "Quality Co." },
      conclusion: "观察",
      scoreItems20: SCORE_ITEMS_20.map((item) => ({
        ...item,
        score: 82,
        label: "好",
        evidence: ["最新财报和估值证据支持较高评分"],
        deductions: ["安全边际仍需跟踪"],
        recentChange: "最近 12 个月基本面稳定。",
        reason: "公司质量和投资吸引力较高，估值处于合理偏低区间。",
      })),
      evidence: [
        {
          title: "Quote",
          source: "Public quote",
          url: "https://example.com/quote",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
        {
          title: "Financials",
          source: "Public financials",
          url: "https://example.com/financials",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
      summaryDashboard: { positionAdvice: "观察仓" },
      accountRules: { maxPosition: "观察仓" },
      valuationAnalysis: {
        currentPrice: "90",
        fairValueRange: "100-120",
        buyRange: "80-95",
        sellReduceRange: "150 以上",
        conclusion: "当前价格低于合理价值区间，具备一定安全边际。",
      },
    });

    expect(report.cqs).toBeGreaterThan(80);
    expect(report.ias).toBeGreaterThan(80);
    expect(report.summaryDashboard.valuationView).toBe("合理偏低");
    expect(report.conclusion).toBe("买入");
    expect(report.summaryDashboard.positionAdvice).toBe("标准仓 8-15%");
    expect(report.accountRules.maxPosition).toBe("标准仓 8-15%");
  });

  test("caps action at observation when real-time price is unavailable without lowering company quality", () => {
    const report = validateReportPayload({
      company: { name: "Great Co." },
      conclusion: "买入",
      scoreItems20: SCORE_ITEMS_20.map((item) => ({
        ...item,
        score: 88,
        label: "极好",
        evidence: ["最新财报显示质量很高"],
        deductions: ["需要确认买入价格"],
        recentChange: "最近 12 个月质量稳定。",
        reason: "基本面很强，但实时价格缺失导致无法判断安全边际。",
      })),
      evidence: [
        {
          title: "Financials",
          source: "Public financials",
          url: "https://example.com/financials",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
        {
          title: "SEC",
          source: "SEC EDGAR",
          url: "https://data.sec.gov",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
      summaryDashboard: { valuationView: "低估", positionAdvice: "标准仓 8-15%" },
      valuationAnalysis: {
        currentPrice: "数据不足（实时报价服务不可用）",
        fairValueRange: "100-130",
        buyRange: "90 以下",
        sellReduceRange: "160 以上",
        conclusion: "公司质量高，但当前价格缺失。",
      },
    });

    expect(report.cqs).toBeGreaterThan(85);
    expect(report.ias).toBeGreaterThan(85);
    expect(report.qualitativeBand).toBe("卓越复合成长股");
    expect(report.conclusion).toBe("观察");
    expect(report.summaryDashboard.positionAdvice).toContain("报价缺失");
    expect(report.accountRules.companyGrade).toContain("A+");
  });

  test("forces avoid action and zero position for critical red flags", () => {
    const report = validateReportPayload({
      company: { name: "Risk Co." },
      conclusion: "买入",
      scoreItems20: SCORE_ITEMS_20.map((item) => ({
        ...item,
        score: 78,
        label: "好",
        evidence: ["表面数据尚可"],
        deductions: ["存在重大红线"],
        recentChange: "最近 12 个月风险暴露。",
        reason: "红线风险应压倒普通评分。",
      })),
      redFlags: [{ label: "重大财务造假风险", cap: 25, severity: "critical", evidence: "审计意见异常" }],
      evidence: [
        {
          title: "Risk filing",
          source: "Exchange filing",
          url: "https://example.com/risk",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
        {
          title: "Quote",
          source: "Public quote",
          url: "https://example.com/quote",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
      valuationAnalysis: {
        currentPrice: "10",
        fairValueRange: "15-20",
        buyRange: "12 以下",
        sellReduceRange: "25 以上",
        conclusion: "看似低估但存在红线。",
      },
    });

    expect(report.ias).toBe(25);
    expect(report.conclusion).toBe("回避");
    expect(report.summaryDashboard.positionAdvice).toBe("0%");
    expect(report.accountRules.maxPosition).toBe("0%");
  });

  test("keeps avoid action at zero position for very weak investment scores", () => {
    const report = validateReportPayload({
      company: { name: "Weak Co." },
      conclusion: "回避",
      cqs: 32,
      ias: 35,
      scoreItems20: SCORE_ITEMS_20.map((item) => ({
        ...item,
        score: 35,
        label: "差",
        evidence: ["公开财务数据和经营趋势显示基本面偏弱"],
        deductions: ["盈利、现金流和安全边际不足"],
        recentChange: "最近 12 个月未见明确改善。",
        reason: "投资吸引力很低，应以回避为主。",
      })),
      redFlags: [],
      evidence: [
        {
          title: "Quote",
          source: "Public quote",
          url: "https://example.com/quote",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
        {
          title: "Financials",
          source: "Public financials",
          url: "https://example.com/financials",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
      valuationAnalysis: {
        currentPrice: "10",
        fairValueRange: "8-12",
        buyRange: "6 以下",
        sellReduceRange: "15 以上",
        conclusion: "估值无法弥补基本面风险。",
      },
    });

    expect(report.ias).toBeLessThanOrEqual(40);
    expect(report.conclusion).toBe("回避");
    expect(report.summaryDashboard.positionAdvice).toBe("0%");
    expect(report.accountRules.maxPosition).toBe("0%");
  });

  test("drops structurally empty financial rows instead of showing unnamed metrics", () => {
    const report = validateReportPayload({
      company: { name: "Financial Co." },
      evidence: [],
      redFlags: [],
      financialTenYear: {
        rows: [
          { values: {}, trend: "" },
          { metric: "营业收入", values: { "2025": "100亿" }, trend: "上升", interpretation: "增长" },
        ],
      },
    });

    expect(report.financialTenYear.rows).toHaveLength(1);
    expect(report.financialTenYear.rows[0].metric).toBe("营业收入");
  });
});
