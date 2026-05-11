import { validateReportPayload, type InvestmentReport, type ReportGenerationMetrics } from "./shared/report";
import { normalizeChartBundle, type ChartBundle, type PriceMode } from "./shared/chart";
import type { CompanyCandidate } from "./shared/report";

const LAST_REPORT_KEY = "cstd-alpha:last-report";
const REPORT_CACHE_PREFIX = "cstd-alpha:report-cache:";
const CHART_CACHE_PREFIX = "cstd-alpha:chart-cache:";
const REPORT_CACHE_VERSION = "v4-deep-financials";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type CachedReport = {
  report: InvestmentReport;
  cachedAt: number;
  expiresAt: number;
  metrics?: ReportGenerationMetrics;
};

export type CachedChart = {
  chart: ChartBundle;
  cachedAt: number;
  expiresAt: number;
};

export type StoredReportEntry = {
  report: InvestmentReport;
  metrics?: ReportGenerationMetrics;
};

export function saveLastReport(report: InvestmentReport, metrics?: ReportGenerationMetrics) {
  localStorage.setItem(LAST_REPORT_KEY, JSON.stringify(metrics ? { report, metrics } : report));
}

export function loadLastReport() {
  return loadLastReportEntry()?.report ?? null;
}

export function loadLastReportEntry(): StoredReportEntry | null {
  try {
    const raw = localStorage.getItem(LAST_REPORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const entry = unwrapStoredReport(parsed);
    const report = validateReportPayload(entry.report);
    if (isLegacyModelFailureReport(report)) {
      localStorage.removeItem(LAST_REPORT_KEY);
      return null;
    }
    return { report, metrics: normalizeGenerationMetrics(entry.metrics) };
  } catch {
    return null;
  }
}

export function buildReportCacheKey(company: CompanyCandidate) {
  return `${REPORT_CACHE_PREFIX}${REPORT_CACHE_VERSION}:${stableCompanyId(company)}`;
}

export function buildChartCacheKey(company: CompanyCandidate, priceMode: PriceMode) {
  return `${CHART_CACHE_PREFIX}${REPORT_CACHE_VERSION}:${stableCompanyId(company)}:${priceMode}`;
}

export function saveCachedReport(company: CompanyCandidate, report: InvestmentReport, now = Date.now(), metrics?: ReportGenerationMetrics) {
  const payload: CachedReport = {
    report,
    cachedAt: now,
    expiresAt: now + CACHE_TTL_MS,
    metrics,
  };
  localStorage.setItem(buildReportCacheKey(company), JSON.stringify(payload));
}

export function loadCachedReport(company: CompanyCandidate, now = Date.now()): CachedReport | null {
  try {
    const raw = localStorage.getItem(buildReportCacheKey(company));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedReport>;
    if (!parsed.expiresAt || parsed.expiresAt <= now || !parsed.report) {
      localStorage.removeItem(buildReportCacheKey(company));
      return null;
    }
    const report = validateReportPayload(parsed.report);
    if (isLegacyModelFailureReport(report)) {
      localStorage.removeItem(buildReportCacheKey(company));
      return null;
    }
    return { report, cachedAt: Number(parsed.cachedAt) || now, expiresAt: parsed.expiresAt, metrics: normalizeGenerationMetrics(parsed.metrics) };
  } catch {
    return null;
  }
}

export function saveCachedChart(company: CompanyCandidate, priceMode: PriceMode, chart: ChartBundle, now = Date.now()) {
  const payload: CachedChart = {
    chart,
    cachedAt: now,
    expiresAt: now + CACHE_TTL_MS,
  };
  localStorage.setItem(buildChartCacheKey(company, priceMode), JSON.stringify(payload));
}

export function loadCachedChart(company: CompanyCandidate, priceMode: PriceMode, now = Date.now()): CachedChart | null {
  try {
    const raw = localStorage.getItem(buildChartCacheKey(company, priceMode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedChart>;
    if (!parsed.expiresAt || parsed.expiresAt <= now || !parsed.chart) {
      localStorage.removeItem(buildChartCacheKey(company, priceMode));
      return null;
    }
    return {
      chart: normalizeChartBundle(parsed.chart),
      cachedAt: Number(parsed.cachedAt) || now,
      expiresAt: parsed.expiresAt,
    };
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

function unwrapStoredReport(value: unknown): StoredReportEntry {
  if (isRecord(value) && isRecord(value.report)) {
    return { report: value.report as InvestmentReport, metrics: normalizeGenerationMetrics(value.metrics) };
  }
  return { report: value as InvestmentReport };
}

function normalizeGenerationMetrics(value: unknown): ReportGenerationMetrics | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.startedAt !== "string" ||
    typeof value.completedAt !== "string" ||
    typeof value.elapsedMs !== "number" ||
    typeof value.modelCalls !== "number" ||
    (value.cacheMode !== "prefer-cache" && value.cacheMode !== "refresh")
  ) {
    return undefined;
  }
  return {
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    elapsedMs: value.elapsedMs,
    modelCalls: value.modelCalls,
    cacheMode: value.cacheMode,
  };
}

function stableCompanyId(company: CompanyCandidate) {
  return [company.id, company.code, company.listingPlace].filter(Boolean).join(":");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
