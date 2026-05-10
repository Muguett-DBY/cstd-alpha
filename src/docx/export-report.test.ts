import { describe, expect, test } from "vitest";
import { buildReportDocxBlob } from "./export-report";
import { MODULE_WEIGHTS, type InvestmentReport } from "../shared/report";

const report: InvestmentReport = {
  company: { name: "Example Inc.", ticker: "EXM", market: "US" },
  asOf: "2026-05-10T00:00:00.000Z",
  conclusion: "观察",
  oneSentence: "A test company.",
  cqs: 71,
  ias: 64,
  moduleScores: MODULE_WEIGHTS.map((module) => ({
    id: module.id,
    name: module.name,
    weight: module.weight,
    score: 70,
    weightedScore: module.weight * 0.7,
    summary: "summary",
    evidence: ["evidence"],
    concerns: ["concern"],
  })),
  redFlags: [],
  evidence: [],
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
};

describe("DOCX export", () => {
  test("creates a valid docx blob", async () => {
    const blob = await buildReportDocxBlob(report);

    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(blob.size).toBeGreaterThan(1000);
  });
});
