import type { CompanyEvidencePackage } from "./company-evidence";
import type { ValuationRunRow } from "./research-workbench-db";
import type { OperatingValuationInput, QuantitativeDraft, ScenarioTriple } from "../../src/shared/quantitative-valuation";
import type { CompanyArchetype, ValuationMethod, ValuationAssumption } from "../../src/shared/valuation";

type ValuationRunDraftInput = Pick<
  ValuationRunRow,
  "id" | "user_key" | "research_item_id" | "entity_id" | "title" | "archetype" | "method" | "currency" | "evidence_hash"
>;

type BaselineAssumption = Omit<ValuationAssumption, "low" | "high" | "origin"> & {
  origin: "provider" | "formula";
  explanation: string;
  value?: number;
  bear?: number;
  bull?: number;
};

export type QuantitativeBaselineSnapshot = {
  userKey: string;
  researchItemId: string | null;
  market: "A股";
  asOf: string;
  payload: CompanyEvidencePackage;
  evidenceHash: string;
  contentHash: string;
  warnings: string[];
  createdAt?: string;
};

export type QuantitativeBaselineDraft = QuantitativeDraft & {
  runId: string;
  sourceSnapshotId: "pending";
  market: "A股";
  currentPrice?: number;
  assumptions: BaselineAssumption[];
  operating?: OperatingValuationInput;
};

export type QuantitativeBaselineResult = {
  snapshot: QuantitativeBaselineSnapshot;
  draft: QuantitativeBaselineDraft;
  warnings: string[];
};

type MetricSeries = {
  metric: string;
  values: number[];
  latest?: number;
};

export function assertAshare(market: unknown, ticker: unknown) {
  const m = String(market ?? "").replace(/\s/g, "").toUpperCase();
  if (!/(?:A股|沪A|深A|创业板|科创板|SH-A|SZ-A|ASTOCK)/.test(m) || !/^\d{6}$/.test(String(ticker ?? ""))) {
    throw new Error("仅支持 A 股公司创建可编辑量化估值。");
  }
}

export function growthTriple(values: number[]) {
  const xs = values.filter((x) => Number.isFinite(x) && x > 0);
  const base = xs.length >= 2 ? Math.pow(xs.at(-1)! / xs[0], 1 / (xs.length - 1)) - 1 : 0.07;
  return { bear: Math.max(-0.1, base - 0.04), base, bull: Math.min(0.35, base + 0.04) };
}

export function createQuantitativeBaseline(pkgOrJson: CompanyEvidencePackage | string, run: ValuationRunDraftInput): QuantitativeBaselineResult {
  const pkg = typeof pkgOrJson === "string" ? JSON.parse(pkgOrJson) as CompanyEvidencePackage : pkgOrJson;
  const stableFacts = recordValue(pkg.stableFacts);
  const freshSignals = recordValue(pkg.freshSignals);
  const quote = recordValue(freshSignals?.quote);
  validateAsharePackage(pkg, stableFacts, freshSignals, quote);

  const sourceWarnings = sourceWarningStrings(freshSignals);
  const warnings = [...sourceWarnings];
  const asOf = dateOnly(stringValue(freshSignals?.retrievedAt) ?? stringValue(pkg.fetchedAt) ?? new Date().toISOString());
  const rows = financialRows(stableFacts);
  const revenue = metricSeries(rows, [/营业收入/, /营收/, /^收入$/]);
  const ebit = metricSeries(rows, [/^EBIT$/i, /息税前利润/, /营业利润/]);
  const capex = metricSeries(rows, [/资本开支/i, /CAPEX/i, /购建固定资产/]);
  const workingCapital = metricSeries(rows, [/营运资本/, /营运资金/, /working capital/i]);
  const taxExpense = latestMetric(rows, [/所得税费用/, /所得税/]);
  const preTaxProfit = latestMetric(rows, [/税前利润/, /利润总额/]);
  const debt = latestMetric(rows, [/有息负债/, /总债务/, /短期借款/, /长期借款/]);
  const cash = latestMetric(rows, [/货币资金/, /现金及现金等价物/, /现金/]);

  const baseRevenue = latestOrFallback(revenue.latest, 0, "缺少营业收入历史，营收基数暂置为 0，需人工补充。", warnings);
  const revenueGrowth = growthTriple(revenue.values);
  const revenueGrowthUsedFallback = revenue.values.length < 2;
  if (revenueGrowthUsedFallback) warnings.push("营业收入历史不足，收入增速使用 7% 保守默认值。");

  const ebitMargins = pairedRatios(ebit.values, revenue.values);
  const ebitMarginUsedFallback = ebitMargins.length === 0;
  const ebitMarginBase = ebitMargins.length ? average(tail(ebitMargins, 3)) : 0.13;
  if (ebitMarginUsedFallback) warnings.push("缺少 EBIT 与收入配对历史，EBIT 利润率使用 13% 默认值。");
  const ebitMargin = boundedTriple(ebitMarginBase, 0.03, -0.1, 0.6);

  const capexUsedFallback = !(capex.latest !== undefined && baseRevenue > 0);
  const capexRateBase = ratioOrFallback(capex.latest === undefined ? undefined : Math.abs(capex.latest), baseRevenue, 0.06, "缺少资本开支历史，资本开支率使用 6% 默认值。", warnings);
  const workingCapitalUsedFallback = !(workingCapital.latest !== undefined && baseRevenue > 0);
  const workingCapitalRate = ratioOrFallback(workingCapital.latest, baseRevenue, 0.015, "缺少营运资本变动历史，营运资本率使用 1.5% 默认值。", warnings);
  const taxUsedFallback = taxExpense === undefined || preTaxProfit === undefined || preTaxProfit <= 0;
  const taxRate = !taxUsedFallback ? clamp(taxExpense / preTaxProfit, 0, 0.45) : 0.2;
  if (taxUsedFallback) warnings.push("缺少所得税/税前利润历史，税率使用 20% 默认值。");

  const netDebt = debt !== undefined || cash !== undefined ? (debt ?? 0) - (cash ?? 0) : 0;
  const netDebtUsedFallback = debt === undefined && cash === undefined;
  if (netDebtUsedFallback) warnings.push("缺少债务与现金历史，净债务暂置为 0。");

  const currentPrice = rawNumber(quote?.regularMarketPrice);
  const marketCap = rawNumber(quote?.marketCap);
  const sharesOutstanding = marketCap !== undefined && currentPrice !== undefined && currentPrice > 0 && marketCap > 0
    ? marketCap / currentPrice / 100_000_000
    : 0;
  const sharesOutstandingUsedFallback = !sharesOutstanding;
  if (sharesOutstandingUsedFallback) warnings.push("缺少可由行情市值/价格推导的总股本，总股本暂置为 0，需人工补充。");

  const capexRate = boundedTriple(capexRateBase, 0.015, 0, 0.35);
  const discountRate = { bear: 0.115, base: 0.1, bull: 0.085 };
  const terminalGrowthRate = { bear: 0.015, base: 0.025, bull: 0.035 };
  const assumptions: BaselineAssumption[] = [
    tripleAssumption(
      "revenueGrowth",
      "收入增速",
      revenueGrowth,
      "%",
      "formula",
      revenueGrowthUsedFallback ? [] : ["financialTenYear:营业收入"],
      revenueGrowthUsedFallback ? 0.38 : 0.72,
      revenueGrowthUsedFallback ? "营业收入历史不足，使用 fallback/default 默认收入增速。" : "基于年度营业收入序列计算 CAGR，并给出上下 4 个百分点情景。",
    ),
    tripleAssumption(
      "ebitMargin",
      "EBIT 利润率",
      ebitMargin,
      "%",
      "formula",
      ebitMarginUsedFallback ? [] : ["financialTenYear:EBIT", "financialTenYear:营业收入"],
      ebitMarginUsedFallback ? 0.42 : 0.68,
      ebitMarginUsedFallback ? "缺少可配对 EBIT 历史，使用 fallback/default 默认利润率。" : "基于年度 EBIT / 营业收入的近三年平均值生成情景。",
    ),
    tripleAssumption(
      "capexRate",
      "资本开支/收入",
      capexRate,
      "%",
      "formula",
      capexUsedFallback ? [] : ["financialTenYear:资本开支", "financialTenYear:营业收入"],
      capexUsedFallback ? 0.38 : 0.58,
      capexUsedFallback ? "缺少资本开支历史，使用 fallback/default 默认资本开支率。" : "基于最新年度资本开支除以营业收入。",
    ),
    scalarAssumption(
      "workingCapitalRate",
      "营运资本变动/收入",
      workingCapitalRate,
      "%",
      "formula",
      workingCapitalUsedFallback ? [] : ["financialTenYear:营运资本", "financialTenYear:营业收入"],
      workingCapitalUsedFallback ? 0.35 : 0.55,
      workingCapitalUsedFallback ? "缺少营运资本变动历史，使用 fallback/default 默认值。" : "基于最新年度营运资本变动除以营业收入。",
    ),
    scalarAssumption(
      "taxRate",
      "所得税率",
      taxRate,
      "%",
      "formula",
      taxUsedFallback ? [] : ["financialTenYear:所得税费用", "financialTenYear:税前利润"],
      taxUsedFallback ? 0.4 : 0.62,
      taxUsedFallback ? "缺少税费历史，使用 fallback/default 默认税率。" : "基于所得税费用 / 税前利润推导。",
    ),
    tripleAssumption("discountRate", "WACC", discountRate, "%", "formula", ["formula:ashare-default-wacc"], 0.45, "A 股经营型公司初始 WACC 情景，等待用户按行业与资本结构调整。"),
    tripleAssumption("terminalGrowthRate", "永续增长率", terminalGrowthRate, "%", "formula", ["formula:ashare-default-terminal-growth"], 0.45, "A 股长期名义增长初始情景，保持低于折现率。"),
    scalarAssumption(
      "netDebt",
      "净债务",
      netDebt,
      "亿元",
      "formula",
      netDebtEvidenceRefs(debt, cash),
      netDebtUsedFallback ? 0.35 : 0.65,
      netDebtUsedFallback ? "缺少债务与现金历史，使用 fallback/default 默认净债务 0。" : "有息负债减货币资金，单位为亿元。",
    ),
    scalarAssumption(
      "sharesOutstanding",
      "总股本",
      sharesOutstanding,
      "亿股",
      "provider",
      sharesOutstandingUsedFallback ? [] : ["freshSignals.quote"],
      sharesOutstandingUsedFallback ? 0.25 : 0.72,
      sharesOutstandingUsedFallback ? "行情缺少市值或价格，使用 fallback/default 将总股本暂置为 0。" : "由 freshSignals.quote 的市值 / 当前价格推导，单位为亿股。",
    ),
  ];

  const operating: OperatingValuationInput = {
    currency: run.currency || "CNY",
    asOf,
    baseRevenue,
    sharesOutstanding,
    netDebt,
    revenueGrowth: toLowBaseHigh(revenueGrowth),
    ebitMargin: toLowBaseHigh(ebitMargin),
    taxRate,
    depreciationRate: 0.035,
    capexRate: toLowBaseHigh(capexRate),
    workingCapitalRate,
    discountRate: { low: discountRate.bull, base: discountRate.base, high: discountRate.bear },
    terminalGrowthRate: { low: terminalGrowthRate.bear, base: terminalGrowthRate.base, high: terminalGrowthRate.bull },
    evidenceHash: pkg.evidenceHash || run.evidence_hash || undefined,
  };

  const snapshot: QuantitativeBaselineSnapshot = {
    userKey: run.user_key,
    researchItemId: run.research_item_id,
    market: "A股",
    asOf,
    payload: pkg,
    evidenceHash: pkg.evidenceHash || run.evidence_hash || "",
    contentHash: pkg.materialHash || pkg.stableHash || pkg.evidenceHash || run.evidence_hash || "",
    warnings: sourceWarnings,
    createdAt: new Date().toISOString(),
  };
  const draft: QuantitativeBaselineDraft = {
    runId: run.id,
    sourceSnapshotId: "pending",
    market: "A股",
    method: (run.method || "dcf_3_statement") as ValuationMethod,
    archetype: (run.archetype || "operating") as CompanyArchetype,
    currency: run.currency || "CNY",
    asOf,
    currentPrice,
    assumptions,
    operating,
    scenarios: {
      bear: { discountRate: discountRate.bear, terminalGrowthRate: terminalGrowthRate.bear },
      base: { discountRate: discountRate.base, terminalGrowthRate: terminalGrowthRate.base },
      bull: { discountRate: discountRate.bull, terminalGrowthRate: terminalGrowthRate.bull },
    },
    warnings,
  };
  return { snapshot, draft, warnings };
}

function validateAsharePackage(
  pkg: CompanyEvidencePackage,
  stableFacts: Record<string, unknown> | undefined,
  freshSignals: Record<string, unknown> | undefined,
  quote: Record<string, unknown> | undefined,
) {
  const evidence = recordValue(pkg.evidence);
  const candidates = [
    recordValue(stableFacts?.company),
    recordValue(stableFacts?.selectedCompany),
    recordValue(evidence?.company),
    quote,
    freshSignals,
  ].filter(Boolean) as Record<string, unknown>[];

  for (const candidate of candidates) {
    const market = candidate.market ?? candidate.listingPlace ?? candidate.marketType ?? candidate.exchange;
    const ticker = normalizeTicker(candidate.ticker ?? candidate.code ?? candidate.symbol ?? candidate.secid);
    try {
      assertAshare(market, ticker);
      return;
    } catch {
      // Try the next source field; final error below preserves the public message.
    }
  }
  throw new Error("仅支持 A 股公司创建可编辑量化估值。");
}

function financialRows(stableFacts: Record<string, unknown> | undefined) {
  const financialTenYear = recordValue(stableFacts?.financialTenYear);
  return Array.isArray(financialTenYear?.rows) ? financialTenYear.rows.map(recordValue).filter(Boolean) as Record<string, unknown>[] : [];
}

function metricSeries(rows: Record<string, unknown>[], patterns: RegExp[]): MetricSeries {
  const row = rows.find((candidate) => patterns.some((pattern) => pattern.test(String(candidate.metric ?? ""))));
  const values = recordValue(row?.values);
  if (!values) return { metric: String(row?.metric ?? ""), values: [] };
  const parsed = Object.entries(values)
    .filter(([key]) => /^\d{4}$/.test(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => parseFinancialValue(value))
    .filter((value): value is number => value !== undefined);
  return { metric: String(row?.metric ?? ""), values: parsed, latest: parsed.at(-1) };
}

function latestMetric(rows: Record<string, unknown>[], patterns: RegExp[]) {
  return metricSeries(rows, patterns).latest;
}

function parseFinancialValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").replace(/[,，\s]/g, "");
  const parenthesizedNegative = /^[（(].+[）)]$/.test(text);
  const normalized = text.replace(/[()（）]/g, "");
  const num = Number.parseFloat(normalized);
  if (!Number.isFinite(num)) return undefined;
  const signed = parenthesizedNegative ? -num : num;
  if (normalized.includes("万亿")) return signed * 10_000;
  if (normalized.includes("亿")) return signed;
  if (normalized.includes("万")) return signed / 10_000;
  if (normalized.includes("元") || normalized.includes("美元") || normalized.includes("港元")) return signed / 100_000_000;
  return signed;
}

function rawNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const text = value.replace(/[,，\s]/g, "");
    const num = Number.parseFloat(text);
    if (!Number.isFinite(num)) return undefined;
    if (text.includes("万亿")) return num * 1_000_000_000_000;
    if (text.includes("亿")) return num * 100_000_000;
    if (text.includes("万")) return num * 10_000;
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

function netDebtEvidenceRefs(debt: number | undefined, cash: number | undefined) {
  const refs: string[] = [];
  if (debt !== undefined) refs.push("financialTenYear:有息负债");
  if (cash !== undefined) refs.push("financialTenYear:货币资金");
  return refs;
}

function normalizeTicker(value: unknown) {
  const text = String(value ?? "");
  return text.match(/\d{6}/)?.[0] ?? text;
}

function sourceWarningStrings(freshSignals: Record<string, unknown> | undefined) {
  const quote = recordValue(freshSignals?.quote);
  return [...stringArray(freshSignals?.warnings), ...stringArray(quote?.warnings)];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function dateOnly(value: string) {
  return value.slice(0, 10);
}

function latestOrFallback(value: number | undefined, fallback: number, warning: string, warnings: string[]) {
  if (value !== undefined && Number.isFinite(value)) return value;
  warnings.push(warning);
  return fallback;
}

function ratioOrFallback(numerator: number | undefined, denominator: number, fallback: number, warning: string, warnings: string[]) {
  if (numerator !== undefined && denominator > 0) return clamp(numerator / denominator, -0.5, 0.8);
  warnings.push(warning);
  return fallback;
}

function pairedRatios(numerators: number[], denominators: number[]) {
  const length = Math.min(numerators.length, denominators.length);
  return Array.from({ length }, (_, index) => denominators[index] > 0 ? numerators[index] / denominators[index] : undefined)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
}

function tail<T>(values: T[], count: number) {
  return values.slice(Math.max(0, values.length - count));
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function boundedTriple(base: number, spread: number, min: number, max: number) {
  return {
    bear: clamp(base - spread, min, max),
    base: clamp(base, min, max),
    bull: clamp(base + spread, min, max),
  };
}

function toLowBaseHigh(value: { bear: number; base: number; bull: number }): ScenarioTriple {
  return { low: value.bear, base: value.base, high: value.bull };
}

function tripleAssumption(
  key: string,
  label: string,
  value: { bear: number; base: number; bull: number },
  unit: string,
  origin: "provider" | "formula",
  evidenceRefs: string[],
  confidence: number,
  explanation: string,
): BaselineAssumption {
  const displayValue = unit === "%" ? { bear: displayPercent(value.bear), base: displayPercent(value.base), bull: displayPercent(value.bull) } : value;
  return {
    key,
    label,
    base: displayValue.base,
    bear: displayValue.bear,
    bull: displayValue.bull,
    unit,
    origin,
    evidenceRefs,
    confidence,
    locked: false,
    explanation,
  };
}

function scalarAssumption(
  key: string,
  label: string,
  value: number,
  unit: string,
  origin: "provider" | "formula",
  evidenceRefs: string[],
  confidence: number,
  explanation: string,
): BaselineAssumption {
  const displayValue = unit === "%" ? displayPercent(value) : value;
  return {
    key,
    label,
    value: displayValue,
    base: displayValue,
    unit,
    origin,
    evidenceRefs,
    confidence,
    locked: false,
    explanation,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function displayPercent(value: number) {
  return Math.round(value * 100 * 1_000_000) / 1_000_000;
}
