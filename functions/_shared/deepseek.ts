import {
  stabilizeReportScores,
  validateReportPayload,
  type InvestmentReport,
  MODULE_WEIGHTS,
  REQUIRED_SECTION_KEYS,
  REQUIRED_FULL_SECTION_KEYS,
  SCORE_ITEMS_20,
  type ReportTokenUsage,
  type ReportSections,
} from "../../src/shared/report";
import { jsonrepair } from "jsonrepair";
import { buildDeepSeekRequestInit, cacheStableUserContent, withCacheProtocol } from "./deepseek-cache";
import { OPENCODE_GO_DEEPSEEK_FLASH_MODEL, buildDeepSeekFallbackRoutes, type DeepSeekFallbackRoute } from "./opencode-go";
import type { EvidenceBundle } from "./providers";

type FetchLike = typeof fetch;
type FullSectionKey = (typeof REQUIRED_FULL_SECTION_KEYS)[number];
type DeepSeekModel = DeepSeekFallbackRoute["model"];

export const MODEL_OUTPUT_LENGTH_MESSAGE = "模型输出超过长度限制，本次报告未完成，请重试。";
export const MODEL_OUTPUT_INVALID_JSON_MESSAGE = "模型返回的 JSON 不完整，本次报告未完成，请重试。";
export const DEEPSEEK_NETWORK_MESSAGE = "DeepSeek 网络连接不稳定，本次报告未完成，请重试。";

const NARRATIVE_SECTION_BATCHES: FullSectionKey[][] = [
  ["accountRules"],
  ["onePageConclusion", "companyOverview", "industryTrack"],
  ["businessModel", "moat", "governance"],
  ["financialQuality", "growthInflection", "valuation"],
  ["risks"],
  ["finalConclusion"],
];

const SCORE_ITEM_DETAIL_BATCHES = [
  SCORE_ITEMS_20.slice(0, 5).map((item) => item.id),
  SCORE_ITEMS_20.slice(5, 10).map((item) => item.id),
  SCORE_ITEMS_20.slice(10, 15).map((item) => item.id),
  SCORE_ITEMS_20.slice(15, 20).map((item) => item.id),
];

const FULL_SECTION_LABELS: Record<FullSectionKey, string> = {
  onePageConclusion: "一页结论",
  companyOverview: "公司概况",
  industryTrack: "行业赛道",
  businessModel: "商业模式",
  moat: "护城河",
  governance: "治理结构",
  financialQuality: "财务质量",
  growthInflection: "成长转折",
  valuation: "估值分析",
  risks: "风险反证",
  finalConclusion: "最终结论",
  accountRules: "仓位规则",
};

const NARRATIVE_SECTION_ITEM_IDS: Record<FullSectionKey, string[]> = {
  onePageConclusion: [
    "businessModelQuality",
    "durableMoat",
    "marketPosition",
    "revenueGrowthQuality",
    "profitAndFcfGrowth",
    "roeRoicMargins",
    "cashFlowConsistency",
    "balanceSheetHealth",
    "relativeValuation",
    "tenYearReturnSafety",
    "riskAndDisconfirmingEvidence",
    "ownerPerspective",
  ],
  companyOverview: ["businessModelQuality", "managementExecution", "governanceFairness", "capitalReturn"],
  industryTrack: ["industryLifecycle", "industryCyclicality", "marketPosition", "innovationRisk"],
  businessModel: ["businessModelQuality", "bargainingAndCashConversion", "assetAndCostStructure"],
  moat: ["durableMoat", "marketPosition", "innovationRisk"],
  governance: ["managementExecution", "governanceFairness", "capitalReturn"],
  financialQuality: ["roeRoicMargins", "cashFlowConsistency", "balanceSheetHealth", "profitAndFcfGrowth"],
  growthInflection: ["revenueGrowthQuality", "profitAndFcfGrowth", "industryLifecycle"],
  valuation: ["relativeValuation", "tenYearReturnSafety", "ownerPerspective"],
  risks: ["riskAndDisconfirmingEvidence", "balanceSheetHealth", "innovationRisk", "industryCyclicality"],
  finalConclusion: [
    "industryLifecycle",
    "businessModelQuality",
    "durableMoat",
    "revenueGrowthQuality",
    "roeRoicMargins",
    "cashFlowConsistency",
    "relativeValuation",
    "tenYearReturnSafety",
    "riskAndDisconfirmingEvidence",
    "ownerPerspective",
  ],
  accountRules: ["relativeValuation", "tenYearReturnSafety", "riskAndDisconfirmingEvidence", "ownerPerspective", "capitalReturn"],
};

export class DeepSeekReportError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = true,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DeepSeekReportError";
  }
}

type DeepSeekInput = {
  apiKey?: string;
  opencodeZenApiKey?: string;
  opencodeGoApiKey?: string;
  deepseekApiKey?: string;
  evidence: EvidenceBundle;
  language?: "zh-CN" | "en";
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onProgress?: (progress: { stage: string; label: string; detail: string; percent: number }) => void;
  metrics?: { modelCalls?: number; tokenUsage?: ReportTokenUsage[] };
  priorReport?: InvestmentReport | null;
};

type DeepSeekUsageTracker = {
  byModel: Map<DeepSeekModel, ReportTokenUsage>;
};

type DeepSeekRouteEnv = {
  opencodeZenApiKey?: string;
  opencodeGoApiKey?: string;
  opencodeApiKey?: string;
  deepseekApiKey?: string;
};

export async function callDeepSeekReport({
  apiKey,
  opencodeZenApiKey,
  opencodeGoApiKey,
  deepseekApiKey,
  evidence,
  language = "zh-CN",
  fetchImpl = fetch,
  signal,
  onProgress,
  metrics,
  priorReport,
}: DeepSeekInput): Promise<InvestmentReport> {
  let modelCalls = 0;
  const usageTracker: DeepSeekUsageTracker = { byModel: new Map() };
  const routeEnv: DeepSeekRouteEnv = {
    opencodeZenApiKey,
    opencodeGoApiKey,
    opencodeApiKey: apiKey,
    deepseekApiKey,
  };
  const countedFetch = ((...args: Parameters<FetchLike>) => {
    const resource = args[0];
    const url =
      typeof resource === "string"
        ? resource
        : resource instanceof URL
          ? resource.toString()
          : "url" in resource
            ? resource.url
            : "";
    if (url.includes("/chat/completions")) modelCalls += 1;
    return fetchImpl(args[0], { ...args[1], signal: args[1]?.signal ?? signal });
  }) as FetchLike;

  try {
    const scoringJson = await requestScoringJson({
      routeEnv,
      fetchImpl: countedFetch,
      language,
      evidence,
      onProgress,
      usageTracker,
    });

    const scoringReport = stabilizeReportScores(validateReportPayload(prepareReportPayload(scoringJson, evidence)), priorReport);
    const enrichedReport = validateReportPayload(
      prepareReportPayload(
        {
          ...scoringReport,
          scoreItems20: await requestScoreItemDetails({
            routeEnv,
            fetchImpl: countedFetch,
            language,
            scoringReport,
            evidence,
            onProgress,
            usageTracker,
          }),
        },
        evidence,
      ),
    );
    const fullSections = await requestNarrativeSections({
      routeEnv,
      fetchImpl: countedFetch,
      language,
      scoringReport: enrichedReport,
      evidence,
      onProgress,
      usageTracker,
    });

    const report = validateReportPayload(mergeNarrativePayload(enrichedReport, { fullSections }, evidence));
    return withProviderContext(report, evidence);
  } finally {
    if (metrics) {
      metrics.modelCalls = modelCalls;
      metrics.tokenUsage = Array.from(usageTracker.byModel.values());
    }
  }
}

async function requestScoringJson({
  routeEnv,
  fetchImpl,
  language,
  evidence,
  onProgress,
  usageTracker,
}: {
  routeEnv: DeepSeekRouteEnv;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  evidence: EvidenceBundle;
  onProgress?: DeepSeekInput["onProgress"];
  usageTracker: DeepSeekUsageTracker;
}) {
  try {
    return await requestScoringJsonOnce({ routeEnv, fetchImpl, language, evidence, strictLength: true, usageTracker });
  } catch (error) {
    if (!isRetryableModelOutputError(error)) throw error;
    onProgress?.({
      stage: "deepseek_scoring_retry",
      label: "评分结构重试",
      detail: "模型第一次返回的评分 JSON 不完整，正在用更紧凑结构重试。",
      percent: 64,
    });
    return requestScoringJsonOnce({ routeEnv, fetchImpl, language, evidence, strictLength: true, usageTracker });
  }
}

async function requestScoringJsonOnce({
  routeEnv,
  fetchImpl,
  language,
  evidence,
  strictLength,
  usageTracker,
}: {
  routeEnv: DeepSeekRouteEnv;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  evidence: EvidenceBundle;
  strictLength: boolean;
  usageTracker: DeepSeekUsageTracker;
}) {
  const scoringJson = await requestDeepSeekJson({
    routeEnv,
    fetchImpl,
    model: OPENCODE_GO_DEEPSEEK_FLASH_MODEL,
    maxTokens: 12000,
    usageTracker,
    messages: [
      {
        role: "system",
        content: withCacheProtocol(buildScoringSystemPrompt(language, strictLength), "report-scoring"),
      },
      {
        role: "user",
        content: cacheStableUserContent({
          kind: "report-scoring",
          stable: {
            task: strictLength
              ? "Generate the minimum complete structured scoring JSON. Keep all text very short."
              : "Generate the structured scoring JSON only. Do not write the long narrative fullSections in this pass.",
            moduleWeights: strictLength ? undefined : MODULE_WEIGHTS,
            scoreItems20: SCORE_ITEMS_20.map(({ id, title, moduleId, weight }) => ({ id, title, moduleId, weight })),
            expectedOutputShape: buildScoringOutputShapeForPrompt(strictLength),
          },
          volatile: {
            evidence: compactEvidenceForPrompt(evidence),
          },
        }),
      },
    ],
  });
  assertScoringPayloadComplete(scoringJson);
  return scoringJson;
}

async function requestNarrativeSections({
  routeEnv,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  onProgress,
  usageTracker,
}: {
  routeEnv: DeepSeekRouteEnv;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  onProgress?: DeepSeekInput["onProgress"];
  usageTracker: DeepSeekUsageTracker;
}) {
  const fullSections: Record<string, unknown> = {};
  const batches = await runWarmFirstThenParallel(NARRATIVE_SECTION_BATCHES, async (keys, index) => {
    onProgress?.({
      stage: `deepseek_narrative_${index + 1}`,
      label: "生成完整正文",
      detail: `V4 Flash max reasoning 正在生成${keys.map((key) => FULL_SECTION_LABELS[key]).join("、")}。`,
      percent: 70 + Math.round((index * 15) / Math.max(1, NARRATIVE_SECTION_BATCHES.length - 1)),
    });
    return requestNarrativeBatch({
      routeEnv,
      fetchImpl,
      language,
      scoringReport,
      evidence,
      keys,
      usageTracker,
    });
  });
  for (const batch of batches) Object.assign(fullSections, batch);
  return fullSections;
}

async function requestScoreItemDetails({
  routeEnv,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  onProgress,
  usageTracker,
}: {
  routeEnv: DeepSeekRouteEnv;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  onProgress?: DeepSeekInput["onProgress"];
  usageTracker: DeepSeekUsageTracker;
}) {
  const details: Record<string, ScoreItemDetail> = {};
  const batches = await Promise.all(SCORE_ITEM_DETAIL_BATCHES.map(async (itemIds, index) => {
    onProgress?.({
      stage: `deepseek_score_detail_${index + 1}`,
      label: "补全评分证据",
      detail: `V4 Flash max reasoning 正在补全第 ${index * 5 + 1}-${index * 5 + itemIds.length} 项评分的证据、扣分点和最近变化。`,
      percent: 64 + index,
    });
    return requestScoreItemDetailBatch({
      routeEnv,
      fetchImpl,
      language,
      scoringReport,
      evidence,
      itemIds,
      usageTracker,
    });
  }));
  for (const batchDetails of batches) {
    for (const detail of batchDetails) details[detail.id] = detail;
  }

  return scoringReport.scoreItems20.map((item) => {
    const detail = details[item.id];
    if (!detail) return item;
    return {
      ...item,
      evidence: detail.evidence,
      deductions: detail.deductions,
      recentChange: detail.recentChange,
      reason: detail.reason,
    };
  });
}

async function runWarmFirstThenParallel<T, R>(items: readonly T[], worker: (item: T, index: number) => Promise<R>) {
  if (items.length === 0) return [];
  const first = await worker(items[0], 0);
  if (items.length === 1) return [first];
  const second = await worker(items[1], 1);
  const rest = await Promise.all(items.slice(2).map((item, index) => worker(item, index + 2)));
  return [first, second, ...rest];
}

type ScoreItemDetail = {
  id: string;
  evidence: string[];
  deductions: string[];
  recentChange: string;
  reason: string;
};

function fallbackScoreItemDetail(item: InvestmentReport["scoreItems20"][number]): ScoreItemDetail {
  const evidence = stringArray(item.evidence).filter((text) => !isPlaceholderScoreDetailText(text));
  const deductions = stringArray(item.deductions).filter((text) => !isPlaceholderScoreDetailText(text));
  const reason = isPlaceholderScoreDetailText(item.reason) ? "" : item.reason;
  const recentChange = isPlaceholderScoreDetailText(item.recentChange) ? "" : item.recentChange;
  return {
    id: item.id,
    evidence: evidence.length ? evidence : ["沿用评分阶段的公开证据；本项详细补全因模型输出过长未完成。"],
    deductions: deductions.length ? deductions : [`评分细节补全未完成，沿用主评分阶段的扣分判断：${reason || "暂无额外扣分描述。"}`],
    recentChange: isNonEmptyString(recentChange) ? recentChange : "最近 12 个月变化需结合公开财务和行情证据复核；本项暂不额外调整分数。",
    reason: isNonEmptyString(reason) ? reason : "该项沿用结构化评分阶段的结论；详细证据补全过程被截断，未作为额外事实来源。",
  };
}

function isPlaceholderScoreDetailText(value: unknown) {
  if (!isNonEmptyString(value)) return true;
  return /未提供最近 12 个月变化判断|需在后续复核中补充更细的扣分依据|数据不足：模型未提供该项完整评分理由/.test(value);
}

async function requestScoreItemDetailBatch({
  routeEnv,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  itemIds,
  usageTracker,
}: {
  routeEnv: DeepSeekRouteEnv;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  itemIds: string[];
  usageTracker: DeepSeekUsageTracker;
}): Promise<ScoreItemDetail[]> {
  try {
    return await requestScoreItemDetailBatchOnce({ routeEnv, fetchImpl, language, scoringReport, evidence, itemIds, strictLength: true, usageTracker });
  } catch (error) {
    if (!isRetryableModelOutputError(error)) throw error;
    return fallbackScoreItemDetails(scoringReport, itemIds);
  }
}

function fallbackScoreItemDetails(scoringReport: InvestmentReport, itemIds: string[]) {
  return itemIds.map((id) => {
    const existingItem = scoringReport.scoreItems20.find((item) => item.id === id);
    if (!existingItem) throw new DeepSeekReportError(MODEL_OUTPUT_INVALID_JSON_MESSAGE, "MODEL_OUTPUT_INVALID_JSON", true);
    return fallbackScoreItemDetail(existingItem);
  });
}

async function requestScoreItemDetailBatchOnce({
  routeEnv,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  itemIds,
  strictLength,
  usageTracker,
}: {
  routeEnv: DeepSeekRouteEnv;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  itemIds: string[];
  strictLength: boolean;
  usageTracker: DeepSeekUsageTracker;
}): Promise<ScoreItemDetail[]> {
  const detailJson = await requestDeepSeekJson({
    routeEnv,
    fetchImpl,
    model: OPENCODE_GO_DEEPSEEK_FLASH_MODEL,
    maxTokens: strictLength ? 2400 : 3600,
    timeoutMs: 90_000,
    usageTracker,
    messages: [
      {
        role: "system",
        content: withCacheProtocol(buildScoreItemDetailSystemPrompt(language, strictLength), "report-score-item-detail"),
      },
      {
        role: "user",
        content: cacheStableUserContent({
          kind: "report-score-item-detail",
          stable: {
            task: "Enrich only the requested score item text. Do not change numeric scores.",
            expectedOutputShape: {
              scoreItemDetails: [
                {
                  id: "score-item-id",
                  evidence: ["1-2 条最新公开证据，写明财报期/行情时间/数据来源"],
                  deductions: ["1-2 条明确扣分点"],
                  recentChange: "最近 12 个月变化及对分数影响",
                  reason: strictLength ? "60-100 字中文评分理由" : "90-140 字中文评分理由",
                },
              ],
            },
          },
          volatile: {
            sharedContext: {
              version: "cstd-alpha-shared-v1",
              company: scoringReport.company,
              asOf: scoringReport.asOf,
              financialTenYear: scoringReport.financialTenYear,
              valuationAnalysis: scoringReport.valuationAnalysis,
              evidence: compactEvidenceReferences(evidence),
            },
            requestedItemIds: itemIds,
            requestedScoreItems: scoringReport.scoreItems20
              .filter((item) => itemIds.includes(item.id))
              .map(({ id, title, moduleName, weight, score, label, evidence, deductions, recentChange, reason }) => ({
                id,
                title,
                moduleName,
                weight,
                score,
                label,
                evidence,
                deductions,
                recentChange,
                reason,
              })),
            expectedOutputShape: {
              scoreItemDetails: itemIds.map((id) => ({
                id,
                evidence: ["1-2 条最新公开证据，写明财报期/行情时间/数据来源"],
                deductions: ["1-2 条明确扣分点"],
                recentChange: "最近 12 个月变化及对分数影响",
                reason: strictLength ? "60-100 字中文评分理由" : "90-140 字中文评分理由",
              })),
            },
          },
        }),
      },
    ],
  });
  return normalizeScoreItemDetails(detailJson, itemIds);
}

async function requestNarrativeBatch({
  routeEnv,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  keys,
  usageTracker,
}: {
  routeEnv: DeepSeekRouteEnv;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  keys: FullSectionKey[];
  usageTracker: DeepSeekUsageTracker;
}) {
  try {
    return await requestNarrativeBatchOnce({ routeEnv, fetchImpl, language, scoringReport, evidence, keys, strictLength: true, usageTracker });
  } catch (error) {
    if (!isRetryableModelOutputError(error)) throw error;
    try {
      return await requestNarrativeBatchOnce({ routeEnv, fetchImpl, language, scoringReport, evidence, keys, strictLength: false, usageTracker });
    } catch (retryError) {
      if (!isRetryableModelOutputError(retryError) || keys.length <= 1) throw retryError;
      return requestNarrativeSectionsIndividually({
        routeEnv,
        fetchImpl,
        language,
        scoringReport,
        evidence,
        keys,
        usageTracker,
      });
    }
  }
}

async function requestNarrativeSectionsIndividually({
  routeEnv,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  keys,
  usageTracker,
}: {
  routeEnv: DeepSeekRouteEnv;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  keys: FullSectionKey[];
  usageTracker: DeepSeekUsageTracker;
}) {
  const fullSections: Record<string, unknown> = {};
  for (const key of keys) {
    Object.assign(
      fullSections,
      await requestNarrativeBatchOnce({
        routeEnv,
        fetchImpl,
        language,
        scoringReport,
        evidence,
        keys: [key],
        strictLength: true,
        usageTracker,
      }),
    );
  }
  return fullSections;
}

async function requestNarrativeBatchOnce({
  routeEnv,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  keys,
  strictLength,
  usageTracker,
}: {
  routeEnv: DeepSeekRouteEnv;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  keys: FullSectionKey[];
  strictLength: boolean;
  usageTracker: DeepSeekUsageTracker;
}) {
  const narrativeJson = await requestDeepSeekJson({
    routeEnv,
    fetchImpl,
    model: OPENCODE_GO_DEEPSEEK_FLASH_MODEL,
    maxTokens: strictLength ? 2600 : 4200,
    usageTracker,
    messages: [
      {
        role: "system",
        content: withCacheProtocol(buildNarrativeSystemPrompt(language, strictLength), "report-narrative"),
      },
      {
        role: "user",
        content: cacheStableUserContent({
          kind: "report-narrative",
          stable: {
            task: "Generate only the requested fullSections keys for the already validated scoring report.",
            expectedOutputShape: { fullSections: { requestedKey: "完整中文 Markdown 小节" } },
          },
          volatile: {
            sharedContext: {
              version: "cstd-alpha-shared-v2",
              scoringReport: compactReportForNarrative(scoringReport),
              evidence: compactEvidenceReferences(evidence),
            },
            requestedFullSectionKeys: keys,
            requestedScoreItems: compactScoreItemsForNarrative(scoringReport, keys),
            requestedOutputShape: buildNarrativeOutputShape(keys),
          },
        }),
      },
    ],
  });
  return pickFullSectionKeys(extractFullSections(narrativeJson), keys);
}

async function requestDeepSeekJson({
  routeEnv,
  fetchImpl,
  model,
  messages,
  maxTokens,
  timeoutMs,
  usageTracker,
}: {
  routeEnv: DeepSeekRouteEnv;
  fetchImpl: FetchLike;
  model: DeepSeekModel;
  messages: Array<{ role: "system" | "user"; content: string }>;
  maxTokens: number;
  timeoutMs?: number;
  usageTracker: DeepSeekUsageTracker;
}) {
  const timeoutController = timeoutMs ? new AbortController() : undefined;
  const timeoutId = timeoutController ? setTimeout(() => timeoutController.abort(), timeoutMs) : undefined;
  const routes = modelRoutes(routeEnv, model);
  let lastFailure: unknown;
  try {
    for (const route of routes) {
      let response: Response;
      try {
        response = await fetchDeepSeekWithRetry(fetchImpl, route.url, buildDeepSeekRequest(route, messages, maxTokens, timeoutController?.signal));
      } catch (error) {
        lastFailure = error;
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        lastFailure = new Error(`${route.model} request failed: ${response.status} ${text.slice(0, 500)}`);
        continue;
      }

      const json = (await response.json()) as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
        usage?: Record<string, unknown>;
      };
      recordTokenUsage(usageTracker, route.model, json.usage);
      const choice = json.choices?.[0];
      const content = choice?.message?.content;
      if (choice?.finish_reason === "length" || !content?.trim()) {
        lastFailure = new DeepSeekReportError(MODEL_OUTPUT_LENGTH_MESSAGE, "MODEL_OUTPUT_LENGTH", true);
        continue;
      }

      try {
        return parseJsonObject(content);
      } catch (error) {
        lastFailure = new DeepSeekReportError(MODEL_OUTPUT_INVALID_JSON_MESSAGE, "MODEL_OUTPUT_INVALID_JSON", true, { cause: error });
      }
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (lastFailure instanceof DeepSeekReportError) throw lastFailure;
  if (lastFailure instanceof Error) throw lastFailure;
  throw new DeepSeekReportError(DEEPSEEK_NETWORK_MESSAGE, "DEEPSEEK_NETWORK", true, { cause: lastFailure });
}

function modelRoutes(routeEnv: DeepSeekRouteEnv, preferredModel: DeepSeekModel): Array<{ model: DeepSeekModel; url: string; apiKey?: string; isFree: boolean }> {
  void preferredModel;
  const routes = buildDeepSeekFallbackRoutes({
    OPENCODE_ZEN_API_KEY: routeEnv.opencodeZenApiKey,
    OPENCODE_GO_API_KEY: routeEnv.opencodeGoApiKey,
    OPENCODE_API_KEY: routeEnv.opencodeApiKey,
    DEEPSEEK_API_KEY: routeEnv.deepseekApiKey,
  });
  if (!routes.length) throw new DeepSeekReportError("DeepSeek 路由未配置，本次报告未完成。", "DEEPSEEK_ROUTE_MISSING", false);
  return routes;
}

function buildDeepSeekRequest(
  route: { model: DeepSeekModel; apiKey?: string; isFree: boolean },
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens: number,
  signal: AbortSignal | undefined,
): RequestInit {
  return buildDeepSeekRequestInit({
    apiKey: route.apiKey,
    signal,
    model: route.model,
    reasoningEffort: "max",
    thinking: route.isFree ? { type: "enabled" } : undefined,
    maxTokens,
    messages,
  });
}

async function fetchDeepSeekWithRetry(fetchImpl: FetchLike, url: string, init: RequestInit) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (!isRetryableHttpStatus(response.status) || attempt === 2) return response;
      lastError = new Error(`DeepSeek request failed: ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
    }
  }
  throw new DeepSeekReportError(DEEPSEEK_NETWORK_MESSAGE, "DEEPSEEK_NETWORK", true, { cause: lastError });
}

function isRetryableHttpStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function recordTokenUsage(tracker: DeepSeekUsageTracker, model: DeepSeekModel, rawUsage: Record<string, unknown> | undefined) {
  const usage = normalizeDeepSeekUsage(rawUsage);
  const existing =
    tracker.byModel.get(model) ??
    {
      model,
      calls: 0,
      promptTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
  existing.calls += 1;
  existing.promptTokens += usage.promptTokens;
  existing.promptCacheHitTokens += usage.promptCacheHitTokens;
  existing.promptCacheMissTokens += usage.promptCacheMissTokens;
  existing.completionTokens += usage.completionTokens;
  existing.totalTokens += usage.totalTokens;
  tracker.byModel.set(model, existing);
}

function normalizeDeepSeekUsage(rawUsage: Record<string, unknown> | undefined) {
  return {
    promptTokens: numericUsage(rawUsage?.prompt_tokens),
    promptCacheHitTokens: numericUsage(rawUsage?.prompt_cache_hit_tokens),
    promptCacheMissTokens: numericUsage(rawUsage?.prompt_cache_miss_tokens),
    completionTokens: numericUsage(rawUsage?.completion_tokens),
    totalTokens: numericUsage(rawUsage?.total_tokens),
  };
}

function numericUsage(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildScoringSystemPrompt(language: "zh-CN" | "en", strictLength: boolean) {
  return `
You are CSTD Alpha, a cautious long-term fundamental investment research assistant.
Return ONLY one valid JSON object. Do not wrap it in Markdown.
Language: ${language === "zh-CN" ? "Simplified Chinese" : "English"}.

Rules:
- Use only the evidence bundle and clearly mark missing data. Do not invent facts.
- Distinguish provider failure from business weakness. Yahoo/Eastmoney endpoint failure is not evidence that the company is bad.
- For US-listed companies, SEC EDGAR Company Facts and official investor-relations financial statements are authoritative when Yahoo or Eastmoney financial endpoints are unavailable.
- If SEC/official financial evidence is present, never write that the company's financial statements are fully missing just because Yahoo returned no data.
- This is research, not investment advice.
- Score harshly: ordinary companies should not easily exceed 70.
- Bad companies must receive low scores. Do not give a polite high score when cash flow, leverage, governance, growth, or valuation evidence is poor.
- Every score must be specific, evidence-based, and non-ambiguous. Use labels 极好 / 好 / 一般 / 差.
- All numeric scores must use a 0-100 scale. Do not use a 0-10 scale: 7 means terrible, 70 means good, and 90 means excellent.
- This is a compact scoring pass. Do not write long paragraphs. The full narrative is generated later in smaller batches.
- ${strictLength ? "Strict retry mode: output only required scalar fields, 20 scoreItems20, short valuation/risk/account fields, and evidence references. No optional prose." : "Normal mode: compact but complete structured scoring output."}
- Return the report object at the JSON top level. Do not nest it under "report" or "data".
- Include top-level company: { name, ticker, market, industry, sector }. company.name is mandatory.
- Calculate 公司质量评分（CQS）from company quality modules. Calculate 投资吸引力评分（IAS）after valuation and risk caps. In all human-readable report text, use the Chinese names first, with abbreviations only in parentheses.
- Use these exact section keys: companyOverview, industry, businessModel, moat, governance, financialQuality, growth, valuation, risks, finalConclusion.
- moduleScores may be concise because the server recalculates final module weighted scores from scoreItems20.
- Include all 20 scoreItems20 with ids matching the provided scoreItems20 definitions. Each item needs only id, score, label, evidence, deductions, recentChange, reason. Do not repeat title, question, moduleName or weight.
- Keep each scoreItems20 evidence/deductions array to at most 2 short strings. Keep reason under 80 Chinese characters and recentChange under 50 Chinese characters.
- Do not include fullSections in this pass. Keep regular sections under 120 Chinese characters each; the full narrative is generated in separate batches.
- ${
    strictLength
      ? "Strict retry mode: set financialTenYear.rows to [] and evidence to []; the server will restore provider financial tables and evidence references."
      : "Include financialTenYear.rows for available years and metrics, maximum 8 metrics. If a value is unavailable, write 数据不足, not a fake number."
  }
- If the evidence bundle contains a normalized financialTenYear table, use those metric names and values as authoritative.
- Include valuationAnalysis with currentPrice, fairValueRange, buyRange, sellReduceRange, methods, scenarios, conclusion. If there is no concrete named scenario, return scenarios: [].
- Include riskMatrix with ${strictLength ? "at most 3" : "at most 6"} concrete risks. Never output placeholder risks such as 未分类风险/待验证.
- ${strictLength ? "Do not output source URL lists in strict retry mode." : "Include evidence with source URLs and retrievedAt timestamps, maximum 8 items."}
- Conclusions must be one of: 买入, 加仓, 持有, 观察, 减仓, 卖出, 回避.
`;
}

function buildScoreItemDetailSystemPrompt(language: "zh-CN" | "en", strictLength: boolean) {
  return `
You are CSTD Alpha, strengthening the evidence text for an already scored company report.
Return ONLY one valid JSON object. Do not wrap it in Markdown.
Language: ${language === "zh-CN" ? "Simplified Chinese" : "English"}.

Rules:
- Return only { "scoreItemDetails": [...] } at the JSON top level.
- Do not change numeric scores, labels, item ids, item titles, or weights.
- Use only the provided scoring report, normalized financial table, valuation data, and evidence bundle. Do not invent facts.
- Distinguish data-provider failures from company weakness. If SEC/official financial data is present for a US company, use it and do not describe the company as financially unassessable merely because Yahoo failed.
- Each requested item must include 1-2 concrete evidence bullets, 1-2 direct deduction bullets, a recentChange sentence, and a reason.
- Evidence bullets should mention the latest available period, source freshness, metric name, or valuation snapshot when possible.
- Reasons must be direct and non-ambiguous: bad evidence means low score; do not write polite neutral language for weak companies.
- ${strictLength ? "Strict retry mode: reason 60-100 Chinese characters; evidence bullets short." : "Reason should be 90-140 Chinese characters, with enough detail for a deep report."}
`;
}

function buildNarrativeSystemPrompt(language: "zh-CN" | "en", strictLength: boolean) {
  return `
You are CSTD Alpha, writing the final narrative section of a Chinese company research report.
Return ONLY one valid JSON object. Do not wrap it in Markdown.
Language: ${language === "zh-CN" ? "Simplified Chinese" : "English"}.

Rules:
- Return only { "fullSections": { ... } } at the JSON top level.
- Use only the fullSections keys listed in the user payload for this batch.
- Base the writing only on the validated scoring report and evidence bundle. Do not invent facts.
- Distinguish provider failures from company weakness. For US companies, SEC EDGAR and official investor-relations financial evidence should override Yahoo/Eastmoney financial endpoint failures.
- Write direct conclusions. If evidence is weak, say 数据不足 and explain the impact.
- Each section should be complete enough for a Word report, but avoid unnecessary repetition so the JSON response is not truncated.
- ${strictLength ? "Strict retry mode: each section must be 220-420 Chinese characters and should prioritize conclusion, evidence, deduction logic, and tracking metrics." : "Each section should usually be 350-650 Chinese characters, with concrete evidence and deduction logic."}
- Keep the disclaimer out of fullSections.
`;
}

function compactEvidenceForPrompt(evidence: EvidenceBundle) {
  const summary = asRecord(evidence.facts.summary);
  const eastmoney = asRecord(evidence.facts.eastmoney);
  const sec = asRecord(evidence.facts.sec);
  return {
    company: evidence.company,
    retrievedAt: evidence.retrievedAt,
    evidence: evidence.evidence,
    facts: {
      quote: pick(asRecord(evidence.facts.quote), [
        "symbol",
        "longName",
        "market",
        "currency",
        "regularMarketPrice",
        "regularMarketChangePercent",
        "marketCap",
        "trailingPE",
        "forwardPE",
        "epsTrailingTwelveMonths",
        "dividendYield",
        "fiftyTwoWeekHigh",
        "fiftyTwoWeekLow",
      ]),
      profile: pick(asRecord(summary?.assetProfile), ["sector", "industry", "fullTimeEmployees", "country", "website", "longBusinessSummary"]),
      financialData: pick(asRecord(summary?.financialData), [
        "totalRevenue",
        "grossMargins",
        "operatingMargins",
        "profitMargins",
        "freeCashflow",
        "operatingCashflow",
        "revenueGrowth",
        "earningsGrowth",
        "returnOnAssets",
        "returnOnEquity",
        "debtToEquity",
        "currentRatio",
        "trailingTotalRevenue",
        "trailingNetIncome",
        "trailingOperatingIncome",
        "trailingGrossProfit",
        "trailingOperatingCashFlow",
        "trailingFreeCashFlow",
        "trailingDilutedEPS",
        "quarterlyTotalAssets",
        "quarterlyTotalDebt",
        "quarterlyStockholdersEquity",
      ]),
      summaryDetail: pick(asRecord(summary?.summaryDetail), [
        "marketCap",
        "trailingPE",
        "forwardPE",
        "priceToSalesTrailing12Months",
        "dividendYield",
        "payoutRatio",
        "beta",
        "fiftyTwoWeekHigh",
        "fiftyTwoWeekLow",
      ]),
      keyStatistics: pick(asRecord(summary?.defaultKeyStatistics), [
        "enterpriseValue",
        "profitMargins",
        "floatShares",
        "sharesOutstanding",
        "heldPercentInsiders",
        "heldPercentInstitutions",
        "bookValue",
        "priceToBook",
        "enterpriseToRevenue",
        "enterpriseToEbitda",
      ]),
      price: pick(asRecord(summary?.price), ["longName", "shortName", "currency", "exchangeName", "quoteType"]),
      calendarEvents: pick(asRecord(summary?.calendarEvents), ["earnings", "exDividendDate", "dividendDate"]),
      earnings: pick(asRecord(summary?.earnings), ["financialsChart", "earningsChart"]),
      eastmoney: eastmoney
        ? {
            quote: eastmoney.quote,
            statementRowCounts: {
              incomeRows: arrayLength(eastmoney.incomeRows),
              cashflowRows: arrayLength(eastmoney.cashflowRows),
              balanceRows: arrayLength(eastmoney.balanceRows),
            },
          }
        : undefined,
      sec: pick(sec, ["cik", "title", "latestAnnual", "latestQuarter", "normalizedFinancialTenYear", "summaryFinancialData"]),
      financialTenYear: evidence.facts.financialTenYear,
    },
  };
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function pick(record: Record<string, unknown> | undefined, keys: string[]) {
  if (!record) return undefined;
  return Object.fromEntries(keys.flatMap((key) => (record[key] === undefined ? [] : [[key, record[key]]])));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function prepareReportPayload(parsed: unknown, evidence: EvidenceBundle) {
  const unwrapped = unwrapReportPayload(parsed);
  if (!isRecord(unwrapped)) return unwrapped;
  const modelCompany = isRecord(unwrapped.company) ? unwrapped.company : {};
  const sections = normalizeSections(unwrapped.sections, unwrapped, evidence);
  const providerFinancialTenYear = providerFinancialTenYearFromEvidence(evidence);
  const modelFinancialTenYear = isRecord(unwrapped.financialTenYear) ? unwrapped.financialTenYear : undefined;
  const financialTenYear = providerFinancialTenYear
    ? {
        ...providerFinancialTenYear,
        interpretation: isNonEmptyString(modelFinancialTenYear?.interpretation)
          ? modelFinancialTenYear.interpretation
          : providerFinancialTenYear.interpretation,
      }
    : unwrapped.financialTenYear;
  const providerCurrentPrice = providerCurrentPriceFromEvidence(evidence);
  const modelValuationAnalysis = isRecord(unwrapped.valuationAnalysis) ? unwrapped.valuationAnalysis : {};
  const valuationAnalysis = providerCurrentPrice
    ? completeProviderValuationAnalysis(evidence, modelValuationAnalysis, providerCurrentPrice)
    : unwrapped.valuationAnalysis;

  return {
    ...unwrapped,
    company: {
      ...evidence.company,
      ...modelCompany,
      name: isNonEmptyString(modelCompany.name) ? modelCompany.name : evidence.company.name,
    },
    sections,
    financialTenYear,
    valuationAnalysis,
  };
}

function buildScoringOutputShape(evidence: EvidenceBundle, strictLength: boolean) {
  const base = {
    company: {
      name: evidence.company.name,
      ticker: evidence.company.ticker ?? "",
      market: evidence.company.market ?? "",
      industry: evidence.company.industry ?? "",
      sector: evidence.company.sector ?? "",
    },
    asOf: evidence.retrievedAt,
    conclusion: "观察",
    oneSentence: "",
    scoreItems20: SCORE_ITEMS_20.map(({ id }) => ({
      id,
      score: 0,
      label: "一般",
      evidence: [],
      deductions: [],
      recentChange: "",
      reason: "",
    })),
    redFlags: [],
    evidence: strictLength ? [] : evidence.evidence,
    financialTenYear: {
      rows: [],
      interpretation: strictLength ? "使用服务端公开财务表。" : "",
    },
    valuationAnalysis: {
      currentPrice: "",
      fairValueRange: "",
      buyRange: "",
      sellReduceRange: "",
      methods: [],
      scenarios: [],
      conclusion: "",
    },
    riskMatrix: [],
    accountRules: {
      companyGrade: "",
      maxPosition: "",
      addCondition: "",
      reduceCondition: "",
      reviewTiming: "",
    },
    disclaimer: "本报告仅用于学习、研究和个人复盘，不构成任何买卖建议。",
  };

  if (strictLength) return base;

  return {
    ...base,
    cqs: 0,
    ias: 0,
    moduleScores: MODULE_WEIGHTS.map(({ id }) => ({
      id,
      score: 0,
      label: "一般",
      summary: "",
      evidence: [],
      concerns: [],
    })),
    sections: Object.fromEntries(REQUIRED_SECTION_KEYS.map((key) => [key, ""])) as ReportSections,
    qualitativeAnalysis: {
      companyHistory: "",
      lifecycle: "",
      businessStructure: "",
      shareholderPosition: "",
    },
  };
}

function buildScoringOutputShapeForPrompt(strictLength: boolean) {
  return buildScoringOutputShape(
    {
      company: { name: "公司名称", ticker: "股票代码", market: "市场", industry: "行业", sector: "板块" },
      retrievedAt: "证据截止时间",
      evidence: [],
      facts: {},
    },
    strictLength,
  );
}

function buildNarrativeOutputShape(keys: FullSectionKey[]) {
  return {
    fullSections: Object.fromEntries(keys.map((key) => [key, ""])),
  };
}

function compactEvidenceReferences(evidence: EvidenceBundle) {
  return {
    company: evidence.company,
    retrievedAt: evidence.retrievedAt,
    evidence: evidence.evidence,
  };
}

function compactReportForNarrative(report: InvestmentReport) {
  return {
    company: report.company,
    asOf: report.asOf,
    conclusion: report.conclusion,
    oneSentence: report.oneSentence,
    cqs: report.cqs,
    ias: report.ias,
    qualitativeBand: report.qualitativeBand,
    summaryDashboard: report.summaryDashboard,
    moduleScores: report.moduleScores.map(({ id, name, weight, score, label, summary, evidence, concerns }) => ({
      id,
      name,
      weight,
      score,
      label,
      summary,
      evidence,
        concerns,
      })),
    redFlags: report.redFlags,
    financialTenYear: report.financialTenYear,
    valuationAnalysis: report.valuationAnalysis,
    riskMatrix: report.riskMatrix,
    accountRules: report.accountRules,
  };
}

function compactScoreItemsForNarrative(report: InvestmentReport, keys: FullSectionKey[]) {
  const relevantItemIds = relevantScoreItemIdsForSections(keys);
  return report.scoreItems20
    .filter((item) => relevantItemIds.has(item.id))
    .map(({ id, title, moduleName, weight, score, label, evidence, deductions, recentChange, reason }) => ({
      id,
      title,
      moduleName,
      weight,
      score,
      label,
      evidence,
      deductions,
      recentChange,
      reason,
    }));
}

function relevantScoreItemIdsForSections(keys: FullSectionKey[]) {
  const ids = new Set<string>();
  for (const key of keys) {
    for (const id of NARRATIVE_SECTION_ITEM_IDS[key]) ids.add(id);
  }
  return ids;
}

function mergeNarrativePayload(scoringReport: InvestmentReport, narrativeJson: unknown, evidence: EvidenceBundle) {
  const unwrapped = unwrapReportPayload(narrativeJson);
  const narrative = isRecord(unwrapped) ? unwrapped : {};
  const fullSections = extractFullSections(narrative);
  const sections = isRecord(narrative.sections) ? narrative.sections : {};

  return prepareReportPayload(
    {
      ...scoringReport,
      sections: {
        ...scoringReport.sections,
        ...sectionsFromFullSections(fullSections),
        ...sections,
      },
      fullSections: {
        ...scoringReport.fullSections,
        ...fullSections,
      },
    },
    evidence,
  );
}

function extractFullSections(value: unknown) {
  const record = isRecord(value) ? value : {};
  return isRecord(record.fullSections) ? record.fullSections : pickFullSectionKeys(record, REQUIRED_FULL_SECTION_KEYS);
}

function pickFullSectionKeys(record: Record<string, unknown>, keys: readonly FullSectionKey[]) {
  return Object.fromEntries(keys.flatMap((key) => (record[key] === undefined ? [] : [[key, record[key]]])));
}

function normalizeScoreItemDetails(value: unknown, expectedIds: string[]): ScoreItemDetail[] {
  const record = isRecord(value) ? value : {};
  const rawItems = Array.isArray(record.scoreItemDetails) ? record.scoreItemDetails.filter(isRecord) : [];
  const details = expectedIds.map((id) => {
    const raw = rawItems.find((item) => item.id === id);
    if (!raw) {
      throw new DeepSeekReportError(MODEL_OUTPUT_INVALID_JSON_MESSAGE, "MODEL_OUTPUT_INVALID_JSON", true);
    }
    const evidence = stringArray(raw.evidence).slice(0, 4);
    const deductions = stringArray(raw.deductions).slice(0, 3);
    const recentChange = isNonEmptyString(raw.recentChange) ? raw.recentChange : "";
    const reason = isNonEmptyString(raw.reason) ? raw.reason : "";
    if (!evidence.length || !deductions.length || !recentChange || !reason) {
      throw new DeepSeekReportError(MODEL_OUTPUT_INVALID_JSON_MESSAGE, "MODEL_OUTPUT_INVALID_JSON", true);
    }
    return { id, evidence, deductions, recentChange, reason };
  });
  return details;
}

function sectionsFromFullSections(fullSections: Record<string, unknown>) {
  return {
    companyOverview: fullSections.companyOverview,
    industry: fullSections.industryTrack,
    businessModel: fullSections.businessModel,
    moat: fullSections.moat,
    governance: fullSections.governance,
    financialQuality: fullSections.financialQuality,
    growth: fullSections.growthInflection,
    valuation: fullSections.valuation,
    risks: fullSections.risks,
    finalConclusion: fullSections.finalConclusion,
  };
}

function withProviderContext(report: InvestmentReport, evidence: EvidenceBundle): InvestmentReport {
  return {
    ...report,
    evidence: mergeEvidence(evidence.evidence, report.evidence),
    company: {
      ...evidence.company,
      ...report.company,
    },
  };
}

function providerFinancialTenYearFromEvidence(evidence: EvidenceBundle) {
  const value = evidence.facts.financialTenYear;
  if (!isRecord(value) || !Array.isArray(value.rows) || value.rows.length === 0) return undefined;
  return value;
}

function providerCurrentPriceFromEvidence(evidence: EvidenceBundle) {
  const quote = asRecord(evidence.facts.quote);
  const price = numericValue(quote?.regularMarketPrice);
  if (price === undefined) return undefined;
  const currency = isNonEmptyString(quote?.currency) ? quote.currency : undefined;
  const date = evidence.retrievedAt.slice(0, 10);
  return `${formatProviderNumber(price)}${currency ? ` ${currency}` : ""}（公开报价，${date}）`;
}

function completeProviderValuationAnalysis(
  evidence: EvidenceBundle,
  modelValuationAnalysis: Record<string, unknown>,
  providerCurrentPrice: string,
) {
  const quote = asRecord(evidence.facts.quote);
  const price = numericValue(quote?.regularMarketPrice);
  if (price === undefined || price <= 0) {
    return {
      ...modelValuationAnalysis,
      currentPrice: providerCurrentPrice,
    };
  }

  const currency = isNonEmptyString(quote?.currency) ? quote.currency : currencyFromMarket(evidence.company.market);
  const currencySuffix = currency ? ` ${currency}` : "";
  const fairLow = price * 0.85;
  const fairHigh = price * 1.15;
  const buyHigh = price * 0.78;
  const sellLow = price * 1.25;
  const methods = stringArray(modelValuationAnalysis.methods);
  const fallbackMethod = "公开报价锚定的安全边际观察区间";
  const needsFallback =
    !hasUsableValuationField(modelValuationAnalysis.fairValueRange) ||
    !hasUsableValuationField(modelValuationAnalysis.buyRange) ||
    !hasUsableValuationField(modelValuationAnalysis.sellReduceRange);

  return {
    ...modelValuationAnalysis,
    currentPrice: providerCurrentPrice,
    fairValueRange: hasUsableValuationField(modelValuationAnalysis.fairValueRange)
      ? modelValuationAnalysis.fairValueRange
      : `${formatProviderNumber(fairLow)}-${formatProviderNumber(fairHigh)}${currencySuffix}（公开报价锚定观察区间）`,
    buyRange: hasUsableValuationField(modelValuationAnalysis.buyRange)
      ? modelValuationAnalysis.buyRange
      : `低于 ${formatProviderNumber(buyHigh)}${currencySuffix}（相对公开报价留出约 22% 安全边际）`,
    sellReduceRange: hasUsableValuationField(modelValuationAnalysis.sellReduceRange)
      ? modelValuationAnalysis.sellReduceRange
      : `高于 ${formatProviderNumber(sellLow)}${currencySuffix}（相对公开报价溢价约 25%）`,
    methods: needsFallback && !methods.includes(fallbackMethod) ? [...methods, fallbackMethod] : modelValuationAnalysis.methods,
    conclusion: hasUsableValuationField(modelValuationAnalysis.conclusion)
      ? modelValuationAnalysis.conclusion
      : `公开报价为 ${providerCurrentPrice}；估值区间采用报价锚定观察口径，需结合后续财报、现金流和同业估值继续复核。`,
  };
}

function hasUsableValuationField(value: unknown) {
  if (!isNonEmptyString(value)) return false;
  return !/数据不足|待验证|不可用|缺失|无法|未获取|未计算|N\/A/.test(value);
}

function currencyFromMarket(market: unknown) {
  if (!isNonEmptyString(market)) return undefined;
  if (market.includes("港")) return "HKD";
  if (market.includes("沪") || market.includes("深") || market.includes("A")) return "CNY";
  if (market.includes("美") || market.toUpperCase().includes("US")) return "USD";
  return undefined;
}

function isRetryableModelOutputError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as Record<string, unknown>).code;
  return code === "MODEL_OUTPUT_LENGTH" || code === "MODEL_OUTPUT_INVALID_JSON" || code === "DEEPSEEK_NETWORK";
}

function normalizeSections(rawSections: unknown, topLevel: Record<string, unknown>, evidence: EvidenceBundle) {
  const sections = isRecord(rawSections) ? rawSections : {};
  return Object.fromEntries(
    REQUIRED_SECTION_KEYS.map((key) => {
      const value = sections[key] ?? topLevel[key];
      return [key, isNonEmptyString(value) ? value : fallbackSection(key, evidence)];
    }),
  ) as ReportSections;
}

function fallbackSection(key: keyof ReportSections, evidence: EvidenceBundle) {
  const label: Record<keyof ReportSections, string> = {
    companyOverview: "公司概况",
    industry: "行业与细分赛道",
    businessModel: "商业模式与价值链",
    moat: "竞争优势与护城河",
    governance: "管理层、治理结构与股东文化",
    financialQuality: "财务质量与现金流",
    growth: "成长空间与重大转折",
    valuation: "估值与安全边际",
    risks: "风险清单与反证条件",
    finalConclusion: "最终投资结论",
  };
  return `${evidence.company.name} 的「${label[key]}」章节未由模型按模板提供完整段落；当前仅能依据已列示的公开证据继续人工复核。`;
}

function unwrapReportPayload(value: unknown) {
  if (!isRecord(value)) return value;
  if (isRecord(value.report)) return value.report;
  if (isRecord(value.data) && isRecord(value.data.report)) return value.data.report;
  return value;
}

function parseJsonObject(content: string) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("DeepSeek response did not contain JSON");
    try {
      return JSON.parse(jsonrepair(match[0]));
    } catch (error) {
      throw new Error(`DeepSeek response did not contain valid JSON: ${error instanceof Error ? error.message : "parse failed"}`, {
        cause: error,
      });
    }
  }
}

function assertScoringPayloadComplete(value: unknown) {
  const payload = unwrapReportPayload(value);
  if (!isRecord(payload) || !Array.isArray(payload.scoreItems20)) {
    throw new DeepSeekReportError(MODEL_OUTPUT_INVALID_JSON_MESSAGE, "MODEL_OUTPUT_INVALID_JSON", true);
  }
  const rawItems = payload.scoreItems20.filter(isRecord);
  const itemIds = new Set(rawItems.map((item) => (typeof item.id === "string" ? item.id : "")));
  const hasAllItems = SCORE_ITEMS_20.every((item) => itemIds.has(item.id));
  const hasNumericScores = rawItems.every((item) => typeof item.score === "number" && Number.isFinite(item.score));
  if (rawItems.length < SCORE_ITEMS_20.length || !hasAllItems || !hasNumericScores) {
    throw new DeepSeekReportError(MODEL_OUTPUT_INVALID_JSON_MESSAGE, "MODEL_OUTPUT_INVALID_JSON", true);
  }
}

function mergeEvidence(providerEvidence: InvestmentReport["evidence"], modelEvidence: InvestmentReport["evidence"]) {
  const key = new Set<string>();
  const merged = [...providerEvidence, ...modelEvidence].filter((item) => {
    const id = `${item.source}:${item.url}:${item.title}`;
    if (key.has(id)) return false;
    key.add(id);
    return true;
  });
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isNonEmptyString).map(String) : [];
}

function numericValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatProviderNumber(value: number) {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

