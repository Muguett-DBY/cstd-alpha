import {
  validateReportPayload,
  type InvestmentReport,
  MODULE_WEIGHTS,
  REQUIRED_SECTION_KEYS,
  REQUIRED_FULL_SECTION_KEYS,
  SCORE_ITEMS_20,
  type ReportSections,
} from "../../src/shared/report";
import { jsonrepair } from "jsonrepair";
import type { EvidenceBundle } from "./providers";

type FetchLike = typeof fetch;
type FullSectionKey = (typeof REQUIRED_FULL_SECTION_KEYS)[number];

export const MODEL_OUTPUT_LENGTH_MESSAGE = "模型输出超过长度限制，本次报告未完成，请重试。";
export const MODEL_OUTPUT_INVALID_JSON_MESSAGE = "模型返回的 JSON 不完整，本次报告未完成，请重试。";

const NARRATIVE_SECTION_BATCHES: FullSectionKey[][] = [
  ["onePageConclusion", "companyOverview", "industryTrack"],
  ["businessModel", "moat", "governance"],
  ["financialQuality", "growthInflection", "valuation"],
  ["risks", "finalConclusion", "accountRules"],
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
  apiKey: string;
  evidence: EvidenceBundle;
  language?: "zh-CN" | "en";
  fetchImpl?: FetchLike;
  onProgress?: (progress: { stage: string; label: string; detail: string; percent: number }) => void;
};

export async function callDeepSeekReport({
  apiKey,
  evidence,
  language = "zh-CN",
  fetchImpl = fetch,
  onProgress,
}: DeepSeekInput): Promise<InvestmentReport> {
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured");

  const scoringJson = await requestScoringJson({
    apiKey,
    fetchImpl,
    language,
    evidence,
    onProgress,
  });

  const scoringReport = validateReportPayload(prepareReportPayload(scoringJson, evidence));
  const enrichedReport = validateReportPayload(
    prepareReportPayload(
      {
        ...scoringReport,
        scoreItems20: await requestScoreItemDetails({
          apiKey,
          fetchImpl,
          language,
          scoringReport,
          evidence,
          onProgress,
        }),
      },
      evidence,
    ),
  );
  const fullSections = await requestNarrativeSections({
    apiKey,
    fetchImpl,
    language,
    scoringReport: enrichedReport,
    evidence,
    onProgress,
  });

  const report = validateReportPayload(mergeNarrativePayload(enrichedReport, { fullSections }, evidence));
  return withProviderContext(report, evidence);
}

async function requestScoringJson({
  apiKey,
  fetchImpl,
  language,
  evidence,
  onProgress,
}: {
  apiKey: string;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  evidence: EvidenceBundle;
  onProgress?: DeepSeekInput["onProgress"];
}) {
  try {
    return await requestScoringJsonOnce({ apiKey, fetchImpl, language, evidence, strictLength: false });
  } catch (error) {
    if (!isRetryableModelOutputError(error)) throw error;
    onProgress?.({
      stage: "deepseek_scoring_retry",
      label: "评分结构重试",
      detail: "模型第一次返回的评分 JSON 不完整，正在用更紧凑结构重试。",
      percent: 64,
    });
    return requestScoringJsonOnce({ apiKey, fetchImpl, language, evidence, strictLength: true });
  }
}

async function requestScoringJsonOnce({
  apiKey,
  fetchImpl,
  language,
  evidence,
  strictLength,
}: {
  apiKey: string;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  evidence: EvidenceBundle;
  strictLength: boolean;
}) {
  const scoringJson = await requestDeepSeekJson({
    apiKey,
    fetchImpl,
    maxTokens: 18000,
    messages: [
      {
        role: "system",
        content: buildScoringSystemPrompt(language, strictLength),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: strictLength
              ? "Generate the minimum complete structured scoring JSON. Keep all text very short."
              : "Generate the structured scoring JSON only. Do not write the long narrative fullSections in this pass.",
            moduleWeights: strictLength ? undefined : MODULE_WEIGHTS,
            scoreItems20: SCORE_ITEMS_20.map(({ id, title, moduleId, weight }) => ({ id, title, moduleId, weight })),
            expectedOutputShape: buildScoringOutputShape(evidence, strictLength),
            evidence: compactEvidenceForPrompt(evidence),
          },
          null,
          2,
        ),
      },
    ],
  });
  assertScoringPayloadComplete(scoringJson);
  return scoringJson;
}

async function requestNarrativeSections({
  apiKey,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  onProgress,
}: {
  apiKey: string;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  onProgress?: DeepSeekInput["onProgress"];
}) {
  const fullSections: Record<string, unknown> = {};
  for (const [index, keys] of NARRATIVE_SECTION_BATCHES.entries()) {
    onProgress?.({
      stage: `deepseek_narrative_${index + 1}`,
      label: "生成完整正文",
      detail: `正在生成${keys.map((key) => FULL_SECTION_LABELS[key]).join("、")}。`,
      percent: 70 + index * 5,
    });
    Object.assign(
      fullSections,
      await requestNarrativeBatch({
        apiKey,
        fetchImpl,
        language,
        scoringReport,
        evidence,
        keys,
      }),
    );
  }
  return fullSections;
}

async function requestScoreItemDetails({
  apiKey,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  onProgress,
}: {
  apiKey: string;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  onProgress?: DeepSeekInput["onProgress"];
}) {
  const details: Record<string, ScoreItemDetail> = {};
  for (const [index, itemIds] of SCORE_ITEM_DETAIL_BATCHES.entries()) {
    onProgress?.({
      stage: `deepseek_score_detail_${index + 1}`,
      label: "补全评分证据",
      detail: `正在补全第 ${index * 5 + 1}-${index * 5 + itemIds.length} 项评分的证据、扣分点和最近变化。`,
      percent: 64 + index,
    });
    const batchDetails = await requestScoreItemDetailBatch({
      apiKey,
      fetchImpl,
      language,
      scoringReport,
      evidence,
      itemIds,
    });
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

type ScoreItemDetail = {
  id: string;
  evidence: string[];
  deductions: string[];
  recentChange: string;
  reason: string;
};

function fallbackScoreItemDetail(item: InvestmentReport["scoreItems20"][number]): ScoreItemDetail {
  const evidence = stringArray(item.evidence);
  const deductions = stringArray(item.deductions);
  return {
    id: item.id,
    evidence: evidence.length ? evidence : ["沿用评分阶段的公开证据；本项详细补全因模型输出过长未完成。"],
    deductions: deductions.length ? deductions : ["需在后续复核中补充更细的扣分依据。"],
    recentChange: isNonEmptyString(item.recentChange) ? item.recentChange : "最近 12 个月变化沿用评分阶段判断，待后续补充细节。",
    reason: isNonEmptyString(item.reason) ? item.reason : "该项沿用结构化评分阶段的结论；详细证据补全过程被截断，未作为额外事实来源。",
  };
}

async function requestScoreItemDetailBatch({
  apiKey,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  itemIds,
}: {
  apiKey: string;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  itemIds: string[];
}): Promise<ScoreItemDetail[]> {
  try {
    return await requestScoreItemDetailBatchOnce({ apiKey, fetchImpl, language, scoringReport, evidence, itemIds, strictLength: false });
  } catch (error) {
    if (!isRetryableModelOutputError(error)) throw error;
    try {
      return await requestScoreItemDetailBatchOnce({ apiKey, fetchImpl, language, scoringReport, evidence, itemIds, strictLength: true });
    } catch (retryError) {
      if (!isRetryableModelOutputError(retryError) || itemIds.length <= 1) throw retryError;
      return requestScoreItemDetailsIndividually({
        apiKey,
        fetchImpl,
        language,
        scoringReport,
        evidence,
        itemIds,
      });
    }
  }
}

async function requestScoreItemDetailsIndividually({
  apiKey,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  itemIds,
}: {
  apiKey: string;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  itemIds: string[];
}): Promise<ScoreItemDetail[]> {
  const details: ScoreItemDetail[] = [];
  for (const id of itemIds) {
    try {
      details.push(
        ...(await requestScoreItemDetailBatchOnce({
          apiKey,
          fetchImpl,
          language,
          scoringReport,
          evidence,
          itemIds: [id],
          strictLength: true,
        })),
      );
    } catch (error) {
      if (!isRetryableModelOutputError(error)) throw error;
      const existingItem = scoringReport.scoreItems20.find((item) => item.id === id);
      if (!existingItem) throw error;
      details.push(fallbackScoreItemDetail(existingItem));
    }
  }
  return details;
}

async function requestScoreItemDetailBatchOnce({
  apiKey,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  itemIds,
  strictLength,
}: {
  apiKey: string;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  itemIds: string[];
  strictLength: boolean;
}): Promise<ScoreItemDetail[]> {
  const detailJson = await requestDeepSeekJson({
    apiKey,
    fetchImpl,
    maxTokens: strictLength ? 7000 : 9500,
    messages: [
      {
        role: "system",
        content: buildScoreItemDetailSystemPrompt(language, strictLength),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "Enrich only the requested score item text. Do not change numeric scores.",
            requestedItemIds: itemIds,
            expectedOutputShape: {
              scoreItemDetails: itemIds.map((id) => ({
                id,
                evidence: ["2-4 条最新公开证据，写明财报期/行情时间/数据来源"],
                deductions: ["1-3 条明确扣分点"],
                recentChange: "最近 12 个月变化及对分数影响",
                reason: "120-220 字中文评分理由",
              })),
            },
            scoreItems: scoringReport.scoreItems20
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
            financialTenYear: scoringReport.financialTenYear,
            valuationAnalysis: scoringReport.valuationAnalysis,
            evidence: compactEvidenceForPrompt(evidence),
          },
          null,
          2,
        ),
      },
    ],
  });
  return normalizeScoreItemDetails(detailJson, itemIds);
}

async function requestNarrativeBatch({
  apiKey,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  keys,
}: {
  apiKey: string;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  keys: FullSectionKey[];
}) {
  try {
    return await requestNarrativeBatchOnce({ apiKey, fetchImpl, language, scoringReport, evidence, keys, strictLength: false });
  } catch (error) {
    if (!isRetryableModelOutputError(error)) throw error;
    return requestNarrativeBatchOnce({ apiKey, fetchImpl, language, scoringReport, evidence, keys, strictLength: true });
  }
}

async function requestNarrativeBatchOnce({
  apiKey,
  fetchImpl,
  language,
  scoringReport,
  evidence,
  keys,
  strictLength,
}: {
  apiKey: string;
  fetchImpl: FetchLike;
  language: "zh-CN" | "en";
  scoringReport: InvestmentReport;
  evidence: EvidenceBundle;
  keys: FullSectionKey[];
  strictLength: boolean;
}) {
  const narrativeJson = await requestDeepSeekJson({
    apiKey,
    fetchImpl,
    maxTokens: strictLength ? 3500 : 5000,
    messages: [
      {
        role: "system",
        content: buildNarrativeSystemPrompt(language, keys, strictLength),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "Generate only the requested fullSections keys for the already validated scoring report.",
            requestedFullSectionKeys: keys,
            expectedOutputShape: buildNarrativeOutputShape(keys),
            scoringReport: compactReportForNarrative(scoringReport),
            evidence: compactEvidenceForPrompt(evidence),
          },
          null,
          2,
        ),
      },
    ],
  });
  return pickFullSectionKeys(extractFullSections(narrativeJson), keys);
}

async function requestDeepSeekJson({
  apiKey,
  fetchImpl,
  messages,
  maxTokens,
}: {
  apiKey: string;
  fetchImpl: FetchLike;
  messages: Array<{ role: "system" | "user"; content: string }>;
  maxTokens: number;
}) {
  const response = await fetchImpl("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      reasoning_effort: "max",
      thinking: { type: "enabled" },
      response_format: { type: "json_object" },
      stream: false,
      max_tokens: maxTokens,
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DeepSeek request failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
  };
  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  if (choice?.finish_reason === "length" || !content?.trim()) throw new DeepSeekReportError(MODEL_OUTPUT_LENGTH_MESSAGE, "MODEL_OUTPUT_LENGTH", true);

  try {
    return parseJsonObject(content);
  } catch (error) {
    throw new DeepSeekReportError(MODEL_OUTPUT_INVALID_JSON_MESSAGE, "MODEL_OUTPUT_INVALID_JSON", true, { cause: error });
  }
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
- Include financialTenYear.rows for available years and metrics, maximum 8 metrics. If a value is unavailable, write 数据不足, not a fake number.
- If the evidence bundle contains a normalized financialTenYear table, use those metric names and values as authoritative.
- Include valuationAnalysis with currentPrice, fairValueRange, buyRange, sellReduceRange, methods, scenarios, conclusion.
- Include riskMatrix with at most 6 risks.
- Include evidence with source URLs and retrievedAt timestamps, maximum 8 items.
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
- Each requested item must include 2-4 concrete evidence bullets, 1-3 direct deduction bullets, a recentChange sentence, and a reason.
- Evidence bullets should mention the latest available period, source freshness, metric name, or valuation snapshot when possible.
- Reasons must be direct and non-ambiguous: bad evidence means low score; do not write polite neutral language for weak companies.
- ${strictLength ? "Strict retry mode: reason 80-140 Chinese characters; evidence bullets short." : "Reason should be 120-220 Chinese characters, with enough detail for a deep report."}
`;
}

function buildNarrativeSystemPrompt(language: "zh-CN" | "en", keys: FullSectionKey[], strictLength: boolean) {
  return `
You are CSTD Alpha, writing the final narrative section of a Chinese company research report.
Return ONLY one valid JSON object. Do not wrap it in Markdown.
Language: ${language === "zh-CN" ? "Simplified Chinese" : "English"}.

Rules:
- Return only { "fullSections": { ... } } at the JSON top level.
- Use only these fullSections keys in this batch: ${keys.join(", ")}.
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
        "incomeRows",
        "cashflowRows",
        "balanceRows",
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
      eastmoney: pick(asRecord(evidence.facts.eastmoney), ["quote", "incomeRows", "cashflowRows", "balanceRows"]),
      sec: pick(asRecord(evidence.facts.sec), ["cik", "title", "companyFacts", "latestAnnual", "latestQuarter", "normalizedFinancialTenYear", "summaryFinancialData"]),
      financialTenYear: evidence.facts.financialTenYear,
    },
  };
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

  return {
    ...unwrapped,
    company: {
      ...evidence.company,
      ...modelCompany,
      name: isNonEmptyString(modelCompany.name) ? modelCompany.name : evidence.company.name,
    },
    sections,
    financialTenYear,
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
    evidence: evidence.evidence,
    financialTenYear: {
      rows: [],
      interpretation: "",
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

function buildNarrativeOutputShape(keys: FullSectionKey[]) {
  return {
    fullSections: Object.fromEntries(keys.map((key) => [key, ""])),
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
    scoreItems20: report.scoreItems20.map(({ id, title, moduleName, weight, score, label, evidence, deductions, recentChange, reason }) => ({
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
    redFlags: report.redFlags,
    financialTenYear: report.financialTenYear,
    valuationAnalysis: report.valuationAnalysis,
    riskMatrix: report.riskMatrix,
    accountRules: report.accountRules,
  };
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

function isRetryableModelOutputError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as Record<string, unknown>).code;
  return code === "MODEL_OUTPUT_LENGTH" || code === "MODEL_OUTPUT_INVALID_JSON";
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
