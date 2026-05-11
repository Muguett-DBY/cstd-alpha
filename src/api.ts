import type { ChartBundle, PriceMode } from "./shared/chart";
import type { CompanyCandidate, InvestmentReport, ReportGenerationMetrics, ReportTokenUsage } from "./shared/report";

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

export async function checkSession() {
  const response = await fetch("/api/session", { credentials: "include" });
  return response.ok;
}

export async function login(password: string) {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ password }),
  });

  if (!response.ok) throw new Error((await readError(response)) || "登录失败。");
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
