import { validateReportPayload, type InvestmentReport, type ReportGenerationMetrics, type ReportTokenUsage } from "./shared/report";
import { normalizeChartBundle, type ChartBundle, type PriceMode } from "./shared/chart";
import type { CompanyCandidate } from "./shared/report";

const LAST_REPORT_KEY = "cstd-alpha:last-report";
const RECENT_REPORTS_KEY = "cstd-alpha:recent-reports";
const REPORT_CACHE_PREFIX = "cstd-alpha:report-cache:";
const CHART_CACHE_PREFIX = "cstd-alpha:chart-cache:";
const REPORT_CACHE_VERSION = "v5-report-cleanup";
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  const result = safeSetLocalStorage(LAST_REPORT_KEY, JSON.stringify(metrics ? { report, metrics } : report));
  saveRecentReport(report);
  return result;
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
  return safeSetLocalStorage(buildReportCacheKey(company), JSON.stringify(payload));
}

export function loadCachedReport(company: CompanyCandidate, now = Date.now()): CachedReport | null {
  try {
    const cacheKeys = reportCacheKeys(company);
    const cacheKey = cacheKeys.find((key) => localStorage.getItem(key));
    if (!cacheKey) return null;
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedReport>;
    if (!parsed.expiresAt || parsed.expiresAt <= now || !parsed.report) {
      localStorage.removeItem(cacheKey);
      return null;
    }
    const report = validateReportPayload(parsed.report);
    if (isLegacyModelFailureReport(report)) {
      localStorage.removeItem(cacheKey);
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
  return safeSetLocalStorage(buildChartCacheKey(company, priceMode), JSON.stringify(payload));
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

export function clearLocalReportStorage() {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(
      (key): key is string => typeof key === "string" && (key === LAST_REPORT_KEY || key.startsWith(REPORT_CACHE_PREFIX) || key.startsWith(CHART_CACHE_PREFIX)),
    );
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Local report caches are optional; ignore storage access failures.
  }
}

export type RecentReport = {
  name: string;
  ticker: string;
  cqs: number;
  ias: number;
  generatedAt: string;
};

export function saveRecentReport(report: InvestmentReport) {
  try {
    const existing = loadRecentReportHistory();
    const newEntry: RecentReport = {
      name: report.company.name,
      ticker: report.company.ticker || "",
      cqs: report.cqs,
      ias: report.ias,
      generatedAt: new Date().toISOString(),
    };
    const next = [newEntry, ...existing.filter((r) => r.name !== newEntry.name)].slice(0, 10);
    safeSetLocalStorage(RECENT_REPORTS_KEY, JSON.stringify(next));
  } catch {
    // Storage failure is non-critical
  }
}

export function loadRecentReportHistory(): RecentReport[] {
  try {
    const raw = localStorage.getItem(RECENT_REPORTS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RecentReport[];
  } catch {
    return [];
  }
}

function safeSetLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
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
    cacheHit: typeof value.cacheHit === "boolean" ? value.cacheHit : undefined,
    cachedAt: typeof value.cachedAt === "string" ? value.cachedAt : undefined,
    sourceElapsedMs: typeof value.sourceElapsedMs === "number" ? value.sourceElapsedMs : undefined,
    tokenUsage: normalizeTokenUsage(value.tokenUsage),
  };
}

function normalizeTokenUsage(value: unknown): ReportTokenUsage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const usage = value.flatMap((item) => {
    if (!isRecord(item) || typeof item.model !== "string") return [];
    return [
      {
        model: item.model,
        calls: numberOrZero(item.calls),
        promptTokens: numberOrZero(item.promptTokens),
        promptCacheHitTokens: numberOrZero(item.promptCacheHitTokens),
        promptCacheMissTokens: numberOrZero(item.promptCacheMissTokens),
        completionTokens: numberOrZero(item.completionTokens),
        totalTokens: numberOrZero(item.totalTokens),
      },
    ];
  });
  return usage.length ? usage : undefined;
}

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stableCompanyId(company: CompanyCandidate) {
  const market = normalizeCacheIdentityPart(company.listingPlace);
  const code = normalizeCacheIdentityPart(company.code);
  const name = normalizeCacheIdentityPart(company.name);
  return code ? `${market || "UNKNOWN"}:${code}` : `${market || "UNKNOWN"}:${name}`;
}

function reportCacheKeys(company: CompanyCandidate) {
  return Array.from(new Set([buildReportCacheKey(company), `${REPORT_CACHE_PREFIX}${REPORT_CACHE_VERSION}:${legacyStableCompanyId(company)}`]));
}

function legacyStableCompanyId(company: CompanyCandidate) {
  return [company.id, company.code, company.listingPlace].filter(Boolean).join(":");
}

function normalizeCacheIdentityPart(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
