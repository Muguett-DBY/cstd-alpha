import type { ChartBundle, PriceMode } from "./shared/chart";
import type { CompanyNewsBundle } from "./shared/news";
import type { ReportLibraryEntry } from "./shared/report-library";
import type { CompanyCandidate, InvestmentReport, ReportGenerationMetrics, ReportTokenUsage } from "./shared/report";
import type { ResearchTemplate, TemplateAnalysisResult, UserSession, WatchlistItem } from "./shared/user-research";

export type GenerateReportInput = {
  company: CompanyCandidate;
  forceRefresh?: boolean;
  cacheMode?: "prefer-cache" | "refresh";
  signal?: AbortSignal;
};

export type FetchChartDataInput = {
  company: CompanyCandidate;
  priceMode: PriceMode;
};

export type ReportProgress = {
  type: "progress";
  stage: string;
  label: string;
  detail: string;
  percent: number;
  at: string;
  startedAt?: string;
  elapsedMs?: number;
  evidenceCount?: number;
};

export type ReportGenerationResult = {
  report: InvestmentReport;
  metrics?: ReportGenerationMetrics;
};

export type TemplateAnalysisProgress = {
  type: "progress";
  stage: string;
  label: string;
  detail: string;
  at?: string;
};

export type ReportLibraryRecord = {
  entry: ReportLibraryEntry;
  report: InvestmentReport;
};

export type ReportLibraryList = {
  entries: ReportLibraryEntry[];
  anchorEntries?: ReportLibraryEntry[];
  total: number;
  limit?: number;
  offset?: number;
  matchedTickers?: string[];
};

export async function checkSession(): Promise<UserSession | null> {
  const response = await fetch("/api/session", { credentials: "include" });
  if (!response.ok) return null;
  const data = (await response.json()) as { user?: UserSession | null };
  return data.user ?? null;
}

export async function login(password: string, username?: string): Promise<UserSession | null> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ password, username }),
  });

  if (!response.ok) throw new Error((await readError(response)) || "登录失败。");
  const data = (await response.json()) as { user?: UserSession | null };
  if (!data.user) throw new Error("登录失败：服务端未返回账号信息。");
  return data.user ?? null;
}

export async function logout(): Promise<void> {
  await fetch("/api/session", { method: "DELETE", credentials: "include" });
}

export async function searchCompanies(query: string): Promise<CompanyCandidate[]> {
  const response = await fetch(`/api/company-search?q=${encodeURIComponent(query)}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "公司搜索失败。");
  const data = (await response.json()) as { candidates?: CompanyCandidate[] };
  return data.candidates ?? [];
}

export async function generateReport(input: GenerateReportInput, onProgress?: (progress: ReportProgress) => void): Promise<ReportGenerationResult> {
  const { signal, ...body } = input;
  let response: Response;
  try {
    response = await fetch("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      signal,
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (isAbortLikeError(error)) throw reportCancelledError(error);
    throw reportConnectionError(error);
  }

  if (!response.ok) throw new Error((await readError(response)) || "报告生成失败。");

  let finalReport: InvestmentReport | undefined;
  let finalMetrics: ReportGenerationMetrics | undefined;
  try {
    for await (const event of readNdjson(response)) {
      if (event.type === "progress") onProgress?.(event as ReportProgress);
      if (event.type === "error") throw new Error(String(event.error || "报告生成失败。"));
      if (event.type === "final") {
        finalReport = event.report as InvestmentReport;
        finalMetrics = normalizeMetrics(event.metrics);
      }
    }
  } catch (error) {
    if (isAbortLikeError(error)) throw reportCancelledError(error);
    if (isNetworkLikeError(error)) throw reportConnectionError(error);
    throw error;
  }

  if (!finalReport) throw new Error("报告连接提前结束，后台会继续生成；稍后再次点击生成会自动复用共享缓存。");
  return { report: finalReport, metrics: finalMetrics };
}

export async function fetchChartData(input: FetchChartDataInput): Promise<ChartBundle> {
  const response = await fetch("/api/chart-data", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });

  if (!response.ok) throw new Error((await readError(response)) || "图表数据生成失败。");
  return (await response.json()) as ChartBundle;
}

export async function fetchReportLibrary(
  options: { limit?: number; offset?: number; sort?: string; direction?: string; industry?: string; market?: string; seedCodes?: string[]; tickers?: string[] } = {},
): Promise<ReportLibraryList> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 20),
    offset: String(options.offset ?? 0),
    sort: options.sort ?? "rank",
    direction: options.direction ?? "desc",
  });
  if (options.market) params.set("market", options.market);
  if (options.industry && options.industry !== "全部行业") params.set("industry", options.industry);
  if (options.seedCodes?.length) params.set("seedCodes", options.seedCodes.join(","));
  if (options.tickers?.length) params.set("tickers", options.tickers.join(","));
  const response = await fetch(`/api/report-library?${params.toString()}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "报告库读取失败。");
  const data = (await response.json()) as { entries?: ReportLibraryEntry[]; total?: number; limit?: number; offset?: number; matchedTickers?: string[] };
  const entries = data.entries ?? [];
  return { entries, total: data.total ?? entries.length, limit: data.limit, offset: data.offset, matchedTickers: data.matchedTickers };
}

export async function fetchReportLibraryRecord(id: string): Promise<ReportLibraryRecord> {
  const response = await fetch(`/api/report-library?id=${encodeURIComponent(id)}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "报告读取失败。");
  return (await response.json()) as ReportLibraryRecord;
}

export async function importReportLibraryReports(reports: InvestmentReport[]): Promise<ReportLibraryEntry[]> {
  const response = await fetch("/api/report-library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ reports }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "报告导入失败。");
  const data = (await response.json()) as { imported?: ReportLibraryEntry[] };
  return data.imported ?? [];
}

export async function fetchWatchlist(): Promise<{ items: WatchlistItem[]; user?: UserSession }> {
  const response = await fetch("/api/watchlist", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "自选股读取失败。");
  const data = (await response.json()) as { items?: WatchlistItem[]; user?: UserSession };
  return { items: data.items ?? [], user: data.user };
}

export async function addWatchlistItem(input: { company: CompanyCandidate; reportLibraryId?: string }): Promise<WatchlistItem> {
  const response = await fetch("/api/watchlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error((await readError(response)) || "加入自选失败。");
  const data = (await response.json()) as { item?: WatchlistItem };
  if (!data.item) throw new Error("加入自选失败。");
  return data.item;
}

export async function removeWatchlistItem(id: string) {
  const response = await fetch(`/api/watchlist?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "移除自选失败。");
}

export async function fetchTemplateAnalyses(watchlistId?: string): Promise<{ analyses: TemplateAnalysisResult[]; templates: ResearchTemplate[] }> {
  const params = new URLSearchParams();
  if (watchlistId) params.set("watchlistId", watchlistId);
  const response = await fetch(`/api/template-analysis${params.size ? `?${params.toString()}` : ""}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "模板分析读取失败。");
  const data = (await response.json()) as { analyses?: TemplateAnalysisResult[]; templates?: ResearchTemplate[] };
  return { analyses: data.analyses ?? [], templates: data.templates ?? [] };
}

export async function fetchTemplateAnalysis(analysisId: string): Promise<TemplateAnalysisResult> {
  const response = await fetch(`/api/template-analysis?analysisId=${encodeURIComponent(analysisId)}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "模板报告读取失败。");
  const data = (await response.json()) as { analysis?: TemplateAnalysisResult };
  if (!data.analysis) throw new Error("模板报告读取失败。");
  return data.analysis;
}

export async function fetchCompanyNews(watchlistId: string): Promise<CompanyNewsBundle> {
  const response = await fetch(`/api/company-news?watchlistId=${encodeURIComponent(watchlistId)}&t=${Date.now()}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error((await readError(response)) || "新闻读取失败。");
  return (await response.json()) as CompanyNewsBundle;
}

export async function generateTemplateAnalysis(
  input: { watchlistId: string; templateId: string; forceRefresh?: boolean },
  onProgress?: (progress: TemplateAnalysisProgress) => void,
): Promise<{ analysis?: TemplateAnalysisResult; analyses?: TemplateAnalysisResult[] }> {
  const response = await fetch("/api/template-analysis", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error((await readError(response)) || "模板分析生成失败。");
  if (response.headers.get("content-type")?.includes("application/x-ndjson")) {
    let finalResult: { analysis?: TemplateAnalysisResult; analyses?: TemplateAnalysisResult[] } | undefined;
    for await (const event of readNdjson(response)) {
      if (event.type === "progress") onProgress?.(event as TemplateAnalysisProgress);
      if (event.type === "error") throw new Error(String(event.error || "模板分析生成失败。"));
      if (event.type === "final") {
        finalResult = {
          analysis: event.analysis as TemplateAnalysisResult | undefined,
          analyses: event.analyses as TemplateAnalysisResult[] | undefined,
        };
      }
    }
    if (!finalResult?.analysis && !finalResult?.analyses) throw new Error("模板分析连接提前结束，请稍后重试。");
    return finalResult;
  }
  const data = (await response.json()) as { analysis?: TemplateAnalysisResult; analyses?: TemplateAnalysisResult[] };
  if (!data.analysis && !data.analyses) throw new Error("模板分析生成失败。");
  return data;
}

async function* readNdjson(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    const data = JSON.parse(await response.text()) as Record<string, unknown>;
    yield data;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw reportConnectionError(error);
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      yield parseNdjsonLine(trimmed);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) yield parseNdjsonLine(buffer.trim());
}

function reportConnectionError(cause?: unknown) {
  return new Error("报告连接中断，后台会继续生成；稍后再次点击生成会自动复用共享缓存。", { cause });
}

function reportCancelledError(cause?: unknown) {
  return new Error("已停止等待，后台仍会继续生成。", { cause });
}

function isAbortLikeError(error: unknown) {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

function isNetworkLikeError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return error instanceof TypeError || message.includes("network") || message.includes("failed to fetch") || message.includes("load failed");
}

function parseNdjsonLine(line: string): Record<string, unknown> {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    throw new Error("报告响应不完整，请重试。", { cause: error });
  }
}

async function readError(response: Response) {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error;
  } catch {
    return response.statusText;
  }
}

function normalizeMetrics(value: unknown): ReportGenerationMetrics | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<ReportGenerationMetrics>;
  if (
    typeof record.startedAt !== "string" ||
    typeof record.completedAt !== "string" ||
    typeof record.elapsedMs !== "number" ||
    typeof record.modelCalls !== "number" ||
    (record.cacheMode !== "prefer-cache" && record.cacheMode !== "refresh")
  ) {
    return undefined;
  }
  return {
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    elapsedMs: record.elapsedMs,
    modelCalls: record.modelCalls,
    cacheMode: record.cacheMode,
    cacheHit: typeof record.cacheHit === "boolean" ? record.cacheHit : undefined,
    cachedAt: typeof record.cachedAt === "string" ? record.cachedAt : undefined,
    sourceElapsedMs: typeof record.sourceElapsedMs === "number" ? record.sourceElapsedMs : undefined,
    tokenUsage: normalizeTokenUsage(record.tokenUsage),
  };
}

function normalizeTokenUsage(value: unknown): ReportTokenUsage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const usage = value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Partial<ReportTokenUsage>;
    if (typeof record.model !== "string") return [];
    return [
      {
        model: record.model,
        calls: numberOrZero(record.calls),
        promptTokens: numberOrZero(record.promptTokens),
        promptCacheHitTokens: numberOrZero(record.promptCacheHitTokens),
        promptCacheMissTokens: numberOrZero(record.promptCacheMissTokens),
        completionTokens: numberOrZero(record.completionTokens),
        totalTokens: numberOrZero(record.totalTokens),
      },
    ];
  });
  return usage.length ? usage : undefined;
}

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
