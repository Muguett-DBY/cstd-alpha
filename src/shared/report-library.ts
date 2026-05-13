import { validateReportPayload, type InvestmentReport } from "./report";
import { reportIdentityKey } from "./ranking";

export type ReportLibraryEntry = {
  id: string;
  companyName: string;
  ticker?: string;
  market?: string;
  industry?: string;
  sector?: string;
  cqs: number;
  ias: number;
  conclusion: InvestmentReport["conclusion"];
  qualitativeBand: string;
  positionAdvice: string;
  valuationView: string;
  asOf: string;
  importedAt: string;
  evidenceCount: number;
  scoreItemCount: number;
};

export type ImportedLibraryReport = {
  report: InvestmentReport;
  importedAt: string;
};

export function parseReportLibraryReports(value: unknown): InvestmentReport[] {
  const candidates = extractReportCandidates(value);
  const reports = candidates.map((item) => validateLibraryReport(item));
  if (!reports.length) throw new Error("没有识别到可导入的报告 JSON。");
  return reports;
}

export function parseReportLibraryReportsJson(raw: string): InvestmentReport[] {
  return parseReportLibraryReports(JSON.parse(raw) as unknown);
}

export function validateLibraryReport(value: unknown) {
  const report = validateReportPayload(stripGeneratedZeroScoreItems(value));
  assertDeepReport(report);
  return report;
}

export function buildReportLibraryEntry(report: InvestmentReport, id: string, importedAt: string): ReportLibraryEntry {
  const industry = cleanIndustryLabel(report.company.industry);
  const sector = cleanIndustryLabel(report.company.sector);
  return {
    id,
    companyName: report.company.name,
    ticker: report.company.ticker,
    market: report.company.market,
    industry,
    sector,
    cqs: report.cqs,
    ias: report.ias,
    conclusion: report.conclusion,
    qualitativeBand: report.qualitativeBand,
    positionAdvice: report.summaryDashboard.positionAdvice || report.accountRules.maxPosition,
    valuationView: report.summaryDashboard.valuationView,
    asOf: report.asOf,
    importedAt,
    evidenceCount: report.evidence.length,
    scoreItemCount: report.scoreItems20.filter((item) => item.score > 0).length,
  };
}

export function cleanIndustryLabel(value: unknown) {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  if (!label || /^(AStock|UsStock|HK|EQUITY|Imported|Library)$/i.test(label)) return undefined;
  return label;
}

export function importedEntryToReport(entry: ReportLibraryEntry, report: InvestmentReport): ImportedLibraryReport {
  return { report, importedAt: entry.importedAt };
}

export function reportLibraryIdentity(report: InvestmentReport) {
  return reportIdentityKey(report);
}

function extractReportCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  if (Array.isArray(value.reports)) return value.reports;
  if (Array.isArray(value.items)) return value.items;
  if (isRecord(value.report)) return [value.report];
  if (isRecord(value.company)) return [value];
  return [];
}

function assertDeepReport(report: InvestmentReport) {
  const scoredItems = report.scoreItems20.filter((item) => item.score > 0).length;
  const publicEvidence = report.evidence.filter((item) => item.freshness === "latest-public").length;
  if (scoredItems < 15) {
    throw new Error("导入报告需要包含完整 20 项评分，且至少 15 项有有效分数。");
  }
  if (publicEvidence < 2) {
    throw new Error("导入报告需要至少 2 条 latest-public 公开证据。");
  }
}

function stripGeneratedZeroScoreItems(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.scoreItems20)) return value;
  const hasTopLevelScores = positiveNumber(value.cqs) || positiveNumber(value.ias);
  const allZeroScoreItems = value.scoreItems20.every((item) => isRecord(item) && item.score === 0);
  if (!hasTopLevelScores || !allZeroScoreItems) return value;
  const rest = { ...value };
  delete rest.scoreItems20;
  return rest;
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
