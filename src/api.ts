import type { ChartBundle, PriceMode } from "./shared/chart";
import type { CompanyNewsBundle } from "./shared/news";
import type { RadarAnalysisJob, RadarDiagnostics, RadarScan } from "./shared/radar";
import type { ReportLibraryEntry } from "./shared/report-library";
import type { CompanyCandidate, InvestmentReport, ReportGenerationMetrics, ReportTokenUsage } from "./shared/report";
import type { AssistantChatStreamEvent, AssistantDeepResearchJob, AssistantMessage, AssistantMode, AssistantThread } from "./shared/assistant";
import type { ResearchCatalyst, ResearchCatalystStatus, ResearchOpportunitySignal, ResearchStage, ResearchThesisVersion, ResearchWorkbenchItem } from "./shared/research-workbench";
import type { ValuationRunSummary } from "./shared/valuation";
import type { EditableAssumption, QuantitativeValuationVersion, QuantitativeValuationWorkspace } from "./shared/quantitative-valuation";
import type { ResearchTemplate, TemplateAnalysisResult, UserSession, WatchlistItem, WatchlistRankingEntry } from "./shared/user-research";

export type GenerateReportInput = {
  company: CompanyCandidate;
  forceRefresh?: boolean;
  cacheMode?: "prefer-cache" | "refresh";
  signal?: AbortSignal;
};

export const REPORT_CANCELLED_MESSAGE = "已停止等待，后台仍会继续生成。";

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

export type ResearchTemplateCompletion = Pick<ResearchTemplate, "title" | "shortTitle" | "focus" | "prompt" | "fullPrompt" | "sectionRequirements">;

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

export type RadarScanResult = {
  radar: RadarScan | null;
  job?: RadarAnalysisJob | null;
  warning?: string;
  diagnostics?: RadarDiagnostics | null;
};

export type OpportunitiesResult = {
  generatedAt: string;
  opportunities: ResearchOpportunitySignal[];
  topResearch: ResearchOpportunitySignal[];
  riskWorsening: ResearchOpportunitySignal[];
  catalysts: ResearchOpportunitySignal[];
  funnel: Array<{ stage: ResearchStage; count: number }>;
  inbox: Array<{ id: string; itemId?: string; type: string; title: string; body: string; severity: string; status: string; createdAt: string }>;
  researchItems: ResearchWorkbenchItem[];
};

export type ResearchItemsResult = {
  items: ResearchWorkbenchItem[];
};

export type ResearchThesesResult = {
  current: ResearchThesisVersion | null;
  versions: ResearchThesisVersion[];
};

export type ResearchCatalystsResult = {
  catalysts: ResearchCatalyst[];
};

export type ValuationsResult = {
  runs: ValuationRunSummary[];
};

export async function fetchOpportunities(): Promise<OpportunitiesResult> {
  const response = await fetch("/api/opportunities", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "今日机会读取失败。");
  return (await response.json()) as OpportunitiesResult;
}

export async function fetchResearchItems(): Promise<ResearchItemsResult> {
  const response = await fetch("/api/research-items", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "研究队列读取失败。");
  return (await response.json()) as ResearchItemsResult;
}

export async function addResearchItem(input: {
  entityType: "company" | "industry";
  entityId: string;
  title: string;
  subtitle?: string;
  source?: string;
  evidenceHash?: string;
  stage?: ResearchStage;
}): Promise<ResearchWorkbenchItem> {
  const response = await fetch("/api/research-items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error((await readError(response)) || "加入研究队列失败。");
  const data = (await response.json()) as { item?: ResearchWorkbenchItem };
  if (!data.item) throw new Error("加入研究队列失败。");
  return data.item;
}

export async function updateResearchItemStage(id: string, stage: ResearchStage, sortOrder?: number): Promise<ResearchWorkbenchItem> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ stage, sortOrder }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "研究阶段更新失败。");
  const data = (await response.json()) as { item?: ResearchWorkbenchItem };
  if (!data.item) throw new Error("研究阶段更新失败。");
  return data.item;
}

export async function reorderResearchItems(updates: Array<{ id: string; stage: string; sortOrder: number }>): Promise<void> {
  const response = await fetch("/api/research-items/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ updates }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "研究项排序失败。");
}

export async function deleteResearchItems(ids: string[]): Promise<void> {
  const response = await fetch("/api/research-items/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "研究项删除失败。");
}

export type ActivityEvent = {
  id: string;
  itemId: string;
  eventType: string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export async function fetchActivityEvents(itemId: string, limit = 20): Promise<ActivityEvent[]> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(itemId)}/activity?limit=${limit}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "活动事件读取失败。");
  const data = (await response.json()) as { events?: ActivityEvent[] };
  return data.events ?? [];
}

export async function fetchResearchTheses(id: string): Promise<ResearchThesesResult> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}/thesis`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "研究论点读取失败。");
  return (await response.json()) as ResearchThesesResult;
}

export async function refreshResearchThesis(id: string, signal?: AbortSignal): Promise<{ thesis: ResearchThesisVersion; item: ResearchWorkbenchItem }> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}/thesis`, {
    method: "POST",
    credentials: "include",
    signal,
  });
  if (!response.ok) throw new Error((await readError(response)) || "研究论点生成失败。");
  const data = (await response.json()) as { thesis?: ResearchThesisVersion; item?: ResearchWorkbenchItem };
  if (!data.thesis || !data.item) throw new Error("研究论点生成失败。");
  return { thesis: data.thesis, item: data.item };
}

export async function fetchResearchCatalysts(id: string): Promise<ResearchCatalystsResult> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}/catalysts`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "研究跟踪项读取失败。");
  return (await response.json()) as ResearchCatalystsResult;
}

export async function syncResearchCatalystsFromThesis(id: string): Promise<ResearchCatalystsResult & { created?: number }> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}/catalysts`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw new Error((await readError(response)) || "研究跟踪项同步失败。");
  return (await response.json()) as ResearchCatalystsResult & { created?: number };
}

export async function updateResearchCatalystStatus(id: string, catalystId: string, status: ResearchCatalystStatus): Promise<ResearchCatalyst> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}/catalysts`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ catalystId, status }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "研究跟踪项状态更新失败。");
  const data = (await response.json()) as { catalyst?: ResearchCatalyst };
  if (!data.catalyst) throw new Error("研究跟踪项状态更新失败。");
  return data.catalyst;
}

export async function fetchValuations(): Promise<ValuationsResult> {
  const response = await fetch("/api/valuations", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "估值历史读取失败。");
  return (await response.json()) as ValuationsResult;
}

export async function createValuationRun(input: {
  researchItemId?: string;
  entityType: "company" | "industry";
  entityId: string;
  title: string;
  industry?: string;
  sector?: string;
  mainBusiness?: string;
  currency?: string;
  evidenceHash?: string;
}): Promise<ValuationRunSummary> {
  const response = await fetch("/api/valuations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok && response.status !== 202) throw new Error((await readError(response)) || "估值任务创建失败。");
  const data = (await response.json()) as { run?: ValuationRunSummary };
  if (!data.run) throw new Error("估值任务创建失败。");
  return data.run;
}

export async function fetchQuantitativeValuationWorkspace(runId: string): Promise<QuantitativeValuationWorkspace> {
  const response = await fetch(`/api/valuation-workspace?runId=${encodeURIComponent(runId)}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "估值工作区读取失败。");
  const data = await response.json() as { workspace?: QuantitativeValuationWorkspace };
  if (!data.workspace) throw new Error("估值工作区读取失败。");
  return data.workspace;
}

export async function saveQuantitativeValuationWorkspace(input: {
  runId: string;
  parentVersionId: string;
  assumptions: EditableAssumption[];
}): Promise<{ workspace: QuantitativeValuationWorkspace; version: QuantitativeValuationVersion }> {
  const response = await fetch("/api/valuation-workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error((await readError(response)) || "估值保存失败。");
  const data = await response.json() as { workspace?: QuantitativeValuationWorkspace; version?: QuantitativeValuationVersion };
  if (!data.workspace || !data.version) throw new Error("估值保存失败。");
  return { workspace: data.workspace, version: data.version };
}

export async function fetchRadarScan(): Promise<RadarScanResult> {
  const response = await fetch("/api/radar-scan", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "雷达扫描读取失败。");
  const data = (await response.json()) as { radar?: RadarScan | null; job?: RadarAnalysisJob | null; warning?: string; diagnostics?: RadarDiagnostics | null };
  return { radar: data.radar ?? null, job: data.job ?? null, warning: data.warning, diagnostics: data.diagnostics ?? null };
}

export async function refreshRadarScan(): Promise<RadarScanResult> {
  const response = await fetch("/api/radar-scan", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw new Error((await readError(response)) || "雷达扫描刷新失败。");
  const data = (await response.json()) as { radar?: RadarScan | null; job?: RadarAnalysisJob | null; warning?: string; diagnostics?: RadarDiagnostics | null };
  const radar = data.warning && data.radar ? { ...data.radar, refreshWarning: data.warning } : data.radar ?? null;
  return { radar, job: data.job ?? null, warning: data.warning, diagnostics: data.diagnostics ?? null };
}

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
  options: {
    limit?: number;
    offset?: number;
    sort?: string;
    direction?: string;
    industry?: string;
    market?: string;
    seedCodes?: string[];
    tickers?: string[];
    signal?: AbortSignal;
  } = {},
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
  const response = await fetch(`/api/report-library?${params.toString()}`, { credentials: "include", signal: options.signal });
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

export async function fetchWatchlistRanking(): Promise<{ entries: WatchlistRankingEntry[]; watchlist: WatchlistItem[] }> {
  const response = await fetch("/api/watchlist-ranking", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "自选股排行读取失败。");
  const data = (await response.json()) as { entries?: WatchlistRankingEntry[]; watchlist?: WatchlistItem[] };
  return { entries: data.entries ?? [], watchlist: data.watchlist ?? [] };
}

export async function refreshWatchlistRanking(input: { watchlistId?: string; forceRefresh?: boolean; limit?: number } = {}): Promise<{ entries: WatchlistRankingEntry[]; queued: string[]; reused: string[] }> {
  const response = await fetch("/api/watchlist-ranking", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok && response.status !== 202) throw new Error((await readError(response)) || "自选股排行刷新失败。");
  const data = (await response.json()) as { entries?: WatchlistRankingEntry[]; queued?: string[]; reused?: string[] };
  return { entries: data.entries ?? [], queued: data.queued ?? [], reused: data.reused ?? [] };
}

export async function fetchTemplateAnalyses(watchlistId?: string): Promise<{ analyses: TemplateAnalysisResult[]; templates: ResearchTemplate[] }> {
  const params = new URLSearchParams();
  if (watchlistId) params.set("watchlistId", watchlistId);
  const response = await fetch(`/api/template-analysis${params.size ? `?${params.toString()}` : ""}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "模板分析读取失败。");
  const data = (await response.json()) as { analyses?: TemplateAnalysisResult[]; templates?: ResearchTemplate[] };
  return { analyses: data.analyses ?? [], templates: data.templates ?? [] };
}

export async function fetchResearchTemplates(): Promise<ResearchTemplate[]> {
  const response = await fetch("/api/research-templates", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "模板读取失败。");
  const data = (await response.json()) as { templates?: ResearchTemplate[] };
  return data.templates ?? [];
}

export async function saveResearchTemplates(templates: ResearchTemplate[]): Promise<ResearchTemplate[]> {
  const response = await fetch("/api/research-templates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ templates }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "模板保存失败。");
  const data = (await response.json()) as { templates?: ResearchTemplate[] };
  return data.templates ?? [];
}

export async function saveResearchTemplatesAsDefault(): Promise<ResearchTemplate[]> {
  const response = await fetch("/api/research-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "save-defaults" }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "默认模板保存失败。");
  const data = (await response.json()) as { templates?: ResearchTemplate[] };
  return data.templates ?? [];
}

export async function resetResearchTemplatesToDefault(): Promise<ResearchTemplate[]> {
  const response = await fetch("/api/research-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "reset-defaults" }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "模板重置失败。");
  const data = (await response.json()) as { templates?: ResearchTemplate[] };
  return data.templates ?? [];
}

export async function completeResearchTemplateDraft(draft: ResearchTemplateCompletion): Promise<ResearchTemplateCompletion> {
  const response = await fetch("/api/research-template-completion", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ draft }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "模板 AI 补全失败。");
  const data = (await response.json()) as { completion?: ResearchTemplateCompletion };
  if (!data.completion) throw new Error("模板 AI 补全失败。");
  return data.completion;
}

export async function fetchAssistantThread(threadId?: string): Promise<AssistantThread> {
  const url = threadId ? `/api/assistant/thread?threadId=${encodeURIComponent(threadId)}` : "/api/assistant/thread";
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "助手线程读取失败。");
  const data = (await response.json()) as { thread?: AssistantThread };
  if (!data.thread) throw new Error("助手线程读取失败。");
  return data.thread;
}

export async function listAssistantThreads(): Promise<Array<{ id: string; title: string; updatedAt: string }>> {
  const response = await fetch("/api/assistant/threads", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "线程列表读取失败。");
  const data = (await response.json()) as { threads: Array<{ id: string; title: string; updatedAt: string }> };
  return data.threads;
}

export async function createAssistantThread(title?: string): Promise<{ id: string; title: string }> {
  const response = await fetch("/api/assistant/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "线程创建失败。");
  const data = (await response.json()) as { thread: { id: string; title: string } };
  return data.thread;
}

export async function deleteAssistantThread(threadId: string): Promise<void> {
  const response = await fetch(`/api/assistant/threads?threadId=${encodeURIComponent(threadId)}`, { method: "DELETE", credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "线程删除失败。");
}

export async function renameAssistantThread(threadId: string, title: string): Promise<void> {
  const response = await fetch(`/api/assistant/threads?threadId=${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "线程重命名失败。");
}

export async function sendAssistantMessage(
  message: string,
  modeOrEvent?: AssistantMode | ((event: AssistantChatStreamEvent) => void),
  onEventArg?: (event: AssistantChatStreamEvent) => void,
  threadId?: string,
  signal?: AbortSignal,
): Promise<AssistantMessage | null> {
  const mode = typeof modeOrEvent === "string" ? modeOrEvent : "chat";
  const onEvent = typeof modeOrEvent === "function" ? modeOrEvent : onEventArg;
  const response = await fetch("/api/assistant/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ message, mode, threadId }),
    signal,
  });
  if (!response.ok) throw new Error((await readError(response)) || "助手生成失败。");
  let finalMessage: AssistantMessage | undefined;
  let requestedClarification = false;
  for await (const event of readSse(response)) {
    const typed = event as AssistantChatStreamEvent;
    onEvent?.(typed);
    if (typed.type === "error") throw new Error(typed.error);
    if (typed.type === "choice_request") requestedClarification = true;
    if (typed.type === "done") finalMessage = typed.message;
  }
  if (requestedClarification) return null;
  if (!finalMessage) throw assistantIncompleteResponseError();
  return finalMessage;
}

export async function fetchAssistantDeepResearchJob(id: string): Promise<AssistantDeepResearchJob> {
  const response = await fetch(`/api/assistant/deep-research/${encodeURIComponent(id)}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error((await readError(response)) || "深度研究状态读取失败。");
  const data = (await response.json()) as { job?: AssistantDeepResearchJob };
  if (!data.job) throw new Error("深度研究状态读取失败。");
  return data.job;
}

export async function stopAssistantDeepResearchJob(id: string): Promise<AssistantDeepResearchJob> {
  const response = await fetch(`/api/assistant/deep-research/${encodeURIComponent(id)}/stop`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "深度研究停止失败。");
  const data = (await response.json()) as { job?: AssistantDeepResearchJob };
  if (!data.job) throw new Error("深度研究停止失败。");
  return data.job;
}

export async function confirmAssistantMemoryCandidate(id: string): Promise<void> {
  const response = await fetch(`/api/assistant/memory-candidates/${encodeURIComponent(id)}/confirm`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "记忆确认失败。");
}

export async function rejectAssistantMemoryCandidate(id: string): Promise<void> {
  const response = await fetch(`/api/assistant/memory-candidates/${encodeURIComponent(id)}/reject`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "记忆忽略失败。");
}

export async function disableAssistantMemory(id: string): Promise<void> {
  const response = await fetch(`/api/assistant/memories/${encodeURIComponent(id)}/disable`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "记忆停用失败。");
}

export async function deleteAssistantMemory(id: string): Promise<void> {
  const response = await fetch(`/api/assistant/memories/${encodeURIComponent(id)}/delete`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "记忆删除失败。");
}

export async function sendCodeResult(id: string, output: string, error?: string): Promise<void> {
  const response = await fetch(`/api/assistant/code-result/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ output, error }),
  });
  if (!response.ok) throw new Error("代码结果回传失败。");
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

async function* readSse(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw assistantConnectionInterruptedError(error);
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const parsed = parseSseEvent(event);
      if (parsed) yield parsed;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseEvent(buffer);
    if (parsed) yield parsed;
  }
}

function parseSseEvent(event: string) {
  const lines = event.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      const data = line.slice(5);
      if (data.trim()) dataLines.push(data);
    }
  }
  if (!dataLines.length) return null;
  try {
    return JSON.parse(dataLines.join("\n").trim()) as Record<string, unknown>;
  } catch (error) {
    throw assistantIncompleteResponseError(error);
  }
}

function assistantConnectionInterruptedError(cause?: unknown) {
  return new Error("助手连接中断，已保留当前已显示内容，请重试。", { cause });
}

function assistantIncompleteResponseError(cause?: unknown) {
  return new Error("助手响应不完整，请重试。", { cause });
}

function reportConnectionError(cause?: unknown) {
  return new Error("报告连接中断，后台会继续生成；稍后再次点击生成会自动复用共享缓存。", { cause });
}

function reportCancelledError(cause?: unknown) {
  return new Error(REPORT_CANCELLED_MESSAGE, { cause });
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
