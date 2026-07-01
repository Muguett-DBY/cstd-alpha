import { normalizeChartBundle, type ChartBundle, type PriceMode } from "./shared/chart";
import type { CompanyNewsBundle } from "./shared/news";
import type { RadarAnalysisJob, RadarAnalysisScope, RadarCitation, RadarCoverageItem, RadarCoverageReview, RadarDiagnostics, RadarEvidenceBreakdown, RadarEvidenceFreshness, RadarIndustryPacket, RadarItem, RadarList, RadarScan } from "./shared/radar";
import { isReportLibraryEntry, type ReportLibraryEntry } from "./shared/report-library";
import { validateReportPayload, type CompanyCandidate, type InvestmentReport, type ReportGenerationMetrics, type ReportTokenUsage } from "./shared/report";
import type { AssistantBlock, AssistantChatStreamEvent, AssistantDeepResearchJob, AssistantMemoryCandidate, AssistantMessage, AssistantMode, AssistantThread } from "./shared/assistant";
import { RESEARCH_CATALYST_STATUSES, RESEARCH_STAGES, type ResearchCatalyst, type ResearchCatalystStatus, type ResearchItemUpsertResult, type ResearchItemUpsertStatus, type ResearchOpportunitySignal, type ResearchStage, type ResearchThesisVersion, type ResearchWorkbenchItem } from "./shared/research-workbench";
import type { ValuationRunSummary } from "./shared/valuation";
import type { EditableAssumption, QuantitativeDraft, QuantitativePreset, QuantitativeValuationVersion, QuantitativeValuationWorkspace } from "./shared/quantitative-valuation";
import {
  isResearchTemplate,
  isResearchTemplateCompletion,
  isTemplateAnalysisResult,
  type ResearchTemplate,
  type ResearchTemplateCompletion,
  type TemplateAnalysisResult,
  type UserSession,
  type WatchlistAddResult,
  type WatchlistItem,
  type WatchlistRankingEntry,
} from "./shared/user-research";

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

export type { ResearchTemplateCompletion } from "./shared/user-research";

export type TemplateAnalysesResult = {
  analyses: TemplateAnalysisResult[];
  templates: ResearchTemplate[];
  skippedAnalyses?: number;
  skippedTemplates?: number;
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
  skippedEntries?: number;
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
  skippedSignals?: number;
  skippedFunnelItems?: number;
  skippedInboxItems?: number;
  skippedResearchItems?: number;
};

export type ResearchItemsResult = {
  items: ResearchWorkbenchItem[];
  skippedItems?: number;
  totalItems?: number;
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

const VALUATION_METHOD_VALUES = ["dcf_3_statement", "ddm_residual_income", "mid_cycle_nav"] as const;
const COMPANY_ARCHETYPE_VALUES = ["operating", "bank", "insurance", "cyclical"] as const;
const VALUATION_RUN_STATUS_VALUES = ["queued", "running", "completed", "failed"] as const;
const VALUATION_SCENARIO_VALUES = ["bear", "base", "bull"] as const;
const WATCHLIST_RANKING_STATUS_VALUES = ["pending", "running", "completed", "failed_retryable", "failed"] as const;
const USER_SESSION_ROLE_VALUES = ["admin", "user"] as const;
const RADAR_JOB_STATUS_VALUES = ["queued", "running", "completed", "failed"] as const;
const RADAR_EVIDENCE_TYPE_VALUES = ["hard_data", "official", "announcement", "market", "news", "research"] as const;
const RADAR_CONCLUSION_STRENGTH_VALUES = ["正式结论", "观察", "证据不足"] as const;
const RADAR_EVIDENCE_GAP_VALUES = ["缺财报", "缺价格", "缺销量", "缺订单", "缺库存", "缺产能", "缺现金流", "缺政策细则", "缺公司公告", "缺多源验证"] as const;
const RADAR_DRIVER_TAG_VALUES = ["需求", "价格", "技术", "政策", "市占率", "供给收缩"] as const;
const RADAR_SUSTAINABILITY_TIER_VALUES = ["短期催化", "中期景气", "长期护城河"] as const;
const RADAR_DURABILITY_VALUES = ["短期", "中期", "长期", "不确定"] as const;
const RADAR_RISK_LEVEL_VALUES = ["低", "中", "高"] as const;
const RADAR_CONFIDENCE_VALUES = ["低", "中", "高"] as const;
const RADAR_COVERAGE_STATUS_VALUES = ["formal", "watched", "insufficient"] as const;
const RADAR_INDUSTRY_STAGE_VALUES = ["扎实增长", "即将增长", "泡沫风险", "衰退", "平稳现金流", "继续观察", "证据不足"] as const;
const RADAR_CHANGE_STATUS_VALUES = ["new", "changed", "unchanged"] as const;
const RADAR_CONCLUSION_ELIGIBILITY_VALUES = ["eligible", "watch", "insufficient"] as const;
const ASSISTANT_ROLE_VALUES = ["user", "assistant", "system"] as const;
const ASSISTANT_MODE_VALUES = ["chat", "target", "industry"] as const;
const ASSISTANT_REASONING_EFFORT_VALUES = ["high", "max"] as const;
const ASSISTANT_TOOL_RUN_STATUS_VALUES = ["completed", "failed", "skipped"] as const;
const ASSISTANT_BLOCK_TYPE_VALUES = ["text", "table", "chart"] as const;
const ASSISTANT_CHART_TYPE_VALUES = ["bar", "line", "scatter", "pie", "area"] as const;
const ASSISTANT_MEMORY_STATUS_VALUES = ["active", "disabled"] as const;
const ASSISTANT_MEMORY_CANDIDATE_STATUS_VALUES = ["pending", "confirmed", "rejected"] as const;
const ASSISTANT_DEEP_RESEARCH_KIND_VALUES = ["forecast", "selection", "comparison", "industry", "contrarian", "risk"] as const;
const ASSISTANT_DEEP_RESEARCH_STATUS_VALUES = ["queued", "running", "stopping", "completed", "failed"] as const;
const ASSISTANT_STREAM_TOOL_STATUS_VALUES = ["running", "completed", "failed"] as const;
const ASSISTANT_STREAM_TOOL_RESULT_STATUS_VALUES = ["completed", "failed"] as const;
const OPPORTUNITY_SOURCE_VALUES = ["radar", "watchlist", "hybrid"] as const;

type AssistantThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export async function fetchOpportunities(): Promise<OpportunitiesResult> {
  const response = await fetch("/api/opportunities", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "今日机会读取失败。");
  return normalizeOpportunitiesResult(await response.json());
}

function normalizeOpportunitiesResult(payload: unknown): OpportunitiesResult {
  const data = objectPayload(payload);
  const rawOpportunities = arrayPayload<unknown>(data.opportunities);
  const rawTopResearch = arrayPayload<unknown>(data.topResearch);
  const rawRiskWorsening = arrayPayload<unknown>(data.riskWorsening);
  const rawCatalysts = arrayPayload<unknown>(data.catalysts);
  const rawFunnel = arrayPayload<unknown>(data.funnel);
  const rawInbox = arrayPayload<unknown>(data.inbox);
  const rawResearchItems = arrayPayload<unknown>(data.researchItems);
  const opportunities = rawOpportunities.filter(isResearchOpportunitySignal);
  const topResearch = rawTopResearch.filter(isResearchOpportunitySignal);
  const riskWorsening = rawRiskWorsening.filter(isResearchOpportunitySignal);
  const catalysts = rawCatalysts.filter(isResearchOpportunitySignal);
  const funnel = rawFunnel.filter(isOpportunityFunnelItem);
  const inbox = rawInbox.filter(isOpportunityInboxItem);
  const researchItems = rawResearchItems.filter(isResearchWorkbenchItem);
  const skippedSignals = rawOpportunities.length - opportunities.length
    + rawTopResearch.length - topResearch.length
    + rawRiskWorsening.length - riskWorsening.length
    + rawCatalysts.length - catalysts.length;
  const skippedFunnelItems = rawFunnel.length - funnel.length;
  const skippedInboxItems = rawInbox.length - inbox.length;
  const skippedResearchItems = rawResearchItems.length - researchItems.length;
  return {
    generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : "",
    opportunities,
    topResearch,
    riskWorsening,
    catalysts,
    funnel,
    inbox,
    researchItems,
    ...(skippedSignals > 0 ? { skippedSignals } : {}),
    ...(skippedFunnelItems > 0 ? { skippedFunnelItems } : {}),
    ...(skippedInboxItems > 0 ? { skippedInboxItems } : {}),
    ...(skippedResearchItems > 0 ? { skippedResearchItems } : {}),
  };
}

export function describeOpportunitiesDataHealth(result: Pick<OpportunitiesResult, "skippedSignals" | "skippedFunnelItems" | "skippedInboxItems" | "skippedResearchItems">) {
  const skippedSignals = result.skippedSignals ?? 0;
  const skippedFunnelItems = result.skippedFunnelItems ?? 0;
  const skippedInboxItems = result.skippedInboxItems ?? 0;
  const skippedResearchItems = result.skippedResearchItems ?? 0;
  const total = skippedSignals + skippedFunnelItems + skippedInboxItems + skippedResearchItems;
  if (total <= 0) return "";
  const parts = [
    skippedSignals > 0 ? `机会信号 ${skippedSignals}` : "",
    skippedFunnelItems > 0 ? `研究漏斗 ${skippedFunnelItems}` : "",
    skippedInboxItems > 0 ? `收件箱 ${skippedInboxItems}` : "",
    skippedResearchItems > 0 ? `研究项 ${skippedResearchItems}` : "",
  ].filter(Boolean);
  return `今日机会已跳过 ${total} 条异常记录：${parts.join("、")}。有效机会和研究数据已保留，可以重新读取。`;
}

export async function fetchResearchItems(): Promise<ResearchItemsResult> {
  const response = await fetch("/api/research-items", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "研究队列读取失败。");
  return normalizeResearchItemsResult(await response.json());
}

export async function addResearchItem(input: {
  entityType: "company" | "industry";
  entityId: string;
  title: string;
  subtitle?: string;
  source?: string;
  evidenceHash?: string;
  stage?: ResearchStage;
}): Promise<ResearchItemUpsertResult> {
  const response = await fetch("/api/research-items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error((await readError(response)) || "加入研究队列失败。");
  const data = (await response.json()) as { item?: unknown; status?: ResearchItemUpsertStatus };
  if (!isResearchWorkbenchItem(data.item)) throw new Error("加入研究队列失败。");
  return { item: data.item, status: data.status === "updated" ? "updated" : "created" };
}

export async function updateResearchItemStage(id: string, stage: ResearchStage, sortOrder?: number): Promise<ResearchWorkbenchItem> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ stage, sortOrder }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "研究阶段更新失败。");
  const data = objectPayload(await response.json());
  if (!isResearchWorkbenchItem(data.item)) throw new Error("研究阶段更新失败。");
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
  const data = objectPayload(await response.json());
  return arrayPayload<unknown>(data.events).filter(isActivityEvent);
}

export async function fetchResearchTheses(id: string): Promise<ResearchThesesResult> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}/thesis`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "研究论点读取失败。");
  return normalizeResearchThesesResult(await response.json());
}

export async function refreshResearchThesis(id: string, signal?: AbortSignal): Promise<{ thesis: ResearchThesisVersion; item: ResearchWorkbenchItem }> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}/thesis`, {
    method: "POST",
    credentials: "include",
    signal,
  });
  if (!response.ok) throw new Error((await readError(response)) || "研究论点生成失败。");
  const data = objectPayload(await response.json());
  if (!isResearchThesisVersion(data.thesis) || !isResearchWorkbenchItem(data.item)) throw new Error("研究论点生成失败。");
  return { thesis: data.thesis, item: data.item };
}

export async function fetchResearchCatalysts(id: string): Promise<ResearchCatalystsResult> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}/catalysts`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "研究跟踪项读取失败。");
  return normalizeResearchCatalystsResult(await response.json());
}

export async function syncResearchCatalystsFromThesis(id: string): Promise<ResearchCatalystsResult & { created?: number }> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}/catalysts`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw new Error((await readError(response)) || "研究跟踪项同步失败。");
  return normalizeResearchCatalystsResult(await response.json());
}

export async function updateResearchCatalystStatus(id: string, catalystId: string, status: ResearchCatalystStatus): Promise<ResearchCatalyst> {
  const response = await fetch(`/api/research-items/${encodeURIComponent(id)}/catalysts`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ catalystId, status }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "研究跟踪项状态更新失败。");
  const data = objectPayload(await response.json());
  if (!isResearchCatalyst(data.catalyst)) throw new Error("研究跟踪项状态更新失败。");
  return data.catalyst;
}

export async function fetchValuations(): Promise<ValuationsResult> {
  const response = await fetch("/api/valuations", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "估值历史读取失败。");
  return normalizeValuationsResult(await response.json());
}

function normalizeResearchItemsResult(payload: unknown): ResearchItemsResult {
  const data = objectPayload(payload) as Partial<ResearchItemsResult>;
  const rawItems = arrayPayload<unknown>(data.items);
  const items = rawItems.filter(isResearchWorkbenchItem);
  const skippedItems = rawItems.length - items.length;
  return {
    items,
    ...(skippedItems > 0 ? { skippedItems, totalItems: rawItems.length } : {}),
  };
}

function normalizeResearchThesesResult(payload: unknown): ResearchThesesResult {
  const data = objectPayload(payload) as Partial<ResearchThesesResult>;
  const current = isResearchThesisVersion(data.current) ? data.current : null;
  return {
    current,
    versions: arrayPayload<unknown>(data.versions).filter(isResearchThesisVersion),
  };
}

function normalizeResearchCatalystsResult(payload: unknown): ResearchCatalystsResult & { created?: number } {
  const data = objectPayload(payload) as Partial<ResearchCatalystsResult & { created?: number }>;
  return {
    catalysts: arrayPayload<unknown>(data.catalysts).filter(isResearchCatalyst),
    ...(Number.isFinite(data.created) ? { created: data.created } : {}),
  };
}

function normalizeValuationsResult(payload: unknown): ValuationsResult {
  const data = objectPayload(payload) as Partial<ValuationsResult>;
  return { runs: arrayPayload<unknown>(data.runs).filter(isValuationRunSummary) };
}

function normalizeRadarScanResult(payload: unknown): RadarScanResult {
  const data = objectPayload(payload);
  return {
    radar: normalizeRadarScan(data.radar),
    job: isRadarAnalysisJob(data.job) ? data.job : null,
    warning: typeof data.warning === "string" ? data.warning : undefined,
    diagnostics: isRadarDiagnostics(data.diagnostics) ? data.diagnostics : null,
  };
}

function normalizeRadarScan(value: unknown): RadarScan | null {
  if (!isPlainRecord(value)) return null;
  const sourceCount = finiteNumber(value.sourceCount);
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.generatedAt !== "string" ||
    typeof value.asOfDate !== "string" ||
    typeof value.validUntil !== "string" ||
    typeof value.model !== "string" ||
    sourceCount === undefined ||
    !isStringArray(value.sourceQueries) ||
    !isStringArray(value.executiveSummary) ||
    !Array.isArray(value.solidGrowth) ||
    !Array.isArray(value.sustainability) ||
    !Array.isArray(value.bubbleRisks) ||
    !Array.isArray(value.upcomingGrowth) ||
    !Array.isArray(value.decliningIndustries) ||
    !Array.isArray(value.representativeCompanies) ||
    !Array.isArray(value.stageCompanies) ||
    !isStringArray(value.limitations)
  ) {
    return null;
  }

  const scan: RadarScan = {
    id: value.id,
    title: value.title,
    generatedAt: value.generatedAt,
    asOfDate: value.asOfDate,
    validUntil: value.validUntil,
    model: value.model,
    sourceCount,
    sourceQueries: value.sourceQueries,
    executiveSummary: value.executiveSummary,
    solidGrowth: value.solidGrowth.filter(isRadarItem),
    sustainability: value.sustainability.filter(isRadarItem),
    bubbleRisks: value.bubbleRisks.filter(isRadarItem),
    upcomingGrowth: value.upcomingGrowth.filter(isRadarItem),
    decliningIndustries: value.decliningIndustries.filter(isRadarItem),
    representativeCompanies: value.representativeCompanies.filter(isRadarList),
    stageCompanies: value.stageCompanies.filter(isRadarList),
    limitations: value.limitations,
  };

  const evidenceBreakdown = normalizeRadarEvidenceBreakdown(value.evidenceBreakdown);
  if (evidenceBreakdown) scan.evidenceBreakdown = evidenceBreakdown;
  if (isRadarEvidenceFreshness(value.evidenceFreshness)) scan.evidenceFreshness = value.evidenceFreshness;
  if (isRadarDiagnostics(value.diagnostics)) scan.diagnostics = value.diagnostics;
  if (Array.isArray(value.evidenceSources)) scan.evidenceSources = value.evidenceSources.filter(isRadarCitation);
  if (Array.isArray(value.softCoverage)) scan.softCoverage = value.softCoverage.filter(isRadarCoverageItem);
  if (Array.isArray(value.coverageReview)) scan.coverageReview = value.coverageReview.filter(isRadarCoverageReview);
  if (Array.isArray(value.industryPackets)) scan.industryPackets = value.industryPackets.filter(isRadarIndustryPacket);
  if (isRadarAnalysisScope(value.analysisScope)) scan.analysisScope = value.analysisScope;
  if (typeof value.confidenceSummary === "string") scan.confidenceSummary = value.confidenceSummary;
  if (isStringArray(value.changeLog)) scan.changeLog = value.changeLog;
  if (typeof value.fromCache === "boolean") scan.fromCache = value.fromCache;
  if (typeof value.reuseReason === "string") scan.reuseReason = value.reuseReason;
  if (typeof value.refreshWarning === "string") scan.refreshWarning = value.refreshWarning;
  return scan;
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
  const data = objectPayload(await response.json());
  if (!isValuationRunSummary(data.run)) throw new Error("估值任务创建失败。");
  return data.run;
}

export async function fetchQuantitativeValuationWorkspace(runId: string): Promise<QuantitativeValuationWorkspace> {
  const response = await fetch(`/api/valuation-workspace?runId=${encodeURIComponent(runId)}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "估值工作区读取失败。");
  const data = objectPayload(await response.json());
  if (!isQuantitativeValuationWorkspace(data.workspace)) throw new Error("估值工作区读取失败。");
  return data.workspace;
}

export async function saveQuantitativeValuationWorkspace(input: {
  runId: string;
  parentVersionId: string;
  assumptions: EditableAssumption[];
  decisionNote?: string;
  presets?: QuantitativePreset[];
  restoredPresetLibrary?: QuantitativeDraft["restoredPresetLibrary"];
}): Promise<{ workspace: QuantitativeValuationWorkspace; version: QuantitativeValuationVersion }> {
  const response = await fetch("/api/valuation-workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error((await readError(response)) || "估值保存失败。");
  const data = objectPayload(await response.json());
  if (!isQuantitativeValuationWorkspace(data.workspace) || !isQuantitativeValuationVersion(data.version)) throw new Error("估值保存失败。");
  return { workspace: data.workspace, version: data.version };
}

export async function fetchRadarScan(): Promise<RadarScanResult> {
  const response = await fetch("/api/radar-scan", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "雷达扫描读取失败。");
  return normalizeRadarScanResult(await response.json());
}

export async function refreshRadarScan(): Promise<RadarScanResult> {
  const response = await fetch("/api/radar-scan", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw new Error((await readError(response)) || "雷达扫描刷新失败。");
  const result = normalizeRadarScanResult(await response.json());
  const radar = result.warning && result.radar ? { ...result.radar, refreshWarning: result.warning } : result.radar;
  return { ...result, radar };
}

export async function checkSession(): Promise<UserSession | null> {
  const response = await fetch("/api/session", { credentials: "include" });
  if (!response.ok) return null;
  const data = objectPayload(await response.json());
  if (data.user === undefined || data.user === null) return null;
  if (!isUserSession(data.user)) throw new Error("登录状态读取失败，请重新登录。");
  return data.user;
}

export async function login(password: string, username?: string): Promise<UserSession | null> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ password, username }),
  });

  if (!response.ok) throw new Error((await readError(response)) || "登录失败。");
  const data = objectPayload(await response.json());
  if (!isUserSession(data.user)) throw new Error("登录失败：服务端未返回账号信息。");
  return data.user;
}

export async function logout(): Promise<void> {
  await fetch("/api/session", { method: "DELETE", credentials: "include" });
}

export async function searchCompanies(query: string, signal?: AbortSignal): Promise<CompanyCandidate[]> {
  const response = await fetch(`/api/company-search?q=${encodeURIComponent(query)}`, { credentials: "include", signal });
  if (!response.ok) throw new Error((await readError(response)) || "公司搜索失败。");
  const data = (await response.json()) as { candidates?: CompanyCandidate[] };
  return arrayPayload<unknown>(data.candidates).filter(isCompanyCandidate);
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
      if (event.type === "progress") {
        if (isReportProgress(event)) onProgress?.(event);
        continue;
      }
      if (event.type === "error") throw new Error(String(event.error || "报告生成失败。"));
      if (event.type === "final") {
        finalReport = validateReportPayload(event.report);
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

function isReportProgress(value: unknown): value is ReportProgress {
  if (!isPlainRecord(value) || value.type !== "progress") return false;
  const percent = finiteNumber(value.percent);
  return (
    typeof value.stage === "string" &&
    typeof value.label === "string" &&
    typeof value.detail === "string" &&
    percent !== undefined &&
    percent >= 0 &&
    percent <= 100 &&
    typeof value.at === "string" &&
    (value.startedAt === undefined || typeof value.startedAt === "string") &&
    optionalFiniteNumber(value.elapsedMs) &&
    optionalFiniteNumber(value.evidenceCount)
  );
}

export async function fetchChartData(input: FetchChartDataInput): Promise<ChartBundle> {
  const response = await fetch("/api/chart-data", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });

  if (!response.ok) throw new Error((await readError(response)) || "图表数据生成失败。");
  return normalizeChartDataResult(input, await response.json());
}

function normalizeChartDataResult(input: FetchChartDataInput, payload: unknown): ChartBundle {
  const data = objectPayload(payload) as Partial<ChartBundle>;
  return normalizeChartBundle({
    company: isPlainRecord(data.company)
      ? data.company
      : {
          name: input.company.name,
          ticker: input.company.code,
          market: input.company.listingPlace,
          industry: input.company.industry,
          sector: input.company.sector,
        },
    asOf: typeof data.asOf === "string" ? data.asOf : "",
    priceMode: data.priceMode === "raw" || data.priceMode === "adjusted" ? data.priceMode : input.priceMode,
    priceSeries: Array.isArray(data.priceSeries) ? data.priceSeries : [],
    drawdownSeries: Array.isArray(data.drawdownSeries) ? data.drawdownSeries : [],
    marketSnapshot: isPlainRecord(data.marketSnapshot) ? data.marketSnapshot : {},
    evidence: Array.isArray(data.evidence) ? data.evidence : [],
  });
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
  const data = objectPayload(await response.json());
  const rawEntries = arrayPayload<unknown>(data.entries);
  const entries = rawEntries.filter(isReportLibraryEntry);
  const skippedEntries = rawEntries.length - entries.length;
  return {
    entries,
    total: finiteNumber(data.total) ?? entries.length,
    limit: finiteNumber(data.limit),
    offset: finiteNumber(data.offset),
    matchedTickers: stringArrayPayload(data.matchedTickers),
    ...(skippedEntries ? { skippedEntries } : {}),
  };
}

export async function fetchReportLibraryRecord(id: string): Promise<ReportLibraryRecord> {
  const response = await fetch(`/api/report-library?id=${encodeURIComponent(id)}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "报告读取失败。");
  const data = objectPayload(await response.json());
  if (!isReportLibraryEntry(data.entry)) throw new Error("报告读取失败。");
  try {
    return { entry: data.entry, report: validateReportPayload(data.report) };
  } catch {
    throw new Error("报告读取失败。");
  }
}

export async function importReportLibraryReports(reports: InvestmentReport[]): Promise<ReportLibraryEntry[]> {
  const response = await fetch("/api/report-library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ reports }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "报告导入失败。");
  const data = objectPayload(await response.json());
  const rawImported = arrayPayload<unknown>(data.imported);
  const imported = rawImported.filter(isReportLibraryEntry);
  if (rawImported.length !== imported.length) throw new Error("报告导入失败。");
  return imported;
}

export async function fetchWatchlist(): Promise<{ items: WatchlistItem[]; user?: UserSession }> {
  const response = await fetch("/api/watchlist", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "自选股读取失败。");
  const data = objectPayload(await response.json());
  return { items: arrayPayload<unknown>(data.items).filter(isWatchlistItem), user: isUserSession(data.user) ? data.user : undefined };
}

export async function addWatchlistItem(input: { company: CompanyCandidate; reportLibraryId?: string }): Promise<WatchlistAddResult> {
  const response = await fetch("/api/watchlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error((await readError(response)) || "加入自选失败。");
  const data = objectPayload(await response.json());
  if (!isWatchlistItem(data.item)) throw new Error("加入自选失败。");
  return { item: data.item, status: data.status === "updated" ? "updated" : "created" };
}

export async function removeWatchlistItem(id: string) {
  const response = await fetch(`/api/watchlist?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "移除自选失败。");
}

export async function fetchWatchlistRanking(): Promise<{ entries: WatchlistRankingEntry[]; watchlist: WatchlistItem[] }> {
  const response = await fetch("/api/watchlist-ranking", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "自选股排行读取失败。");
  const data = objectPayload(await response.json());
  return { entries: arrayPayload<unknown>(data.entries).filter(isWatchlistRankingEntry), watchlist: arrayPayload<unknown>(data.watchlist).filter(isWatchlistItem) };
}

export async function refreshWatchlistRanking(input: { watchlistId?: string; forceRefresh?: boolean; limit?: number } = {}): Promise<{ entries: WatchlistRankingEntry[]; queued: string[]; reused: string[] }> {
  const response = await fetch("/api/watchlist-ranking", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok && response.status !== 202) throw new Error((await readError(response)) || "自选股排行刷新失败。");
  const data = objectPayload(await response.json());
  return { entries: arrayPayload<unknown>(data.entries).filter(isWatchlistRankingEntry), queued: stringArrayPayload(data.queued), reused: stringArrayPayload(data.reused) };
}

export async function fetchTemplateAnalyses(watchlistId?: string): Promise<TemplateAnalysesResult> {
  const params = new URLSearchParams();
  if (watchlistId) params.set("watchlistId", watchlistId);
  const response = await fetch(`/api/template-analysis${params.size ? `?${params.toString()}` : ""}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "模板分析读取失败。");
  return normalizeTemplateAnalysesResult(objectPayload(await response.json()));
}

export async function fetchResearchTemplates(): Promise<ResearchTemplate[]> {
  const response = await fetch("/api/research-templates", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "模板读取失败。");
  const data = objectPayload(await response.json());
  return filterResearchTemplates(data.templates);
}

export async function saveResearchTemplates(templates: ResearchTemplate[]): Promise<ResearchTemplate[]> {
  const response = await fetch("/api/research-templates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ templates }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "模板保存失败。");
  const data = objectPayload(await response.json());
  return filterResearchTemplates(data.templates);
}

export async function saveResearchTemplatesAsDefault(): Promise<ResearchTemplate[]> {
  const response = await fetch("/api/research-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "save-defaults" }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "默认模板保存失败。");
  const data = objectPayload(await response.json());
  return filterResearchTemplates(data.templates);
}

export async function resetResearchTemplatesToDefault(): Promise<ResearchTemplate[]> {
  const response = await fetch("/api/research-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "reset-defaults" }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "模板重置失败。");
  const data = objectPayload(await response.json());
  return filterResearchTemplates(data.templates);
}

export async function completeResearchTemplateDraft(draft: ResearchTemplateCompletion): Promise<ResearchTemplateCompletion> {
  const response = await fetch("/api/research-template-completion", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ draft }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "模板 AI 补全失败。");
  const data = objectPayload(await response.json());
  if (!isResearchTemplateCompletion(data.completion)) throw new Error("模板 AI 补全失败。");
  return data.completion;
}

export async function fetchAssistantThread(threadId?: string): Promise<AssistantThread> {
  const url = threadId ? `/api/assistant/thread?threadId=${encodeURIComponent(threadId)}` : "/api/assistant/thread";
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "助手线程读取失败。");
  const data = objectPayload(await response.json());
  if (!isAssistantThread(data.thread)) throw new Error("助手线程读取失败。");
  return data.thread;
}

export async function listAssistantThreads(): Promise<Array<{ id: string; title: string; updatedAt: string }>> {
  const response = await fetch("/api/assistant/threads", { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "线程列表读取失败。");
  const data = objectPayload(await response.json());
  if (!Array.isArray(data.threads)) throw new Error("线程列表读取失败。");
  return data.threads.filter(isAssistantThreadSummary);
}

export async function createAssistantThread(title?: string): Promise<{ id: string; title: string }> {
  const response = await fetch("/api/assistant/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error((await readError(response)) || "线程创建失败。");
  const data = objectPayload(await response.json());
  if (!isCreatedAssistantThread(data.thread)) throw new Error("线程创建失败。");
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
    const typed = parseAssistantChatStreamEvent(event);
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
  const data = objectPayload(await response.json());
  if (!isAssistantDeepResearchJob(data.job)) throw new Error("深度研究状态读取失败。");
  return data.job;
}

export async function stopAssistantDeepResearchJob(id: string): Promise<AssistantDeepResearchJob> {
  const response = await fetch(`/api/assistant/deep-research/${encodeURIComponent(id)}/stop`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "深度研究停止失败。");
  const data = objectPayload(await response.json());
  if (!isAssistantDeepResearchJob(data.job)) throw new Error("深度研究停止失败。");
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
  const data = objectPayload(await response.json());
  if (!isTemplateAnalysisResult(data.analysis)) throw new Error("模板报告读取失败。");
  return data.analysis;
}

export async function fetchCompanyNews(watchlistId: string): Promise<CompanyNewsBundle> {
  const response = await fetch(`/api/company-news?watchlistId=${encodeURIComponent(watchlistId)}&t=${Date.now()}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error((await readError(response)) || "新闻读取失败。");
  const data = await response.json();
  if (!isCompanyNewsBundle(data)) throw new Error("新闻读取失败。");
  return data;
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
      if (event.type === "progress" && isTemplateAnalysisProgress(event)) onProgress?.(event);
      if (event.type === "error") {
        const eventRecord = event as Record<string, unknown>;
        throw new Error(String(eventRecord.error || "模板分析生成失败。"));
      }
      if (event.type === "final") {
        finalResult = normalizeTemplateAnalysisGenerationResult(event);
      }
    }
    if (!finalResult?.analysis && !finalResult?.analyses) throw new Error("模板分析连接提前结束，请稍后重试。");
    return finalResult;
  }
  const data = normalizeTemplateAnalysisGenerationResult(objectPayload(await response.json()));
  if (!data.analysis && !data.analyses) throw new Error("模板分析生成失败。");
  return data;
}

function normalizeTemplateAnalysesResult(data: Record<string, unknown>): TemplateAnalysesResult {
  const analyses = filterTemplateAnalyses(data.analyses);
  const templates = filterResearchTemplates(data.templates);
  const skippedAnalyses = skippedArrayEntries(data.analyses, analyses.length);
  const skippedTemplates = skippedArrayEntries(data.templates, templates.length);
  return {
    analyses,
    templates,
    ...(skippedAnalyses ? { skippedAnalyses } : {}),
    ...(skippedTemplates ? { skippedTemplates } : {}),
  };
}

function normalizeTemplateAnalysisGenerationResult(data: Record<string, unknown>): { analysis?: TemplateAnalysisResult; analyses?: TemplateAnalysisResult[] } {
  const analysis = isTemplateAnalysisResult(data.analysis) ? data.analysis : undefined;
  const analyses = filterTemplateAnalyses(data.analyses);
  return {
    ...(analysis ? { analysis } : {}),
    ...(analyses.length ? { analyses } : {}),
  };
}

function filterTemplateAnalyses(value: unknown): TemplateAnalysisResult[] {
  return arrayPayload<unknown>(value).filter(isTemplateAnalysisResult);
}

function filterResearchTemplates(value: unknown): ResearchTemplate[] {
  return arrayPayload<unknown>(value).filter(isResearchTemplate);
}

function skippedArrayEntries(value: unknown, keptCount: number) {
  return Array.isArray(value) ? Math.max(0, value.length - keptCount) : 0;
}

function isTemplateAnalysisProgress(value: unknown): value is TemplateAnalysisProgress {
  if (!isPlainRecord(value)) return false;
  return (
    value.type === "progress" &&
    typeof value.stage === "string" &&
    typeof value.label === "string" &&
    typeof value.detail === "string" &&
    (value.at === undefined || typeof value.at === "string")
  );
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

function isAssistantThreadSummary(value: unknown): value is AssistantThreadSummary {
  if (!isPlainRecord(value)) return false;
  return typeof value.id === "string" && typeof value.title === "string" && typeof value.updatedAt === "string";
}

function isCreatedAssistantThread(value: unknown): value is Pick<AssistantThreadSummary, "id" | "title"> {
  if (!isPlainRecord(value)) return false;
  return typeof value.id === "string" && typeof value.title === "string";
}

function parseAssistantChatStreamEvent(value: Record<string, unknown>): AssistantChatStreamEvent {
  if (!isAssistantChatStreamEvent(value)) throw assistantIncompleteResponseError();
  return value;
}

function isAssistantChatStreamEvent(value: unknown): value is AssistantChatStreamEvent {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "start":
      return typeof value.threadId === "string" && typeof value.messageId === "string";
    case "agent_step":
      return typeof value.step === "string" && typeof value.title === "string" && (value.round === undefined || finiteNumber(value.round) !== undefined);
    case "tool_status":
      return typeof value.id === "string" && typeof value.label === "string" && isStringOneOf(value.status, ASSISTANT_STREAM_TOOL_STATUS_VALUES);
    case "tool_result":
      return (
        typeof value.id === "string" &&
        isStringOneOf(value.status, ASSISTANT_STREAM_TOOL_RESULT_STATUS_VALUES) &&
        typeof value.summary === "string" &&
        finiteNumber(value.evidenceCount) !== undefined
      );
    case "delta":
    case "replace":
      return typeof value.text === "string";
    case "block":
      return isAssistantBlock(value.block);
    case "choice_request":
      return isAssistantChoiceRequest(value.request);
    case "memory_candidate":
      return isAssistantMemoryCandidate(value.candidate);
    case "deep_research_job":
      return isAssistantDeepResearchJob(value.job);
    case "usage":
      return isAssistantUsage(value.usage);
    case "code_exec":
      return typeof value.id === "string" && typeof value.code === "string";
    case "code_result":
      return typeof value.id === "string" && typeof value.output === "string" && (value.error === undefined || typeof value.error === "string");
    case "done":
      return isAssistantMessage(value.message);
    case "error":
      return typeof value.error === "string";
    default:
      return false;
  }
}

function isAssistantThread(value: unknown): value is AssistantThread {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.messages) &&
    value.messages.every(isAssistantMessage) &&
    Array.isArray(value.memories) &&
    value.memories.every(isAssistantMemory) &&
    Array.isArray(value.memoryCandidates) &&
    value.memoryCandidates.every(isAssistantMemoryCandidate) &&
    (value.latestUsage === undefined || isAssistantUsage(value.latestUsage))
  );
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.threadId === "string" &&
    isStringOneOf(value.role, ASSISTANT_ROLE_VALUES) &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string" &&
    (value.metadata === undefined || isAssistantMessageMetadata(value.metadata))
  );
}

function isAssistantMessageMetadata(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    (value.evidenceRefs === undefined || (Array.isArray(value.evidenceRefs) && value.evidenceRefs.every(isAssistantEvidenceRef))) &&
    (value.usage === undefined || isAssistantUsage(value.usage)) &&
    (value.toolRuns === undefined || (Array.isArray(value.toolRuns) && value.toolRuns.every(isAssistantToolRun))) &&
    (value.blocks === undefined || (Array.isArray(value.blocks) && value.blocks.every(isAssistantBlock))) &&
    (value.deepResearchJob === undefined || isAssistantDeepResearchJob(value.deepResearchJob))
  );
}

function isAssistantEvidenceRef(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.sourceType === "string" &&
    (value.url === undefined || typeof value.url === "string") &&
    (value.excerpt === undefined || typeof value.excerpt === "string")
  );
}

function isAssistantUsage(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.model === "string" &&
    isStringOneOf(value.reasoningEffort, ASSISTANT_REASONING_EFFORT_VALUES) &&
    optionalFiniteNumber(value.promptTokens) &&
    optionalFiniteNumber(value.completionTokens) &&
    optionalFiniteNumber(value.totalTokens) &&
    optionalFiniteNumber(value.promptCacheHitTokens) &&
    optionalFiniteNumber(value.promptCacheMissTokens) &&
    optionalFiniteNumber(value.elapsedMs)
  );
}

function isAssistantToolRun(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.toolName === "string" &&
    isStringOneOf(value.status, ASSISTANT_TOOL_RUN_STATUS_VALUES) &&
    typeof value.summary === "string" &&
    typeof value.createdAt === "string"
  );
}

function isAssistantBlock(value: unknown): value is AssistantBlock {
  if (!isPlainRecord(value) || !isStringOneOf(value.type, ASSISTANT_BLOCK_TYPE_VALUES)) return false;
  if (typeof value.id !== "string" || (value.title !== undefined && typeof value.title !== "string")) return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "table") {
    return isStringArray(value.columns) && Array.isArray(value.rows) && value.rows.every(isStringArray);
  }
  return (
    isStringOneOf(value.chartType, ASSISTANT_CHART_TYPE_VALUES) &&
    isStringArray(value.labels) &&
    Array.isArray(value.series) &&
    value.series.every(isAssistantChartSeries)
  );
}

function isAssistantChartSeries(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return typeof value.name === "string" && Array.isArray(value.data) && value.data.every((entry) => finiteNumber(entry) !== undefined);
}

function isAssistantMemory(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.content === "string" &&
    typeof value.category === "string" &&
    isStringOneOf(value.status, ASSISTANT_MEMORY_STATUS_VALUES) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isAssistantMemoryCandidate(value: unknown): value is AssistantMemoryCandidate {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.content === "string" &&
    typeof value.category === "string" &&
    typeof value.reason === "string" &&
    isStringOneOf(value.status, ASSISTANT_MEMORY_CANDIDATE_STATUS_VALUES) &&
    typeof value.createdAt === "string"
  );
}

function isAssistantChoiceRequest(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.question === "string" &&
    typeof value.reason === "string" &&
    typeof value.customPlaceholder === "string" &&
    Array.isArray(value.options) &&
    value.options.every(isAssistantChoiceOption)
  );
}

function isAssistantChoiceOption(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.description === "string" &&
    (value.recommended === undefined || typeof value.recommended === "boolean") &&
    (value.requiresCustom === undefined || typeof value.requiresCustom === "boolean")
  );
}

function isAssistantDeepResearchJob(value: unknown): value is AssistantDeepResearchJob {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.threadId === "string" &&
    typeof value.query === "string" &&
    isStringOneOf(value.mode, ASSISTANT_MODE_VALUES) &&
    isStringOneOf(value.researchKind, ASSISTANT_DEEP_RESEARCH_KIND_VALUES) &&
    isStringOneOf(value.status, ASSISTANT_DEEP_RESEARCH_STATUS_VALUES) &&
    typeof value.progressTitle === "string" &&
    typeof value.progressStage === "string" &&
    finiteNumber(value.progressCurrent) !== undefined &&
    finiteNumber(value.progressTotal) !== undefined &&
    typeof value.stopRequested === "boolean" &&
    (value.resultMessageId === undefined || typeof value.resultMessageId === "string") &&
    (value.errorMessage === undefined || typeof value.errorMessage === "string") &&
    typeof value.createdAt === "string" &&
    (value.startedAt === undefined || typeof value.startedAt === "string") &&
    typeof value.updatedAt === "string" &&
    (value.completedAt === undefined || typeof value.completedAt === "string")
  );
}

function isCompanyCandidate(value: unknown): value is CompanyCandidate {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    typeof value.name === "string" && value.name.trim().length > 0 &&
    typeof value.code === "string" && value.code.trim().length > 0 &&
    typeof value.exchange === "string" &&
    typeof value.listingPlace === "string" && value.listingPlace.trim().length > 0 &&
    typeof value.marketType === "string" && value.marketType.trim().length > 0 &&
    (value.source === "eastmoney" || value.source === "yahoo")
  );
}

function isResearchOpportunitySignal(value: unknown): value is ResearchOpportunitySignal {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    (value.entityType === "company" || value.entityType === "industry") &&
    typeof value.entityId === "string" && value.entityId.trim().length > 0 &&
    typeof value.title === "string" && value.title.trim().length > 0 &&
    typeof value.subtitle === "string" &&
    isStringOneOf(value.stage, RESEARCH_STAGES) &&
    isOpportunityScore(value.opportunityScore) &&
    isOpportunityScore(value.riskScore) &&
    isOpportunityScore(value.evidenceScore) &&
    isOpportunityScore(value.catalystScore) &&
    isOpportunityScore(value.valuationMismatchScore) &&
    isOpportunityScore(value.upsideScore) &&
    finiteNumber(value.sourceCount) !== undefined &&
    isStringArray(value.reasons) &&
    isStringOneOf(value.source, OPPORTUNITY_SOURCE_VALUES)
  );
}

function isOpportunityFunnelItem(value: unknown): value is { stage: ResearchStage; count: number } {
  if (!isPlainRecord(value)) return false;
  const count = finiteNumber(value.count);
  return isStringOneOf(value.stage, RESEARCH_STAGES) && count !== undefined && count >= 0;
}

function isOpportunityInboxItem(value: unknown): value is OpportunitiesResult["inbox"][number] {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    (value.itemId === undefined || typeof value.itemId === "string") &&
    typeof value.type === "string" &&
    typeof value.title === "string" && value.title.trim().length > 0 &&
    typeof value.body === "string" &&
    typeof value.severity === "string" &&
    typeof value.status === "string" &&
    typeof value.createdAt === "string"
  );
}

function isOpportunityScore(value: unknown) {
  const score = finiteNumber(value);
  return score !== undefined && score >= 0 && score <= 100;
}

function isUserSession(value: unknown): value is UserSession {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.userId === "string" && value.userId.trim().length > 0 &&
    typeof value.username === "string" &&
    typeof value.displayName === "string" &&
    USER_SESSION_ROLE_VALUES.includes(value.role as (typeof USER_SESSION_ROLE_VALUES)[number])
  );
}

function isWatchlistItem(value: unknown): value is WatchlistItem {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    typeof value.userId === "string" && value.userId.trim().length > 0 &&
    isCompanyCandidate(value.company) &&
    (value.reportLibraryId === undefined || typeof value.reportLibraryId === "string") &&
    typeof value.addedAt === "string"
  );
}

function isWatchlistRankingEntry(value: unknown): value is WatchlistRankingEntry {
  if (!isPlainRecord(value)) return false;
  return (
    (value.id === undefined || typeof value.id === "string") &&
    typeof value.watchlistId === "string" && value.watchlistId.trim().length > 0 &&
    typeof value.companyName === "string" && value.companyName.trim().length > 0 &&
    typeof value.ticker === "string" &&
    typeof value.market === "string" &&
    (value.listingPlace === undefined || typeof value.listingPlace === "string") &&
    isStringOneOf(value.status, WATCHLIST_RANKING_STATUS_VALUES) &&
    (value.companyQualityScore === undefined || finiteNumber(value.companyQualityScore) !== undefined) &&
    (value.investmentAttractivenessScore === undefined || finiteNumber(value.investmentAttractivenessScore) !== undefined) &&
    (value.overallScore === undefined || finiteNumber(value.overallScore) !== undefined) &&
    (value.verdict === undefined || typeof value.verdict === "string") &&
    (value.summary === undefined || typeof value.summary === "string") &&
    isStringArray(value.keyPoints) &&
    isStringArray(value.riskFlags) &&
    (value.evidenceHash === undefined || typeof value.evidenceHash === "string") &&
    (value.updatedAt === undefined || typeof value.updatedAt === "string") &&
    (value.errorMessage === undefined || typeof value.errorMessage === "string")
  );
}

function isRadarAnalysisJob(value: unknown): value is RadarAnalysisJob {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    isStringOneOf(value.status, RADAR_JOB_STATUS_VALUES) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.evidenceHash === undefined || typeof value.evidenceHash === "string") &&
    (value.message === undefined || typeof value.message === "string") &&
    (value.radarGeneratedAt === undefined || typeof value.radarGeneratedAt === "string") &&
    (value.tokenUsage === undefined || isRadarTokenUsage(value.tokenUsage))
  );
}

function isRadarDiagnostics(value: unknown): value is RadarDiagnostics {
  if (!isPlainRecord(value)) return false;
  return (
    (value.jobStatus === undefined || isStringOneOf(value.jobStatus, RADAR_JOB_STATUS_VALUES)) &&
    (value.jobMessage === undefined || typeof value.jobMessage === "string") &&
    (value.evidenceGeneratedAt === undefined || typeof value.evidenceGeneratedAt === "string") &&
    (value.evidenceHash === undefined || typeof value.evidenceHash === "string") &&
    (value.evidenceAgeHours === undefined || finiteNumber(value.evidenceAgeHours) !== undefined) &&
    (value.latestRadarGeneratedAt === undefined || typeof value.latestRadarGeneratedAt === "string") &&
    (value.sourceCount === undefined || finiteNumber(value.sourceCount) !== undefined) &&
    (value.cacheVersion === undefined || typeof value.cacheVersion === "string") &&
    (value.tokenUsage === undefined || isRadarTokenUsage(value.tokenUsage))
  );
}

function isRadarTokenUsage(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    (value.model === undefined || typeof value.model === "string") &&
    (value.calls === undefined || finiteNumber(value.calls) !== undefined) &&
    finiteNumber(value.promptTokens) !== undefined &&
    finiteNumber(value.promptCacheHitTokens) !== undefined &&
    finiteNumber(value.promptCacheMissTokens) !== undefined &&
    finiteNumber(value.completionTokens) !== undefined &&
    finiteNumber(value.totalTokens) !== undefined &&
    (value.cacheHitRate === undefined || finiteNumber(value.cacheHitRate) !== undefined)
  );
}

function isRadarItem(value: unknown): value is RadarItem {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.title === "string" &&
    isStringArray(value.industries) &&
    isStringArray(value.companies) &&
    typeof value.thesis === "string" &&
    isStringArray(value.drivers) &&
    isStringArray(value.evidence) &&
    isStringOneOf(value.conclusionStrength, RADAR_CONCLUSION_STRENGTH_VALUES) &&
    isStringArrayOf(value.evidenceGaps, RADAR_EVIDENCE_GAP_VALUES) &&
    isStringArrayOf(value.driverTags, RADAR_DRIVER_TAG_VALUES) &&
    isStringOneOf(value.sustainabilityTier, RADAR_SUSTAINABILITY_TIER_VALUES) &&
    isStringOneOf(value.durability, RADAR_DURABILITY_VALUES) &&
    isStringOneOf(value.riskLevel, RADAR_RISK_LEVEL_VALUES) &&
    (value.confidence === undefined || isStringOneOf(value.confidence, RADAR_CONFIDENCE_VALUES)) &&
    (value.evidenceTypes === undefined || isStringArrayOf(value.evidenceTypes, RADAR_EVIDENCE_TYPE_VALUES)) &&
    (value.supportingSourceCount === undefined || finiteNumber(value.supportingSourceCount) !== undefined) &&
    (value.sourceIds === undefined || isStringArray(value.sourceIds)) &&
    (value.changeReason === undefined || typeof value.changeReason === "string") &&
    isStringArray(value.counterEvidenceConditions) &&
    (value.confirmationConditions === undefined || isStringArray(value.confirmationConditions)) &&
    isStringArray(value.turningPoints)
  );
}

function isRadarList(value: unknown): value is RadarList {
  if (!isPlainRecord(value)) return false;
  return typeof value.label === "string" && isStringArray(value.companies) && typeof value.note === "string";
}

function isRadarCitation(value: unknown): value is RadarCitation {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.query === "string" &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    isStringOneOf(value.sourceType, RADAR_EVIDENCE_TYPE_VALUES) &&
    finiteNumber(value.weight) !== undefined &&
    (value.publishedAt === undefined || typeof value.publishedAt === "string") &&
    (value.summary === undefined || typeof value.summary === "string") &&
    (value.signalType === undefined || typeof value.signalType === "string") &&
    (value.score === undefined || finiteNumber(value.score) !== undefined)
  );
}

function isRadarCoverageItem(value: unknown): value is RadarCoverageItem {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.label === "string" &&
    finiteNumber(value.sourceCount) !== undefined &&
    isStringArrayOf(value.evidenceTypes, RADAR_EVIDENCE_TYPE_VALUES) &&
    typeof value.note === "string" &&
    (value.topSourceIds === undefined || isStringArray(value.topSourceIds))
  );
}

function isRadarCoverageReview(value: unknown): value is RadarCoverageReview {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.label === "string" &&
    isStringOneOf(value.status, RADAR_COVERAGE_STATUS_VALUES) &&
    finiteNumber(value.sourceCount) !== undefined &&
    isStringArrayOf(value.evidenceTypes, RADAR_EVIDENCE_TYPE_VALUES) &&
    typeof value.note === "string" &&
    (value.sourceIds === undefined || isStringArray(value.sourceIds))
  );
}

function isRadarIndustryPacket(value: unknown): value is RadarIndustryPacket {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.group === "string" &&
    typeof value.industry === "string" &&
    value.status === "scanned" &&
    (value.changeStatus === undefined || isStringOneOf(value.changeStatus, RADAR_CHANGE_STATUS_VALUES)) &&
    (value.stage === undefined || isStringOneOf(value.stage, RADAR_INDUSTRY_STAGE_VALUES)) &&
    typeof value.evidenceHash === "string" &&
    finiteNumber(value.sourceCount) !== undefined &&
    isStringArrayOf(value.evidenceTypes, RADAR_EVIDENCE_TYPE_VALUES) &&
    isStringArray(value.signalTypes) &&
    isStringArrayOf(value.evidenceGaps, RADAR_EVIDENCE_GAP_VALUES) &&
    (value.themes === undefined || isStringArray(value.themes)) &&
    (value.sourceIds === undefined || isStringArray(value.sourceIds)) &&
    (value.dataFreshness === undefined || isRadarEvidenceFreshness(value.dataFreshness)) &&
    (value.conclusionEligibility === undefined || isStringOneOf(value.conclusionEligibility, RADAR_CONCLUSION_ELIGIBILITY_VALUES)) &&
    (value.metricRefs === undefined || isStringArray(value.metricRefs)) &&
    (value.scoreTrend === undefined || (Array.isArray(value.scoreTrend) && value.scoreTrend.every(isRadarScoreTrend))) &&
    (value.scores === undefined || isRadarScores(value.scores))
  );
}

function isRadarEvidenceFreshness(value: unknown): value is RadarEvidenceFreshness {
  if (!isPlainRecord(value)) return false;
  return (
    (value.generatedAt === undefined || typeof value.generatedAt === "string") &&
    (value.asOfDate === undefined || typeof value.asOfDate === "string") &&
    (value.ageHours === undefined || finiteNumber(value.ageHours) !== undefined) &&
    typeof value.stale === "boolean" &&
    (value.sourceCount === undefined || finiteNumber(value.sourceCount) !== undefined) &&
    (value.evidenceHash === undefined || typeof value.evidenceHash === "string")
  );
}

function isRadarAnalysisScope(value: unknown): value is RadarAnalysisScope {
  if (!isPlainRecord(value)) return false;
  return (
    finiteNumber(value.totalIndustryCount) !== undefined &&
    finiteNumber(value.changedIndustryCount) !== undefined &&
    finiteNumber(value.unchangedIndustryCount) !== undefined &&
    finiteNumber(value.previousIndustryCount) !== undefined
  );
}

function isRadarScoreTrend(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.runTime === "string" &&
    finiteNumber(value.growth) !== undefined &&
    finiteNumber(value.evidence) !== undefined &&
    finiteNumber(value.risk) !== undefined &&
    (value.stage === undefined || isStringOneOf(value.stage, RADAR_INDUSTRY_STAGE_VALUES))
  );
}

function isRadarScores(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    finiteNumber(value.growth) !== undefined &&
    finiteNumber(value.momentum) !== undefined &&
    finiteNumber(value.evidence) !== undefined &&
    finiteNumber(value.valuationRisk) !== undefined &&
    finiteNumber(value.bubbleRisk) !== undefined &&
    finiteNumber(value.declineRisk) !== undefined &&
    finiteNumber(value.confidence) !== undefined &&
    finiteNumber(value.change) !== undefined
  );
}

function normalizeRadarEvidenceBreakdown(value: unknown): RadarEvidenceBreakdown | undefined {
  if (!isPlainRecord(value)) return undefined;
  const breakdown: RadarEvidenceBreakdown = {};
  for (const type of RADAR_EVIDENCE_TYPE_VALUES) {
    const count = finiteNumber(value[type]);
    if (count !== undefined) breakdown[type] = count;
  }
  return Object.keys(breakdown).length ? breakdown : undefined;
}

function isResearchWorkbenchItem(value: unknown): value is ResearchWorkbenchItem {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    typeof value.userKey === "string" &&
    (value.entityType === "company" || value.entityType === "industry") &&
    typeof value.entityId === "string" && value.entityId.trim().length > 0 &&
    typeof value.title === "string" && value.title.trim().length > 0 &&
    typeof value.stage === "string" && ["screening", "deepResearch", "awaitingCatalyst", "opinionFormed", "archived"].includes(value.stage) &&
    typeof value.status === "string" &&
    typeof value.source === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isActivityEvent(value: unknown): value is ActivityEvent {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    typeof value.itemId === "string" && value.itemId.trim().length > 0 &&
    typeof value.eventType === "string" && value.eventType.trim().length > 0 &&
    typeof value.title === "string" && value.title.trim().length > 0 &&
    (typeof value.description === "string" || value.description === null) &&
    isPlainRecord(value.metadata) &&
    typeof value.createdAt === "string"
  );
}

function isResearchThesisVersion(value: unknown): value is ResearchThesisVersion {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    typeof value.itemId === "string" && value.itemId.trim().length > 0 &&
    typeof value.version === "number" && Number.isFinite(value.version) &&
    typeof value.thesisMarkdown === "string" &&
    isStringArray(value.coreCitations) &&
    isStringArray(value.counterEvidence) &&
    (value.evidenceHash === undefined || typeof value.evidenceHash === "string") &&
    typeof value.createdBy === "string" &&
    typeof value.createdAt === "string"
  );
}

function isResearchCatalyst(value: unknown): value is ResearchCatalyst {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    typeof value.itemId === "string" && value.itemId.trim().length > 0 &&
    typeof value.title === "string" && value.title.trim().length > 0 &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.dueAt === undefined || typeof value.dueAt === "string") &&
    typeof value.status === "string" &&
    RESEARCH_CATALYST_STATUSES.includes(value.status as ResearchCatalystStatus) &&
    isStringArray(value.evidenceRefs) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isValuationRunSummary(value: unknown): value is ValuationRunSummary {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    (value.researchItemId === undefined || typeof value.researchItemId === "string") &&
    (value.entityType === "company" || value.entityType === "industry") &&
    typeof value.entityId === "string" && value.entityId.trim().length > 0 &&
    typeof value.title === "string" && value.title.trim().length > 0 &&
    isStringOneOf(value.status, VALUATION_RUN_STATUS_VALUES) &&
    isStringOneOf(value.method, VALUATION_METHOD_VALUES) &&
    isStringOneOf(value.archetype, COMPANY_ARCHETYPE_VALUES) &&
    typeof value.currency === "string" && value.currency.trim().length > 0 &&
    (value.result === undefined || isValuationResult(value.result)) &&
    (value.objectKey === undefined || typeof value.objectKey === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isValuationResult(value: unknown): value is NonNullable<ValuationRunSummary["result"]> {
  if (!isPlainRecord(value)) return false;
  return (
    (value.methodologyVersion === undefined || typeof value.methodologyVersion === "number") &&
    (value.quantitativeVersionId === undefined || typeof value.quantitativeVersionId === "string") &&
    (value.sourceSnapshotId === undefined || typeof value.sourceSnapshotId === "string") &&
    (value.warnings === undefined || isStringArray(value.warnings)) &&
    isStringOneOf(value.method, VALUATION_METHOD_VALUES) &&
    isStringOneOf(value.archetype, COMPANY_ARCHETYPE_VALUES) &&
    typeof value.currency === "string" && value.currency.trim().length > 0 &&
    typeof value.asOf === "string" &&
    Array.isArray(value.assumptions) &&
    value.assumptions.every(isValuationAssumption) &&
    Array.isArray(value.scenarios) &&
    value.scenarios.every(isValuationScenarioResult) &&
    (value.forecastRows === undefined || (Array.isArray(value.forecastRows) && value.forecastRows.every(isThreeStatementForecastRow))) &&
    (value.sensitivity === undefined || (Array.isArray(value.sensitivity) && value.sensitivity.every(isValuationSensitivityPoint))) &&
    (value.peerRange === undefined || isValuationPeerRange(value.peerRange)) &&
    (value.evidenceHash === undefined || typeof value.evidenceHash === "string") &&
    (value.modelResults === undefined || (Array.isArray(value.modelResults) && value.modelResults.every(isPlainRecord))) &&
    (value.actualReviews === undefined || (Array.isArray(value.actualReviews) && value.actualReviews.every(isPlainRecord)))
  );
}

function isValuationAssumption(value: unknown): value is NonNullable<ValuationRunSummary["result"]>["assumptions"][number] {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.key === "string" &&
    typeof value.label === "string" &&
    finiteNumber(value.low) !== undefined &&
    finiteNumber(value.base) !== undefined &&
    finiteNumber(value.high) !== undefined &&
    typeof value.unit === "string" &&
    (value.origin === "provider" || value.origin === "formula" || value.origin === "ai" || value.origin === "user") &&
    isStringArray(value.evidenceRefs) &&
    finiteNumber(value.confidence) !== undefined &&
    typeof value.locked === "boolean"
  );
}

function isValuationScenarioResult(value: unknown): value is NonNullable<ValuationRunSummary["result"]>["scenarios"][number] {
  if (!isPlainRecord(value)) return false;
  return (
    isStringOneOf(value.scenario, VALUATION_SCENARIO_VALUES) &&
    finiteNumber(value.equityValue) !== undefined &&
    finiteNumber(value.perShareValue) !== undefined &&
    typeof value.summary === "string"
  );
}

function isThreeStatementForecastRow(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    finiteNumber(value.year) !== undefined &&
    finiteNumber(value.revenue) !== undefined &&
    finiteNumber(value.ebit) !== undefined &&
    finiteNumber(value.tax) !== undefined &&
    finiteNumber(value.nopat) !== undefined &&
    finiteNumber(value.depreciationAmortization) !== undefined &&
    finiteNumber(value.capex) !== undefined &&
    finiteNumber(value.workingCapitalChange) !== undefined &&
    finiteNumber(value.freeCashFlow) !== undefined
  );
}

function isValuationSensitivityPoint(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.row === "string" &&
    typeof value.column === "string" &&
    finiteNumber(value.discountRate) !== undefined &&
    finiteNumber(value.terminalGrowthRate) !== undefined &&
    finiteNumber(value.perShareValue) !== undefined
  );
}

function isValuationPeerRange(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    finiteNumber(value.low) !== undefined &&
    finiteNumber(value.median) !== undefined &&
    finiteNumber(value.high) !== undefined &&
    typeof value.metric === "string"
  );
}

function isQuantitativeValuationWorkspace(value: unknown): value is QuantitativeValuationWorkspace {
  if (!isPlainRecord(value)) return false;
  return (
    (value.run === undefined || isValuationRunSummary(value.run)) &&
    (value.snapshot === undefined || isQuantitativeValuationSnapshot(value.snapshot)) &&
    Array.isArray(value.versions) &&
    value.versions.every(isQuantitativeValuationVersion) &&
    Array.isArray(value.actualReviews) &&
    value.actualReviews.every(isActualReview)
  );
}

function isQuantitativeValuationVersion(value: unknown): value is QuantitativeValuationVersion {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    typeof value.runId === "string" && value.runId.trim().length > 0 &&
    typeof value.sourceSnapshotId === "string" &&
    finiteNumber(value.version) !== undefined &&
    typeof value.status === "string" &&
    (value.parentVersionId === undefined || typeof value.parentVersionId === "string") &&
    isStringOneOf(value.archetype, COMPANY_ARCHETYPE_VALUES) &&
    isStringOneOf(value.method, VALUATION_METHOD_VALUES) &&
    finiteNumber(value.horizonYears) !== undefined &&
    (value.draft === undefined || isQuantitativeDraft(value.draft)) &&
    (value.result === undefined || isValuationResult(value.result)) &&
    (value.decisionNote === undefined || typeof value.decisionNote === "string") &&
    typeof value.createdBy === "string" &&
    typeof value.createdAt === "string"
  );
}

function isQuantitativeValuationSnapshot(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    typeof value.market === "string" &&
    typeof value.asOf === "string" &&
    (value.evidenceHash === undefined || typeof value.evidenceHash === "string") &&
    typeof value.contentHash === "string" &&
    typeof value.createdAt === "string"
  );
}

function isQuantitativeDraft(value: unknown): value is QuantitativeDraft {
  if (!isPlainRecord(value)) return false;
  const hasMethodInput =
    value.method === "dcf_3_statement"
      ? isOperatingValuationInput(value.operating)
      : value.method === "ddm_residual_income"
        ? isFinancialValuationInput(value.financial)
        : value.method === "mid_cycle_nav" && isCyclicalValuationInput(value.cyclical);
  return (
    isStringOneOf(value.method, VALUATION_METHOD_VALUES) &&
    isStringOneOf(value.archetype, COMPANY_ARCHETYPE_VALUES) &&
    typeof value.currency === "string" && value.currency.trim().length > 0 &&
    typeof value.asOf === "string" &&
    hasMethodInput &&
    (value.scenarios === undefined || isQuantitativeScenarios(value.scenarios)) &&
    (value.assumptions === undefined || (Array.isArray(value.assumptions) && value.assumptions.every(isEditableAssumption))) &&
    (value.presets === undefined || (Array.isArray(value.presets) && value.presets.every(isQuantitativePreset))) &&
    (value.restoredPresetLibrary === undefined || isRestoredPresetLibrary(value.restoredPresetLibrary)) &&
    (value.warnings === undefined || isStringArray(value.warnings))
  );
}

function isQuantitativeScenarios(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(([key, scenario]) => (
    isStringOneOf(key, VALUATION_SCENARIO_VALUES) &&
    isPlainRecord(scenario) &&
    (scenario.discountRate === undefined || finiteNumber(scenario.discountRate) !== undefined) &&
    (scenario.costOfEquity === undefined || finiteNumber(scenario.costOfEquity) !== undefined) &&
    (scenario.terminalGrowthRate === undefined || finiteNumber(scenario.terminalGrowthRate) !== undefined)
  ));
}

function isOperatingValuationInput(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.currency === "string" &&
    typeof value.asOf === "string" &&
    finiteNumber(value.baseRevenue) !== undefined &&
    finiteNumber(value.sharesOutstanding) !== undefined &&
    finiteNumber(value.netDebt) !== undefined &&
    isScenarioTriple(value.revenueGrowth) &&
    isScenarioTriple(value.ebitMargin) &&
    finiteNumber(value.taxRate) !== undefined &&
    finiteNumber(value.depreciationRate) !== undefined &&
    isScenarioTriple(value.capexRate) &&
    finiteNumber(value.workingCapitalRate) !== undefined &&
    isScenarioTriple(value.discountRate) &&
    isScenarioTriple(value.terminalGrowthRate) &&
    (value.peerEvEbitda === undefined || isScenarioTriple(value.peerEvEbitda)) &&
    (value.evidenceHash === undefined || typeof value.evidenceHash === "string") &&
    (value.forecastOverrides === undefined || (Array.isArray(value.forecastOverrides) && value.forecastOverrides.every(isForecastOverride)))
  );
}

function isFinancialValuationInput(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.currency === "string" &&
    typeof value.asOf === "string" &&
    finiteNumber(value.bookValue) !== undefined &&
    finiteNumber(value.sharesOutstanding) !== undefined &&
    isScenarioTriple(value.roe) &&
    isScenarioTriple(value.payoutRatio) &&
    isScenarioTriple(value.costOfEquity) &&
    isScenarioTriple(value.terminalGrowthRate) &&
    (value.evidenceHash === undefined || typeof value.evidenceHash === "string")
  );
}

function isCyclicalValuationInput(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.currency === "string" &&
    typeof value.asOf === "string" &&
    isScenarioTriple(value.midCycleEbitda) &&
    finiteNumber(value.normalizedNetCash) !== undefined &&
    finiteNumber(value.sharesOutstanding) !== undefined &&
    (value.replacementAssetValue === undefined || isScenarioTriple(value.replacementAssetValue)) &&
    isScenarioTriple(value.evEbitdaMultiple) &&
    (value.evidenceHash === undefined || typeof value.evidenceHash === "string")
  );
}

function isScenarioTriple(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return finiteNumber(value.low) !== undefined && finiteNumber(value.base) !== undefined && finiteNumber(value.high) !== undefined;
}

function isForecastOverride(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    finiteNumber(value.year) !== undefined &&
    (value.revenueGrowth === undefined || finiteNumber(value.revenueGrowth) !== undefined) &&
    (value.ebitMargin === undefined || finiteNumber(value.ebitMargin) !== undefined) &&
    (value.capexRate === undefined || finiteNumber(value.capexRate) !== undefined) &&
    (value.workingCapitalRate === undefined || finiteNumber(value.workingCapitalRate) !== undefined)
  );
}

function isEditableAssumption(value: unknown): value is EditableAssumption {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.key === "string" &&
    typeof value.label === "string" &&
    (value.value === undefined || finiteNumber(value.value) !== undefined) &&
    (value.bear === undefined || finiteNumber(value.bear) !== undefined) &&
    (value.base === undefined || finiteNumber(value.base) !== undefined) &&
    (value.bull === undefined || finiteNumber(value.bull) !== undefined) &&
    (value.unit === undefined || typeof value.unit === "string") &&
    (value.origin === "provider" || value.origin === "formula" || value.origin === "ai" || value.origin === "user") &&
    (value.evidenceRefs === undefined || isStringArray(value.evidenceRefs)) &&
    (value.confidence === undefined || finiteNumber(value.confidence) !== undefined) &&
    typeof value.locked === "boolean" &&
    (value.explanation === undefined || typeof value.explanation === "string") &&
    (value.forecastYear === undefined || finiteNumber(value.forecastYear) !== undefined)
  );
}

function isQuantitativePreset(value: unknown): value is QuantitativePreset {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    typeof value.name === "string" && value.name.trim().length > 0 &&
    typeof value.createdAt === "string" &&
    Array.isArray(value.assumptions) &&
    value.assumptions.every(isEditableAssumption)
  );
}

function isRestoredPresetLibrary(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return finiteNumber(value.version) !== undefined && typeof value.restoredAt === "string";
}

function isActualReview(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.metricKey === "string" &&
    finiteNumber(value.forecastYear) !== undefined &&
    finiteNumber(value.forecastValue) !== undefined &&
    finiteNumber(value.actualValue) !== undefined &&
    finiteNumber(value.absoluteError) !== undefined &&
    (value.percentageError === undefined || finiteNumber(value.percentageError) !== undefined)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringArrayOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number][] {
  return Array.isArray(value) && value.every((entry) => isStringOneOf(entry, allowed));
}

function isStringOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}

function objectPayload(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

function arrayPayload<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function stringArrayPayload(value: unknown): string[] {
  return arrayPayload<unknown>(value).filter((entry): entry is string => typeof entry === "string");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || finiteNumber(value) !== undefined;
}

function isCompanyNewsBundle(value: unknown): value is CompanyNewsBundle {
  if (!isPlainRecord(value)) return false;
  return (
    isPlainRecord(value.company) &&
    Array.isArray(value.companyNews) &&
    Array.isArray(value.industryNews) &&
    isNewsSentimentSummary(value.companySummary) &&
    isNewsSentimentSummary(value.industrySummary) &&
    typeof value.companyQuery === "string" &&
    typeof value.industryQuery === "string" &&
    typeof value.industryLabel === "string" &&
    typeof value.fetchedAt === "string"
  );
}

function isNewsSentimentSummary(value: unknown): value is CompanyNewsBundle["companySummary"] {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.total === "number" &&
    typeof value.positive === "number" &&
    typeof value.negative === "number" &&
    typeof value.neutral === "number" &&
    typeof value.positivePct === "number" &&
    typeof value.negativePct === "number" &&
    typeof value.neutralPct === "number" &&
    (value.overall === "positive" || value.overall === "negative" || value.overall === "neutral") &&
    typeof value.overallLabel === "string" &&
    typeof value.sourceCount === "number" &&
    Array.isArray(value.sources) &&
    typeof value.qualityLabel === "string"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
