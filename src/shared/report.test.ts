import { describe, expect, test } from "vitest";
import {
  applyRiskCaps,
  calculateWeightedScore,
  MODULE_WEIGHTS,
  validateReportPayload,
  type ModuleScore,
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

describe("report scoring", () => {
  test("module weights sum to 100", () => {
    expect(MODULE_WEIGHTS.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
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
      disclaimer: "Research only.",
    });

    expect(report.company.name).toBe("Example Inc.");
  });

  test("rejects payloads missing required sections", () => {
    expect(() =>
      validateReportPayload({
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
      }),
    ).toThrow(/missing required report section/i);
  });
});
