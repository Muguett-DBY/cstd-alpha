import { buildDeepSeekRequestBody, cacheStableUserContent, withCacheProtocol, type DeepSeekMessage } from "./deepseek-cache";
import { buildDeepSeekFallbackRoutes } from "./opencode-go";
import { completeValuationRun, failValuationRun, markValuationRunRunning, readValuationRunForWorker, type ValuationRunRow } from "./research-workbench-db";
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

export async function processValuationRun(env: ValuationRunnerEnv, valuationRunId: string) {
  const run = await readValuationRunForWorker(env.REPORT_LIBRARY_DB, valuationRunId);
  if (!run || run.status === "completed") return;
  try {
    await markValuationRunRunning(env.REPORT_LIBRARY_DB, valuationRunId);
    const evidence = await readValuationEvidenceSummary(env, run);
    const assumptions = await generateValuationAssumptions(env, run, evidence).catch((error) => {
      console.warn("valuation_assumption_model_fallback", { valuationRunId, error: safeError(error) });
      return defaultAssumptions(run);
    });
    const result = computeValuationFromAssumptions(run, assumptions);
    const objectKey = `valuation/v1/${encodeURIComponent(run.user_key)}/${valuationRunId}.json`;
    if (env.REPORT_LIBRARY_BUCKET) {
      await env.REPORT_LIBRARY_BUCKET.put(objectKey, JSON.stringify({ run, evidence, assumptions, result, createdAt: new Date().toISOString() }), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
    }
    await completeValuationRun(env.REPORT_LIBRARY_DB, { id: valuationRunId, result, objectKey });
  } catch (error) {
    await failValuationRun(env.REPORT_LIBRARY_DB, valuationRunId, error);
    throw error;
  }
}

export function computeValuationFromAssumptions(run: Pick<ValuationRunRow, "archetype" | "method" | "currency" | "evidence_hash">, payload: AiAssumptionPayload): ValuationResult {
  const currency = payload.currency || run.currency || "CNY";
  const asOf = new Date().toISOString().slice(0, 10);
  if (run.method === "ddm_residual_income") {
    const financial = payload.financial ?? {};
    return computeFinancialDdm({
      currency,
      asOf,
      bookValue: positiveNumber(financial.bookValue, 100),
      sharesOutstanding: positiveNumber(financial.sharesOutstanding, 1),
      roe: normalizeTriple(financial.roe, { low: 0.07, base: 0.1, high: 0.13 }),
      payoutRatio: normalizeTriple(financial.payoutRatio, { low: 0.25, base: 0.35, high: 0.45 }),
      costOfEquity: normalizeTriple(financial.costOfEquity, { low: 0.085, base: 0.1, high: 0.115 }),
      terminalGrowthRate: normalizeTriple(financial.terminalGrowthRate, { low: 0.005, base: 0.015, high: 0.025 }),
      evidenceHash: run.evidence_hash ?? undefined,
    }, run.archetype === "insurance" ? "insurance" : "bank");
  }
  if (run.method === "mid_cycle_nav") {
    const cyclical = payload.cyclical ?? {};
    return computeCyclicalMidCycle({
      currency,
      asOf,
      midCycleEbitda: normalizeTriple(cyclical.midCycleEbitda, { low: 60, base: 100, high: 140 }),
      normalizedNetCash: numberValue(cyclical.normalizedNetCash, 0),
      sharesOutstanding: positiveNumber(cyclical.sharesOutstanding, 1),
      replacementAssetValue: cyclical.replacementAssetValue ? normalizeTriple(cyclical.replacementAssetValue, { low: 300, base: 400, high: 500 }) : undefined,
      evEbitdaMultiple: normalizeTriple(cyclical.evEbitdaMultiple, { low: 4, base: 6, high: 8 }),
      evidenceHash: run.evidence_hash ?? undefined,
    });
  }
  const operating = payload.operating ?? {};
  return computeOperatingDcf({
    currency,
    asOf,
    baseRevenue: positiveNumber(operating.baseRevenue, 100),
    sharesOutstanding: positiveNumber(operating.sharesOutstanding, 1),
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
  });
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

async function readValuationEvidenceSummary(env: ValuationRunnerEnv, run: ValuationRunRow) {
  const rows = await env.REPORT_LIBRARY_DB.prepare(
    `SELECT object_key, evidence_hash, material_hash, stable_hash, fresh_hash, updated_at, status
     FROM company_evidence_packages WHERE user_key = ?1 AND watchlist_id = ?2 ORDER BY updated_at DESC LIMIT 1`,
  ).bind(run.user_key, run.entity_id).all<{ object_key: string; evidence_hash: string; material_hash: string; stable_hash: string; fresh_hash: string; updated_at: string; status: string }>().catch(() => ({ results: [] }));
  const row = rows.results?.[0];
  if (!row || !env.REPORT_LIBRARY_BUCKET) return `暂无完整公司证据包。估值对象：${run.title}。`;
  const object = await env.REPORT_LIBRARY_BUCKET.get(row.object_key).catch(() => null);
  if (!object) return `公司证据包索引存在但 R2 对象缺失。估值对象：${run.title}。`;
  const text = await object.text();
  return text.slice(0, 24_000);
}

function defaultAssumptions(run: Pick<ValuationRunRow, "method" | "currency">): AiAssumptionPayload {
  if (run.method === "ddm_residual_income") {
    return { currency: run.currency, confidence: 0.35, financial: {} };
  }
  if (run.method === "mid_cycle_nav") {
    return { currency: run.currency, confidence: 0.35, cyclical: {} };
  }
  return { currency: run.currency, confidence: 0.35, operating: {} };
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

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}
