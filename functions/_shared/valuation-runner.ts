import { buildDeepSeekRequestBody, cacheStableUserContent, withCacheProtocol, type DeepSeekMessage } from "./deepseek-cache";
import { buildDeepSeekFallbackRoutes } from "./opencode-go";
import {
  claimValuationRun,
  completeValuationRun,
  createOrReadValuationSourceSnapshot,
  createQuantitativeVersion,
  failValuationRun,
  readValuationRunForWorker,
  type ValuationRunRow,
} from "./research-workbench-db";
import { computeCyclicalMidCycle, computeFinancialDdm, computeOperatingDcf } from "./valuation-engine";
import { createQuantitativeBaseline } from "./quantitative-valuation-draft";
import type { AssistantEnv } from "./assistant-db";
import type { ValuationResult } from "../../src/shared/valuation";
import { calculateQuantitativeDraft, type EditableAssumption, type OperatingValuationInput, type QuantitativeDraft, type ScenarioTriple } from "../../src/shared/quantitative-valuation";

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

type BuiltQuantitativeVersion =
  | ReturnType<typeof buildQuantitativeVersionFromEvidence>
  | ReturnType<typeof buildQuantitativeVersionFromAssumptions>;

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
    if (!await claimValuationRun(env.REPORT_LIBRARY_DB, valuationRunId, run.user_key)) return;
    const evidencePackage = await readValuationEvidencePackage(env, run);
    const quantitative: BuiltQuantitativeVersion | undefined = tryBuildQuantitativeVersionFromEvidence(run, evidencePackage);
    const evidence = prepareValuationEvidenceContext(evidencePackage);
    let assumptions: AiAssumptionPayload | undefined;
    const anchors = evidence.anchors;
    let result: ValuationResult;
    let quantitativeVersionId: string | undefined;
    let sourceSnapshotId: string | undefined;
    if (quantitative) {
      const snapshot = await createOrReadValuationSourceSnapshot(env.REPORT_LIBRARY_DB, {
        userKey: quantitative.snapshot.userKey,
        researchItemId: quantitative.snapshot.researchItemId ?? run.entity_id,
        market: quantitative.snapshot.market,
        asOf: quantitative.snapshot.asOf,
        payload: quantitative.snapshot.payload,
        evidenceHash: quantitative.snapshot.evidenceHash,
        contentHash: quantitative.snapshot.contentHash,
      });
      const version = await createQuantitativeVersion(env.REPORT_LIBRARY_DB, {
        userKey: run.user_key,
        runId: run.id,
        snapshotId: snapshot.id,
        draft: quantitative.draft,
        result: quantitative.result,
        createdBy: "baseline",
      });
      quantitativeVersionId = version.id;
      sourceSnapshotId = snapshot.id;
      result = {
        ...quantitative.result,
        methodologyVersion: 3,
        quantitativeVersionId,
        sourceSnapshotId,
        warnings: quantitative.warnings,
      };
    } else {
      assumptions = await generateValuationAssumptionsOrPlaceholder(env, run, evidence.promptText);
      if (run.method === "dcf_3_statement" && run.archetype === "operating") {
        const fallbackQuantitative = buildQuantitativeVersionFromAssumptions(run, assumptions, anchors, evidencePackage);
        const snapshot = await createOrReadValuationSourceSnapshot(env.REPORT_LIBRARY_DB, {
          userKey: fallbackQuantitative.snapshot.userKey,
          researchItemId: fallbackQuantitative.snapshot.researchItemId ?? run.entity_id,
          market: fallbackQuantitative.snapshot.market,
          asOf: fallbackQuantitative.snapshot.asOf,
          payload: fallbackQuantitative.snapshot.payload,
          evidenceHash: fallbackQuantitative.snapshot.evidenceHash,
          contentHash: fallbackQuantitative.snapshot.contentHash,
        });
        const version = await createQuantitativeVersion(env.REPORT_LIBRARY_DB, {
          userKey: run.user_key,
          runId: run.id,
          snapshotId: snapshot.id,
          draft: fallbackQuantitative.draft,
          result: fallbackQuantitative.result,
          createdBy: "baseline",
        });
        quantitativeVersionId = version.id;
        sourceSnapshotId = snapshot.id;
        result = {
          ...fallbackQuantitative.result,
          methodologyVersion: 3,
          quantitativeVersionId,
          sourceSnapshotId,
          warnings: fallbackQuantitative.warnings,
        };
      } else {
        result = computeValuationFromAssumptions(run, assumptions, anchors);
      }
    }
    const objectKey = `valuation/v1/${encodeURIComponent(run.user_key)}/${valuationRunId}.json`;
    if (env.REPORT_LIBRARY_BUCKET) {
      await env.REPORT_LIBRARY_BUCKET.put(objectKey, JSON.stringify({ run, evidence, anchors, assumptions, result, createdAt: new Date().toISOString() }), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
    }
    await completeValuationRun(env.REPORT_LIBRARY_DB, { id: valuationRunId, userKey: run.user_key, result, objectKey });
  } catch (error) {
    await failValuationRun(env.REPORT_LIBRARY_DB, valuationRunId, run.user_key, error);
    throw error;
  }
}

export function buildQuantitativeVersionFromEvidence(run: Pick<ValuationRunRow,
  "id" | "user_key" | "research_item_id" | "entity_id" | "title" | "archetype" | "method" | "currency" | "evidence_hash"
>, evidencePackage: string) {
  if (run.method !== "dcf_3_statement" || run.archetype !== "operating") {
    throw new Error("当前量化基准仅支持经营型 DCF。");
  }
  const baseline = createQuantitativeBaseline(evidencePackage, run);
  const result = calculateQuantitativeDraft(baseline.draft);
  return { ...baseline, result };
}

export function buildQuantitativeVersionFromAssumptions(
  run: Pick<ValuationRunRow, "id" | "user_key" | "research_item_id" | "entity_id" | "title" | "archetype" | "method" | "currency" | "evidence_hash">,
  payload: AiAssumptionPayload,
  anchors: ValuationAnchors,
  evidencePackage: string,
) {
  if (run.method !== "dcf_3_statement" || run.archetype !== "operating") {
    throw new Error("当前量化基准仅支持经营型 DCF。");
  }
  const warnings = ["未找到完整公司证据包，已使用模型假设生成可编辑量化草稿；请优先补充或刷新公司证据后复核。"];
  const merged = withManualFallbackScale(mergeAnchorsIntoAssumptions(payload, anchors), warnings);
  validateValuationInputs(run, merged);
  const operating = buildOperatingInput(run, merged, new Date().toISOString().slice(0, 10));
  const draft: QuantitativeDraft & { runId: string; sourceSnapshotId: "pending"; market: "A股" } = {
    runId: run.id,
    sourceSnapshotId: "pending",
    market: "A股",
    method: "dcf_3_statement",
    archetype: "operating",
    currency: operating.currency,
    asOf: operating.asOf,
    operating,
    assumptions: operatingAssumptionsFromAi(operating, payload.confidence),
    scenarios: {
      bear: { discountRate: operating.discountRate.high, terminalGrowthRate: operating.terminalGrowthRate.low },
      base: { discountRate: operating.discountRate.base, terminalGrowthRate: operating.terminalGrowthRate.base },
      bull: { discountRate: operating.discountRate.low, terminalGrowthRate: operating.terminalGrowthRate.high },
    },
    warnings,
  };
  const result = calculateQuantitativeDraft(draft);
  const snapshot = {
    userKey: run.user_key,
    researchItemId: run.research_item_id,
    market: "A股" as const,
    asOf: operating.asOf,
    payload: {
      kind: "ai-assumption-fallback",
      runId: run.id,
      entityId: run.entity_id,
      title: run.title,
      anchors,
      assumptions: merged,
      evidencePreview: truncateText(evidencePackage, 1200),
    },
    evidenceHash: run.evidence_hash ?? "",
    contentHash: `ai-fallback:${stableHashCode({ runId: run.id, entityId: run.entity_id, merged, anchors })}`,
    warnings,
    createdAt: new Date().toISOString(),
  };
  return { snapshot, draft, result, warnings };
}

function tryBuildQuantitativeVersionFromEvidence(run: ValuationRunRow, evidencePackage: string) {
  try {
    return buildQuantitativeVersionFromEvidence(run, evidencePackage);
  } catch {
    return undefined;
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
  return markGroundedMethodology(computeOperatingDcf(buildOperatingInput(run, { ...merged, operating }, asOf)));
}

function markGroundedMethodology(result: ValuationResult): ValuationResult {
  return { ...result, methodologyVersion: 2 };
}

function buildOperatingInput(
  run: Pick<ValuationRunRow, "currency" | "evidence_hash">,
  payload: AiAssumptionPayload,
  asOf: string,
): OperatingValuationInput {
  const operating = payload.operating ?? {};
  return {
    currency: payload.currency || run.currency || "CNY",
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
  };
}

function operatingAssumptionsFromAi(input: OperatingValuationInput, confidence = 0.5): EditableAssumption[] {
  const boundedConfidence = clamp(numberValue(confidence, 0.5), 0.05, 0.95);
  return [
    scalarEditableAssumption("baseRevenue", "营业收入基数", input.baseRevenue, "亿元", boundedConfidence, "营业收入基数，缺少完整证据包时可能为占位值，请优先手动修正。"),
    tripleEditableAssumption("revenueGrowth", "收入增速", input.revenueGrowth, "%", boundedConfidence, "由模型结合当前证据上下文生成，等待人工复核。"),
    tripleEditableAssumption("ebitMargin", "EBIT 利润率", input.ebitMargin, "%", boundedConfidence, "由模型结合当前证据上下文生成，等待人工复核。"),
    tripleEditableAssumption("capexRate", "资本开支/收入", input.capexRate, "%", boundedConfidence, "缺少完整证据包时的模型初始值，可手动调整。"),
    scalarEditableAssumption("workingCapitalRate", "营运资本变动/收入", input.workingCapitalRate, "%", boundedConfidence, "缺少完整证据包时的模型初始值，可手动调整。"),
    scalarEditableAssumption("taxRate", "所得税率", input.taxRate, "%", boundedConfidence, "缺少完整证据包时的模型初始值，可手动调整。"),
    tripleEditableAssumption("discountRate", "WACC", { low: input.discountRate.high, base: input.discountRate.base, high: input.discountRate.low }, "%", boundedConfidence, "由模型生成的折现率情景，需结合行业和资本结构复核。"),
    tripleEditableAssumption("terminalGrowthRate", "永续增长率", input.terminalGrowthRate, "%", boundedConfidence, "由模型生成的长期增长率情景，需保持低于折现率。"),
    scalarEditableAssumption("netDebt", "净债务", input.netDebt, "亿元", boundedConfidence, "由模型或证据锚点生成的净债务，建议用最新财报复核。"),
    scalarEditableAssumption("sharesOutstanding", "总股本", input.sharesOutstanding, "亿股", boundedConfidence, "由模型或证据锚点生成的总股本，建议用行情/公告复核。"),
  ];
}

function withManualFallbackScale(payload: AiAssumptionPayload, warnings: string[]): AiAssumptionPayload {
  const operating = { ...(payload.operating ?? {}) };
  if (!operating.baseRevenue || operating.baseRevenue <= 0) {
    operating.baseRevenue = 100;
    warnings.push("缺少营业收入基数，已使用 100 亿元占位以保持手动估值工作区可用；保存前请改为真实值。");
  }
  if (!operating.sharesOutstanding || operating.sharesOutstanding <= 0) {
    operating.sharesOutstanding = 1;
    warnings.push("缺少总股本，已使用 1 亿股占位以保持手动估值工作区可用；保存前请改为真实值。");
  }
  return { ...payload, operating };
}

function tripleEditableAssumption(key: string, label: string, value: ScenarioTriple, unit: string, confidence: number, explanation: string): EditableAssumption {
  const multiplier = unit === "%" ? 100 : 1;
  return {
    key,
    label,
    bear: roundDisplay(value.low * multiplier),
    base: roundDisplay(value.base * multiplier),
    bull: roundDisplay(value.high * multiplier),
    unit,
    origin: "ai",
    evidenceRefs: [],
    confidence,
    locked: false,
    explanation,
  };
}

function scalarEditableAssumption(key: string, label: string, value: number, unit: string, confidence: number, explanation: string): EditableAssumption {
  const displayValue = unit === "%" ? value * 100 : value;
  return {
    key,
    label,
    value: roundDisplay(displayValue),
    base: roundDisplay(displayValue),
    unit,
    origin: "ai",
    evidenceRefs: [],
    confidence,
    locked: false,
    explanation,
  };
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

export async function generateValuationAssumptionsOrPlaceholder(env: ValuationRunnerEnv, run: ValuationRunRow, evidence: string): Promise<AiAssumptionPayload> {
  try {
    return await generateValuationAssumptions(env, run, evidence);
  } catch (error) {
    if (run.method === "dcf_3_statement" && run.archetype === "operating") {
      return { confidence: 0.2, operating: {} };
    }
    throw error;
  }
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function roundDisplay(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function stableHashCode(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
