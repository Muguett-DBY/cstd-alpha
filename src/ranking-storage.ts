import { parseReportLibraryReportsJson, validateLibraryReport, type ImportedLibraryReport } from "./shared/report-library";
import type { InvestmentReport } from "./shared/report";
import { reportIdentityKey } from "./shared/report-identity";

const IMPORTED_REPORTS_KEY = "cstd-alpha:ranking-imported-reports:v1";

export type ImportedRankingReport = ImportedLibraryReport;

export function loadImportedRankingReports(): ImportedRankingReport[] {
  try {
    const raw = localStorage.getItem(IMPORTED_REPORTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!isRecord(item) || !isRecord(item.report) || typeof item.importedAt !== "string") return [];
      try {
        return [{ report: validateLibraryReport(item.report), importedAt: item.importedAt }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function saveImportedRankingReports(entries: ImportedRankingReport[]) {
  return safeSetLocalStorage(IMPORTED_REPORTS_KEY, JSON.stringify(entries));
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

export function clearImportedRankingReports() {
  try {
    localStorage.removeItem(IMPORTED_REPORTS_KEY);
  } catch {
    // Local imported ranking cache is optional.
  }
}

export function parseRankingReportJson(raw: string): InvestmentReport[] {
  return parseReportLibraryReportsJson(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeSetLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
