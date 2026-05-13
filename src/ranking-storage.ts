import { validateReportPayload, type InvestmentReport } from "./shared/report";
import { reportIdentityKey } from "./shared/ranking";

const IMPORTED_REPORTS_KEY = "cstd-alpha:ranking-imported-reports:v1";

export type ImportedRankingReport = {
  report: InvestmentReport;
  importedAt: string;
};

export function loadImportedRankingReports(): ImportedRankingReport[] {
  try {
    const raw = localStorage.getItem(IMPORTED_REPORTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!isRecord(item) || !isRecord(item.report) || typeof item.importedAt !== "string") return [];
      try {
        return [{ report: validateRankingReport(item.report), importedAt: item.importedAt }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function saveImportedRankingReports(entries: ImportedRankingReport[]) {
  localStorage.setItem(IMPORTED_REPORTS_KEY, JSON.stringify(entries));
}

export function upsertImportedRankingReports(reports: InvestmentReport[], now = new Date().toISOString()) {
  const byKey = new Map(loadImportedRankingReports().map((entry) => [reportIdentityKey(entry.report), entry]));
  for (const report of reports) byKey.set(reportIdentityKey(report), { report, importedAt: now });
  const entries = Array.from(byKey.values()).sort((left, right) => reportIdentityKey(left.report).localeCompare(reportIdentityKey(right.report)));
  saveImportedRankingReports(entries);
  return entries;
}

export function deleteImportedRankingReport(report: InvestmentReport) {
  const key = reportIdentityKey(report);
  const entries = loadImportedRankingReports().filter((entry) => reportIdentityKey(entry.report) !== key);
  saveImportedRankingReports(entries);
  return entries;
}

export function parseRankingReportJson(raw: string): InvestmentReport[] {
  const parsed = JSON.parse(raw) as unknown;
  const candidates = extractReportCandidates(parsed);
  const reports = candidates.map((item) => validateRankingReport(item));
  if (!reports.length) throw new Error("没有识别到可导入的报告 JSON。");
  return reports;
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

function validateRankingReport(value: unknown) {
  const report = validateReportPayload(stripGeneratedZeroScoreItems(value));
  assertDeepReport(report);
  return report;
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
