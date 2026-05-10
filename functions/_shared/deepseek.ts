import {
  emptyReport,
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

type DeepSeekInput = {
  apiKey: string;
  evidence: EvidenceBundle;
  language?: "zh-CN" | "en";
  fetchImpl?: FetchLike;
};

export async function callDeepSeekReport({
  apiKey,
  evidence,
  language = "zh-CN",
  fetchImpl = fetch,
}: DeepSeekInput): Promise<InvestmentReport> {
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured");

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
      max_tokens: 18000,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(language),
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              task: "Generate a complete company scoring report from this evidence bundle.",
              moduleWeights: MODULE_WEIGHTS,
              expectedOutputShape: buildExpectedOutputShape(evidence),
              evidence: compactEvidenceForPrompt(evidence),
            },
            null,
            2,
          ),
        },
      ],
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
  if (!content) {
    return emptyReport(evidence.company.name, `DeepSeek returned an empty final response. finish_reason=${choice?.finish_reason ?? "unknown"}`);
  }

  const parsed = parseJsonObject(content);
  const report = validateReportPayload(prepareReportPayload(parsed, evidence));
  return {
    ...report,
    evidence: mergeEvidence(evidence.evidence, report.evidence),
    company: {
      ...evidence.company,
      ...report.company,
    },
  };
}

function buildSystemPrompt(language: "zh-CN" | "en") {
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
- Calculate CQS from company quality modules. Calculate IAS after valuation and risk caps.
- Use these exact section keys: companyOverview, industry, businessModel, moat, governance, financialQuality, growth, valuation, risks, finalConclusion.
- Include all 10 moduleScores with ids matching the provided moduleWeights.
- Include all 20 scoreItems20 with ids matching the provided scoreItems20 definitions. Each item needs score, label, evidence, deductions, recentChange, reason.
- Include fullSections with these exact keys: onePageConclusion, companyOverview, industryTrack, businessModel, moat, governance, financialQuality, growthInflection, valuation, risks, finalConclusion, accountRules.
- Write a complete deep Chinese report. Do not compress the report into a short card. Each major fullSections paragraph should contain concrete evidence, judgment, and deduction logic.
- Include financialTenYear.rows for available years and metrics. If a value is unavailable, write 数据不足, not a fake number.
- Include valuationAnalysis with currentPrice, fairValueRange, buyRange, sellReduceRange, methods, scenarios, conclusion.
- Include evidence with source URLs and retrievedAt timestamps, maximum 8 items.
- Conclusions must be one of: 买入, 加仓, 持有, 观察, 减仓, 卖出, 回避.
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

function buildExpectedOutputShape(evidence: EvidenceBundle) {
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
    fullSections: Object.fromEntries(REQUIRED_FULL_SECTION_KEYS.map((key) => [key, ""])),
    disclaimer: "本报告仅用于学习、研究和个人复盘，不构成任何买卖建议。",
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
