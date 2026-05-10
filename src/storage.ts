import { validateReportPayload, type InvestmentReport } from "./shared/report";

const LAST_REPORT_KEY = "cstd-alpha:last-report";

export function saveLastReport(report: InvestmentReport) {
  localStorage.setItem(LAST_REPORT_KEY, JSON.stringify(report));
}

export function loadLastReport() {
  try {
    const raw = localStorage.getItem(LAST_REPORT_KEY);
    if (!raw) return null;
    const report = validateReportPayload(JSON.parse(raw));
    if (isLegacyModelFailureReport(report)) {
      localStorage.removeItem(LAST_REPORT_KEY);
      return null;
    }
    return report;
  } catch {
    return null;
  }
}

function isLegacyModelFailureReport(report: InvestmentReport) {
  const message = "DeepSeek returned an empty final response";
  return (
    report.oneSentence.includes(message) ||
    Object.values(report.fullSections).some((section) => section.includes(message)) ||
    (report.cqs === 0 && report.ias === 0 && report.evidence.length === 0 && report.redFlags.some((flag) => flag.evidence?.includes(message)))
  );
}
