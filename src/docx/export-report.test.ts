import { describe, expect, test } from "vitest";
import { buildReportDocxBlob } from "./export-report";
import { MODULE_WEIGHTS, validateReportPayload, type InvestmentReport } from "../shared/report";

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
    label: "好",
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
} as InvestmentReport;
const normalizedReport = validateReportPayload(report);

describe("DOCX export", () => {
  test("creates a valid docx blob", async () => {
    const blob = await buildReportDocxBlob(normalizedReport);

    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(blob.size).toBeGreaterThan(1000);
  });

  test("creates a valid docx blob with chart summary", async () => {
    const plainBlob = await buildReportDocxBlob(normalizedReport);
    const blob = await buildReportDocxBlob(normalizedReport, {
      company: { name: "Example Inc.", ticker: "EXM", market: "US" },
      asOf: "2026-05-10T00:00:00.000Z",
      priceMode: "adjusted",
      priceSeries: [
        { date: "2024-01-01", close: 10, adjustedClose: 10, volume: 100 },
        { date: "2025-01-01", close: 15, adjustedClose: 15, volume: 120 },
      ],
      drawdownSeries: [
        { date: "2024-01-01", price: 10, peak: 10, drawdown: 0 },
        { date: "2025-01-01", price: 15, peak: 15, drawdown: 0 },
      ],
      marketSnapshot: { currentPrice: 15, maxDrawdown: 0, latestDate: "2025-01-01" },
      evidence: [],
    });

    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(blob.size).toBeGreaterThan(plainBlob.size);
  });
});
