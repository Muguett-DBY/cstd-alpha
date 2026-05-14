import { validateReportPayload, type InvestmentReport } from "./report";
import { reportIdentityKey } from "./ranking";
import { normalizeIndustryLabel } from "./industry";

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
  const conclusion = normalizeEntryConclusion(report.conclusion, report.cqs, report.ias);
  return {
    id,
    companyName: report.company.name,
    ticker: report.company.ticker,
    market: report.company.market,
    industry,
    sector,
    cqs: report.cqs,
    ias: report.ias,
    conclusion,
    qualitativeBand: report.qualitativeBand,
    positionAdvice: normalizeEntryPositionAdvice(conclusion, report.summaryDashboard.positionAdvice || report.accountRules.maxPosition, report.cqs, report.ias),
    valuationView: normalizeEntryValuationView(report.summaryDashboard.valuationView),
    asOf: report.asOf,
    importedAt,
    evidenceCount: report.evidence.length,
    scoreItemCount: report.scoreItems20.filter((item) => item.score > 0).length,
  };
}

export function cleanIndustryLabel(value: unknown) {
  return normalizeIndustryLabel(value);
}

export function normalizeEntryConclusion(conclusion: InvestmentReport["conclusion"], cqs?: number, ias?: number): InvestmentReport["conclusion"] {
  if (conclusion === "回避" || conclusion === "卖出") return conclusion;
  const safeCqs = typeof cqs === "number" && Number.isFinite(cqs) ? cqs : 0;
  const safeIas = typeof ias === "number" && Number.isFinite(ias) ? ias : 0;
  if (safeIas <= 40) return "回避";
  if (safeIas <= 50) return "观察";
  if ((conclusion === "买入" || conclusion === "加仓") && (safeIas < 76 || safeCqs < 70)) {
    return safeIas >= 66 && safeCqs >= 70 ? "持有" : "观察";
  }
  if (conclusion === "持有" && (safeIas < 66 || safeCqs < 70)) return "观察";
  return conclusion;
}

export function normalizeEntryPositionAdvice(conclusion: InvestmentReport["conclusion"], value: unknown, cqs?: number, ias?: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (conclusion === "回避" || conclusion === "卖出") return "0%";
  if ((conclusion === "买入" || conclusion === "加仓") && (!text || /观察|待验证|报价缺失|暂不建仓/.test(text))) {
    const safeCqs = typeof cqs === "number" && Number.isFinite(cqs) ? cqs : 0;
    const safeIas = typeof ias === "number" && Number.isFinite(ias) ? ias : 0;
    if (safeIas < 76 || safeCqs < 70) return "观察仓";
    return conclusion === "加仓" ? "15-20% 上限" : "标准仓 8-15%";
  }
  if (conclusion === "持有" && (!text || /观察|待验证|报价缺失|暂不建仓/.test(text))) return "小仓 3-8%";
  return text || "观察仓";
}

export function normalizeEntryValuationView(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "估值待复核";
  if (/unavailable|无公开报价|暂无报价|缺乏实时|行情数据暂不可用|报价缺失|不可用|无法计算/i.test(text)) {
    return "估值待复核";
  }
  return text;
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
