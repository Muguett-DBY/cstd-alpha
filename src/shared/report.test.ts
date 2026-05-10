import { describe, expect, test } from "vitest";
import {
  applyRiskCaps,
  calculateWeightedScore,
  MODULE_WEIGHTS,
  SCORE_ITEMS_20,
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
});
