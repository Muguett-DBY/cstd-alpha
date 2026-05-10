import { validateReportPayload, type InvestmentReport } from "./shared/report";

const LAST_REPORT_KEY = "cstd-alpha:last-report";

export function saveLastReport(report: InvestmentReport) {
  localStorage.setItem(LAST_REPORT_KEY, JSON.stringify(report));
}

export function loadLastReport() {
  try {
    const raw = localStorage.getItem(LAST_REPORT_KEY);
    return raw ? validateReportPayload(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
