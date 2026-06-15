import { buildDeepSeekRequestBody, cacheStableUserContent, withCacheProtocol, type DeepSeekMessage } from "./deepseek-cache";
import { buildDeepSeekFallbackRoutes } from "./opencode-go";
import { claimValuationRun, completeValuationRun, failValuationRun, readValuationRunForWorker, type ValuationRunRow } from "./research-workbench-db";
import { computeCyclicalMidCycle, computeFinancialDdm, computeOperatingDcf } from "./valuation-engine";
import type { AssistantEnv } from "./assistant-db";
import type { ValuationResult } from "../../src/shared/valuation";

type ValuationRunnerEnv = AssistantEnv & {
  REPORT_LIBRARY_DB: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

type AiAssumptionPayload = {
  currency?: string;
  confidence?: number;
  operating?: {
    baseRevenue?: number;
    sharesOutstanding?: number;
    netDebt?: number;
    revenueGrowth?: Triple;
    ebitMargin?: Triple;
    taxRate?: number;
    depreciationRate?: number;
    capexRate?: Triple;
    workingCapitalRate?: number;
    discountRate?: Triple;
    terminalGrowthRate?: Triple;
    peerEvEbitda?: Triple;
  };
  financial?: {
    bookValue?: number;
    sharesOutstanding?: number;
    roe?: Triple;
    payoutRatio?: Triple;
    costOfEquity?: Triple;
    terminalGrowthRate?: Triple;
  };
  cyclical?: {
    midCycleEbitda?: Triple;
    normalizedNetCash?: number;
    sharesOutstanding?: number;
    replacementAssetValue?: Triple;
    evEbitdaMultiple?: Triple;
  };
};

type Triple = {
  low?: number;
  base?: number;
  high?: number;
};

export type ValuationAnchors = {
  baseRevenue?: number;
  sharesOutstanding?: number;
  bookValue?: number;
  netDebt?: number;
};

export async function processValuationRun(env: ValuationRunnerEnv, valuationRunId: string) {
  const run = await readValuationRunForWorker(env.REPORT_LIBRARY_DB, valuationRunId);
  if (!run || run.status === "completed") return;
  try {
    if (!await claimValuationRun(env.REPORT_LIBRARY_DB, valuationRunId)) return;
    const evidencePackage = await readValuationEvidencePackage(env, run);
    const evidence = prepareValuationEvidenceContext(evidencePackage);
    const assumptions = await generateValuationAssumptions(env, run, evidence.promptText);
    const anchors = evidence.anchors;
    const result = computeValuationFromAssumptions(run, assumptions, anchors);
    const objectKey = `valuation/v1/${encodeURIComponent(run.user_key)}/${valuationRunId}.json`;
    if (env.REPORT_LIBRARY_BUCKET) {
      await env.REPORT_LIBRARY_BUCKET.put(objectKey, JSON.stringify({ run, evidence, anchors, assumptions, result, createdAt: new Date().toISOString() }), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
    }
    await completeValuationRun(env.REPORT_LIBRARY_DB, { id: valuationRunId, result, objectKey });
  } catch (error) {
    await failValuationRun(env.REPORT_LIBRARY_DB, valuationRunId, error);
    throw error;
  }
}

export function computeValuationFromAssumptions(
  run: Pick<ValuationRunRow, "archetype" | "method" | "currency" | "evidence_hash">,
  payload: AiAssumptionPayload,
  anchors: ValuationAnchors = {},
): ValuationResult {
  const merged = mergeAnchorsIntoAssumptions(payload, anchors);
  validateValuationInputs(run, merged);
  const currency = merged.currency || run.currency || "CNY";
  const asOf = new Date().toISOString().slice(0, 10);
  if (run.method === "ddm_residual_income") {
    const financial = merged.financial ?? {};
    return markGroundedMethodology(computeFinancialDdm({
      currency,
      asOf,
      bookValue: positiveNumber(financial.bookValue, 0),
      sharesOutstanding: positiveNumber(financial.sharesOutstanding, 0),
      roe: normalizeTriple(financial.roe, { low: 0.07, base: 0.1, high: 0.13 }),
      payoutRatio: normalizeTriple(financial.payoutRatio, { low: 0.25, base: 0.35, high: 0.45 }),
      costOfEquity: normalizeTriple(financial.costOfEquity, { low: 0.085, base: 0.1, high: 0.115 }),
      terminalGrowthRate: normalizeTriple(financial.terminalGrowthRate, { low: 0.005, base: 0.015, high: 0.025 }),
      evidenceHash: run.evidence_hash ?? undefined,
    }, run.archetype === "insurance" ? "insurance" : "bank"));
  }
  if (run.method === "mid_cycle_nav") {
    const cyclical = merged.cyclical ?? {};
    return markGroundedMethodology(computeCyclicalMidCycle({
      currency,
      asOf,
      midCycleEbitda: normalizeTriple(cyclical.midCycleEbitda, { low: 60, base: 100, high: 140 }),
      normalizedNetCash: numberValue(cyclical.normalizedNetCash, 0),
      sharesOutstanding: positiveNumber(cyclical.sharesOutstanding, 0),
      replacementAssetValue: cyclical.replacementAssetValue ? normalizeTriple(cyclical.replacementAssetValue, { low: 300, base: 400, high: 500 }) : undefined,
      evEbitdaMultiple: normalizeTriple(cyclical.evEbitdaMultiple, { low: 4, base: 6, high: 8 }),
      evidenceHash: run.evidence_hash ?? undefined,
    }));
  }
  const operating = merged.operating ?? {};
  return markGroundedMethodology(computeOperatingDcf({
    currency,
    asOf,
    baseRevenue: positiveNumber(operating.baseRevenue, 0),
    sharesOutstanding: positiveNumber(operating.sharesOutstanding, 0),
    netDebt: numberValue(operating.netDebt, 0),
    revenueGrowth: normalizeTriple(operating.revenueGrowth, { low: 0.03, base: 0.07, high: 0.11 }),
    ebitMargin: normalizeTriple(operating.ebitMargin, { low: 0.08, base: 0.13, high: 0.18 }),
    taxRate: rateValue(operating.taxRate, 0.2),
    depreciationRate: rateValue(operating.depreciationRate, 0.035),
    capexRate: normalizeTriple(operating.capexRate, { low: 0.04, base: 0.06, high: 0.08 }),
    workingCapitalRate: rateValue(operating.workingCapitalRate, 0.015),
    discountRate: normalizeTriple(operating.discountRate, { low: 0.085, base: 0.1, high: 0.115 }),
    terminalGrowthRate: normalizeTriple(operating.terminalGrowthRate, { low: 0.015, base: 0.025, high: 0.035 }),
    peerEvEbitda: operating.peerEvEbitda ? normalizeTriple(operating.peerEvEbitda, { low: 10, base: 14, high: 18 }) : undefined,
    evidenceHash: run.evidence_hash ?? undefined,
  }));
}

function markGroundedMethodology(result: ValuationResult): ValuationResult {
  return { ...result, methodologyVersion: 2 };
}

export function extractValuationAnchors(evidenceText: string): ValuationAnchors {
  try {
    const pkg = JSON.parse(evidenceText) as Record<string, unknown>;
    const stableFacts = recordValue(parseMaybeJson(pkg.stableFacts));
    const freshSignals = recordValue(parseMaybeJson(pkg.freshSignals));
    const anchors: ValuationAnchors = {};

    const financialTenYear = recordValue(stableFacts?.financialTenYear);
    const rows = Array.isArray(financialTenYear?.rows) ? financialTenYear.rows.map(recordValue).filter(Boolean) as Record<string, unknown>[] : [];
    const revenue = latestAnnualMetricValue(rows, ["营业收入", "营收"]);
    const bookValue = latestAnnualMetricValue(rows, ["归属于母公司股东权益", "股东权益", "所有者权益"]);
    const debt = latestAnnualMetricValue(rows, ["总债务", "有息负债"]);
    const cash = latestAnnualMetricValue(rows, ["货币资金", "现金及现金等价物"]);
    if (revenue !== undefined && revenue > 0) anchors.baseRevenue = revenue;
    if (bookValue !== undefined && bookValue > 0) anchors.bookValue = bookValue;
    if (debt !== undefined || cash !== undefined) {
      anchors.netDebt = (debt ?? 0) - (cash ?? 0);
    }

    const quote = recordValue(freshSignals?.quote);
    if (quote) {
      const marketCap = rawNumber(quote.marketCap);
      const price = rawNumber(quote.regularMarketPrice);
      if (marketCap !== undefined && price !== undefined && price > 0 && marketCap > 0) {
        const totalShares = marketCap / price;
        anchors.sharesOutstanding = totalShares / 100_000_000;
      }
    }

    return anchors;
  } catch {
    return {};
  }
}

export function prepareValuationEvidenceContext(evidenceText: string): { anchors: ValuationAnchors; promptText: string } {
  const anchors = extractValuationAnchors(evidenceText);
  try {
    const pkg = JSON.parse(evidenceText) as Record<string, unknown>;
    const stableFacts = recordValue(parseMaybeJson(pkg.stableFacts));
    const freshSignals = recordValue(parseMaybeJson(pkg.freshSignals));
    const promptPayload = {
      companyKey: pkg.companyKey,
      fetchedAt: pkg.fetchedAt,
      stableFacts: {
        company: stableFacts?.company,
        selectedCompany: stableFacts?.selectedCompany,
        financialTenYear: stableFacts?.financialTenYear,
        fundamentals: compactRecord(stableFacts?.fundamentals, 40),
      },
      freshSignals: {
        retrievedAt: freshSignals?.retrievedAt,
        quote: freshSignals?.quote,
        sources: compactSources(freshSignals?.sources),
      },
      trustedAnchors: anchors,
      unitConvention: "财务金额统一为亿元或等值的1亿报告货币单位；股本统一为亿股；金额除以股本得到每股报告货币。",
    };
    return { anchors, promptText: limitJsonPayload(promptPayload, 24_000) };
  } catch {
    return {
      anchors,
      promptText: JSON.stringify({
        note: "公司证据包无法解析，模型不得虚构公司规模字段。",
        trustedAnchors: anchors,
      }),
    };
  }
}

export function mergeAnchorsIntoAssumptions(payload: AiAssumptionPayload, anchors: ValuationAnchors): AiAssumptionPayload {
  const result: AiAssumptionPayload = {
    ...payload,
    operating: payload.operating ? { ...payload.operating } : undefined,
    financial: payload.financial ? { ...payload.financial } : undefined,
    cyclical: payload.cyclical ? { ...payload.cyclical } : undefined,
  };

  // Provider-backed scale anchors determine valuation magnitude; the model only estimates assumptions around them.
  const fillOperating = (target: NonNullable<AiAssumptionPayload["operating"]>) => {
    if (anchors.baseRevenue !== undefined) target.baseRevenue = anchors.baseRevenue;
    if (anchors.sharesOutstanding !== undefined) target.sharesOutstanding = anchors.sharesOutstanding;
    if (anchors.netDebt !== undefined) target.netDebt = anchors.netDebt;
  };
  const fillFinancial = (target: NonNullable<AiAssumptionPayload["financial"]>) => {
    if (anchors.bookValue !== undefined) target.bookValue = anchors.bookValue;
    if (anchors.sharesOutstanding !== undefined) target.sharesOutstanding = anchors.sharesOutstanding;
  };
  const fillCyclical = (target: NonNullable<AiAssumptionPayload["cyclical"]>) => {
    if (anchors.sharesOutstanding !== undefined) target.sharesOutstanding = anchors.sharesOutstanding;
  };

  if (result.operating) {
    fillOperating(result.operating);
  } else if (!result.financial && !result.cyclical) {
    result.operating = {};
    fillOperating(result.operating);
  }

  if (result.financial) fillFinancial(result.financial);
  if (result.cyclical) fillCyclical(result.cyclical);

  return result;
}

export function validateValuationInputs(run: Pick<ValuationRunRow, "method">, payload: AiAssumptionPayload): void {
  if (run.method === "ddm_residual_income") {
    const financial = payload.financial ?? {};
    if (!financial.bookValue || financial.bookValue <= 0) {
      throw new Error("估值必需字段 bookValue（账面价值）缺失：无法从证据包中提取可靠值，且模型未提供。运行将标记为失败。");
    }
    if (!financial.sharesOutstanding || financial.sharesOutstanding <= 0) {
      throw new Error("估值必需字段 sharesOutstanding（总股本）缺失：无法从证据包中提取可靠值，且模型未提供。运行将标记为失败。");
    }
    return;
  }
  if (run.method === "mid_cycle_nav") {
    const cyclical = payload.cyclical ?? {};
    if (!cyclical.midCycleEbitda) {
      throw new Error("估值必需字段 midCycleEbitda（中周期EBITDA）缺失：无法从证据包中提取可靠值，且模型未提供。运行将标记为失败。");
    }
    if (!cyclical.sharesOutstanding || cyclical.sharesOutstanding <= 0) {
      throw new Error("估值必需字段 sharesOutstanding（总股本）缺失：无法从证据包中提取可靠值，且模型未提供。运行将标记为失败。");
    }
    return;
  }
  const operating = payload.operating ?? {};
  if (!operating.baseRevenue || operating.baseRevenue <= 0) {
    throw new Error("估值必需字段 baseRevenue（营收基数）缺失：无法从证据包中提取可靠值，且模型未提供。运行将标记为失败。");
  }
  if (!operating.sharesOutstanding || operating.sharesOutstanding <= 0) {
    throw new Error("估值必需字段 sharesOutstanding（总股本）缺失：无法从证据包中提取可靠值，且模型未提供。运行将标记为失败。");
  }
}

async function generateValuationAssumptions(env: ValuationRunnerEnv, run: ValuationRunRow, evidence: string): Promise<AiAssumptionPayload> {
  const messages = buildValuationMessages(run, evidence);
  let lastError: unknown;
  for (const route of buildDeepSeekFallbackRoutes(env)) {
    try {
      const response = await fetch(route.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) },
        body: JSON.stringify(buildDeepSeekRequestBody({
          model: route.model,
          messages,
          maxTokens: 2_800,
          reasoningEffort: "max",
          thinking: { type: "enabled" },
          temperature: 0.05,
          responseFormat: { type: "json_object" },
        })),
      });
      if (!response.ok) {
        lastError = new Error(`${route.provider} valuation assumptions failed: ${response.status}`);
        continue;
      }
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as AiAssumptionPayload;
      return parsed;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("valuation assumption generation failed");
}

function buildValuationMessages(run: ValuationRunRow, evidence: string): DeepSeekMessage[] {
  const system = withCacheProtocol([
    "你是 CSTD Alpha 估值实验室的结构化假设生成器。",
    "只输出 JSON，不输出 Markdown。",
    "你只能生成预测假设，不直接给最终估值结论。最终估值由确定性公式计算。",
    "所有增长率、利润率、折现率、ROE、派息率都用小数，例如 0.08 表示 8%。",
    "所有货币金额以亿为单位（如 1234.56 表示 1234.56 亿元），股本以亿股为单位。",
    "没有足够证据时给保守、可解释、低置信假设，不要虚构精确事实。",
  ].join("\n"), "valuation-assumptions");
  const user = cacheStableUserContent({
    kind: "valuation-assumption",
    stable: {
      schema: {
        currency: "string",
        confidence: "number",
        operating: "baseRevenue sharesOutstanding netDebt revenueGrowth ebitMargin taxRate depreciationRate capexRate workingCapitalRate discountRate terminalGrowthRate peerEvEbitda",
        financial: "bookValue sharesOutstanding roe payoutRatio costOfEquity terminalGrowthRate",
        cyclical: "midCycleEbitda normalizedNetCash sharesOutstanding replacementAssetValue evEbitdaMultiple",
      },
    },
    volatile: {
      title: run.title,
      archetype: run.archetype,
      method: run.method,
      currency: run.currency,
      evidence,
    },
  });
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function latestAnnualMetricValue(rows: Record<string, unknown>[], metricNames: string[]) {
  const row = rows.find((candidate) => metricNames.some((name) => String(candidate.metric ?? "").includes(name)));
  const values = recordValue(row?.values);
  if (!values) return undefined;
  const annualKeys = Object.keys(values).filter((key) => /^\d{4}$/.test(key)).sort();
  const latest = annualKeys.at(-1);
  return latest ? parseRawFinancialValue(values[latest]) : undefined;
}

function parseRawFinancialValue(value: unknown): number | undefined {
  const text = String(value ?? "").replace(/,/g, "").trim();
  const num = Number.parseFloat(text);
  if (!Number.isFinite(num)) return undefined;
  if (text.includes("万亿")) return num * 10_000;
  if (text.includes("亿")) return num;
  if (text.includes("万")) return num / 10_000;
  if (text.includes("元") || text.includes("美元") || text.includes("港元")) return num / 100_000_000;
  return num;
}

function rawNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const num = parseFloat(value.replace(/,/g, ""));
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

async function readValuationEvidencePackage(env: ValuationRunnerEnv, run: ValuationRunRow) {
  const rows = await env.REPORT_LIBRARY_DB.prepare(
    `SELECT object_key, evidence_hash, material_hash, stable_hash, fresh_hash, updated_at, status
     FROM company_evidence_packages WHERE user_key = ?1 AND watchlist_id = ?2 ORDER BY updated_at DESC LIMIT 1`,
  ).bind(run.user_key, run.entity_id).all<{ object_key: string; evidence_hash: string; material_hash: string; stable_hash: string; fresh_hash: string; updated_at: string; status: string }>().catch(() => ({ results: [] }));
  const row = rows.results?.[0];
  if (!row || !env.REPORT_LIBRARY_BUCKET) return `暂无完整公司证据包。估值对象：${run.title}。`;
  const object = await env.REPORT_LIBRARY_BUCKET.get(row.object_key).catch(() => null);
  if (!object) return `公司证据包索引存在但 R2 对象缺失。估值对象：${run.title}。`;
  return object.text();
}

function normalizeTriple(value: Triple | undefined, fallback: Required<Triple>): Required<Triple> {
  const low = numberValue(value?.low, fallback.low);
  const base = numberValue(value?.base, fallback.base);
  const high = numberValue(value?.high, fallback.high);
  return { low: Math.min(low, base, high), base, high: Math.max(low, base, high) };
}

function positiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rateValue(value: unknown, fallback: number) {
  const parsed = numberValue(value, fallback);
  return Math.abs(parsed) > 1 ? parsed / 100 : parsed;
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function compactRecord(value: unknown, maxEntries: number) {
  const record = recordValue(value);
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).slice(0, maxEntries).map(([key, item]) => [key, compactValue(item)]));
}

function compactSources(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).map((item) => {
    const source = recordValue(item);
    return source
      ? {
          id: source.id,
          title: truncateText(source.title, 180),
          source: truncateText(source.source, 100),
          url: truncateText(source.url, 300),
          notes: truncateText(source.notes, 500),
          evidenceType: source.evidenceType,
        }
      : undefined;
  }).filter(Boolean);
}

function compactValue(value: unknown): unknown {
  if (typeof value === "string") return truncateText(value, 1200);
  if (Array.isArray(value)) return value.slice(0, 20).map(compactValue);
  const record = recordValue(value);
  return record ? Object.fromEntries(Object.entries(record).slice(0, 30).map(([key, item]) => [key, compactValue(item)])) : value;
}

function limitJsonPayload(value: unknown, maxLength: number) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxLength) return serialized;
  const record = recordValue(value) ?? {};
  const reduced = {
    companyKey: record.companyKey,
    fetchedAt: record.fetchedAt,
    stableFacts: record.stableFacts,
    trustedAnchors: record.trustedAnchors,
    unitConvention: record.unitConvention,
    note: "外部线索因长度限制省略；估值规模字段以 trustedAnchors 为准。",
  };
  const reducedSerialized = JSON.stringify(reduced);
  if (reducedSerialized.length <= maxLength) return reducedSerialized;
  return JSON.stringify({
    companyKey: record.companyKey,
    trustedAnchors: record.trustedAnchors,
    unitConvention: record.unitConvention,
    note: "证据摘要过长；估值规模字段以 trustedAnchors 为准。",
  });
}

function truncateText(value: unknown, maxLength: number) {
  const text = typeof value === "string" ? value : "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
