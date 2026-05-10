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

export const MODEL_OUTPUT_LENGTH_MESSAGE = "模型输出超过长度限制，本次报告未完成，请重试。";

export class DeepSeekReportError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = true,
  ) {
    super(message);
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

  const scoringJson = await requestDeepSeekJson({
    apiKey,
    fetchImpl,
    maxTokens: 12000,
    messages: [
      {
        role: "system",
        content: buildScoringSystemPrompt(language),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "Generate the structured scoring JSON only. Do not write the long narrative fullSections in this pass.",
            moduleWeights: MODULE_WEIGHTS,
            scoreItems20: SCORE_ITEMS_20,
            expectedOutputShape: buildScoringOutputShape(evidence),
            evidence: compactEvidenceForPrompt(evidence),
          },
          null,
          2,
        ),
      },
    ],
  });

  const scoringReport = validateReportPayload(prepareReportPayload(scoringJson, evidence));
  onProgress?.({
    stage: "deepseek_narrative",
    label: "生成完整正文",
    detail: "结构化评分已完成，正在生成一页结论和完整中文报告章节。",
    percent: 76,
  });
  const narrativeJson = await requestDeepSeekJson({
    apiKey,
    fetchImpl,
    maxTokens: 10000,
    messages: [
      {
        role: "system",
        content: buildNarrativeSystemPrompt(language),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "Generate the complete Chinese narrative sections for the already validated scoring report.",
            expectedOutputShape: buildNarrativeOutputShape(),
            scoringReport: compactReportForNarrative(scoringReport),
            evidence: compactEvidenceForPrompt(evidence),
          },
          null,
          2,
        ),
      },
    ],
  });

  const report = validateReportPayload(mergeNarrativePayload(scoringReport, narrativeJson, evidence));
  return withProviderContext(report, evidence);
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

  return parseJsonObject(content);
}

function buildScoringSystemPrompt(language: "zh-CN" | "en") {
  return `
You are CSTD Alpha, a cautious long-term fundamental investment research assistant.
Return ONLY one valid JSON object. Do not wrap it in Markdown.
Language: ${language === "zh-CN" ? "Simplified Chinese" : "English"}.

Rules:
- Use only the evidence bundle and clearly mark missing data. Do not invent facts.
- This is research, not investment advice.
- Score harshly: ordinary companies should not easily exceed 70.
- Bad companies must receive low scores. Do not give a polite high score when cash flow, leverage, governance, growth, or valuation evidence is poor.
- Every score must be specific, evidence-based, and non-ambiguous. Use labels 极好 / 好 / 一般 / 差.
- Return the report object at the JSON top level. Do not nest it under "report" or "data".
- Include top-level company: { name, ticker, market, industry, sector }. company.name is mandatory.
- Calculate 公司质量评分（CQS）from company quality modules. Calculate 投资吸引力评分（IAS）after valuation and risk caps. In all human-readable report text, use the Chinese names first, with abbreviations only in parentheses.
- Use these exact section keys: companyOverview, industry, businessModel, moat, governance, financialQuality, growth, valuation, risks, finalConclusion.
- Include all 10 moduleScores with ids matching the provided moduleWeights.
- Include all 20 scoreItems20 with ids matching the provided scoreItems20 definitions. Each item needs score, label, evidence, deductions, recentChange, reason.
- Do not include fullSections in this pass. Keep regular sections concise; the full narrative is generated in a separate pass.
- Include financialTenYear.rows for available years and metrics. If a value is unavailable, write 数据不足, not a fake number.
- Include valuationAnalysis with currentPrice, fairValueRange, buyRange, sellReduceRange, methods, scenarios, conclusion.
- Include evidence with source URLs and retrievedAt timestamps, maximum 8 items.
- Conclusions must be one of: 买入, 加仓, 持有, 观察, 减仓, 卖出, 回避.
`;
}

function buildNarrativeSystemPrompt(language: "zh-CN" | "en") {
  return `
You are CSTD Alpha, writing the final narrative section of a Chinese company research report.
Return ONLY one valid JSON object. Do not wrap it in Markdown.
Language: ${language === "zh-CN" ? "Simplified Chinese" : "English"}.

Rules:
- Return only { "fullSections": { ... } } at the JSON top level.
- Use these exact fullSections keys: onePageConclusion, companyOverview, industryTrack, businessModel, moat, governance, financialQuality, growthInflection, valuation, risks, finalConclusion, accountRules.
- Base the writing only on the validated scoring report and evidence bundle. Do not invent facts.
- Write direct conclusions. If evidence is weak, say 数据不足 and explain the impact.
- Each section should be complete enough for a Word report, but avoid unnecessary repetition so the JSON response is not truncated.
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

  return {
    ...unwrapped,
    company: {
      ...evidence.company,
      ...modelCompany,
      name: isNonEmptyString(modelCompany.name) ? modelCompany.name : evidence.company.name,
    },
    sections,
  };
}

function buildScoringOutputShape(evidence: EvidenceBundle) {
  return {
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
    cqs: 0,
    ias: 0,
    moduleScores: MODULE_WEIGHTS.map((module) => ({
      id: module.id,
      name: module.name,
      weight: module.weight,
      score: 0,
      weightedScore: 0,
      summary: "",
      evidence: [],
      concerns: [],
    })),
    scoreItems20: SCORE_ITEMS_20.map((item) => ({
      ...item,
      score: 0,
      label: "一般",
      evidence: [],
      deductions: [],
      recentChange: "",
      reason: "",
    })),
    redFlags: [],
    evidence: evidence.evidence,
    sections: Object.fromEntries(REQUIRED_SECTION_KEYS.map((key) => [key, ""])) as ReportSections,
    qualitativeAnalysis: {
      companyHistory: "",
      lifecycle: "",
      businessStructure: "",
      shareholderPosition: "",
    },
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
}

function buildNarrativeOutputShape() {
  return {
    fullSections: Object.fromEntries(REQUIRED_FULL_SECTION_KEYS.map((key) => [key, ""])),
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
  const fullSections = isRecord(narrative.fullSections) ? narrative.fullSections : pickFullSectionKeys(narrative);
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

function pickFullSectionKeys(record: Record<string, unknown>) {
  return Object.fromEntries(REQUIRED_FULL_SECTION_KEYS.flatMap((key) => (record[key] === undefined ? [] : [[key, record[key]]])));
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
