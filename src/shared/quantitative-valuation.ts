import type {
  CompanyArchetype,
  ThreeStatementForecastRow,
  ValuationAssumption,
  ValuationMethod,
  ValuationResult,
  ValuationRunSummary,
  ValuationScenarioName,
} from "./valuation";

export type ScenarioTriple = {
  low: number;
  base: number;
  high: number;
};

export type OperatingValuationInput = {
  currency: string;
  asOf: string;
  baseRevenue: number;
  sharesOutstanding: number;
  netDebt: number;
  revenueGrowth: ScenarioTriple;
  ebitMargin: ScenarioTriple;
  taxRate: number;
  depreciationRate: number;
  capexRate: ScenarioTriple;
  workingCapitalRate: number;
  discountRate: ScenarioTriple;
  terminalGrowthRate: ScenarioTriple;
  peerEvEbitda?: ScenarioTriple;
  evidenceHash?: string;
  forecastOverrides?: Array<{
    year: number;
    revenueGrowth?: number;
    ebitMargin?: number;
    capexRate?: number;
    workingCapitalRate?: number;
  }>;
};

export type FinancialValuationInput = {
  currency: string;
  asOf: string;
  bookValue: number;
  sharesOutstanding: number;
  roe: ScenarioTriple;
  payoutRatio: ScenarioTriple;
  costOfEquity: ScenarioTriple;
  terminalGrowthRate: ScenarioTriple;
  evidenceHash?: string;
};

export type CyclicalValuationInput = {
  currency: string;
  asOf: string;
  midCycleEbitda: ScenarioTriple;
  normalizedNetCash: number;
  sharesOutstanding: number;
  replacementAssetValue?: ScenarioTriple;
  evEbitdaMultiple: ScenarioTriple;
  evidenceHash?: string;
};

export type QuantitativeOrigin = ValuationAssumption["origin"];

export type QuantitativeScenario = {
  discountRate?: number;
  costOfEquity?: number;
  terminalGrowthRate?: number;
};

export type EditableAssumption<T = number> = {
  key: string;
  label: string;
  value?: T;
  bear?: number;
  base?: number;
  bull?: number;
  unit?: string;
  origin: QuantitativeOrigin;
  evidenceRefs?: string[];
  confidence?: number;
  locked: boolean;
  explanation?: string;
  forecastYear?: number;
};

export type QuantitativeDraft = {
  method: ValuationMethod;
  archetype: CompanyArchetype;
  currency: string;
  asOf: string;
  scenarios?: Partial<Record<ValuationScenarioName, QuantitativeScenario>>;
  operating?: OperatingValuationInput;
  financial?: FinancialValuationInput;
  cyclical?: CyclicalValuationInput;
  assumptions?: EditableAssumption[];
  warnings?: string[];
};

export type QuantitativeValuationVersion = {
  id: string;
  runId: string;
  sourceSnapshotId: string;
  version: number;
  status: string;
  parentVersionId?: string;
  archetype: CompanyArchetype;
  method: ValuationMethod;
  horizonYears: number;
  draft?: QuantitativeDraft;
  result?: ValuationResult;
  decisionNote?: string;
  createdBy: string;
  createdAt: string;
};

export type QuantitativeValuationSnapshot = {
  id: string;
  market: string;
  asOf: string;
  payload?: unknown;
  evidenceHash?: string;
  contentHash: string;
  createdAt: string;
};

export type QuantitativeValuationWorkspace = {
  run?: ValuationRunSummary;
  snapshot?: QuantitativeValuationSnapshot;
  versions: QuantitativeValuationVersion[];
  actualReviews: NonNullable<ValuationResult["actualReviews"]>;
};

export type ActualReviewInput = {
  metricKey: string;
  forecastYear: number;
  forecastValue: number;
  actualValue: number;
};

export function withUserOverride<T>(base: EditableAssumption<T>, value: T): EditableAssumption<T> {
  return {
    ...base,
    value,
    origin: "user",
    locked: true,
  };
}

export function validateQuantitativeDraft(draft: QuantitativeDraft): void {
  for (const scenario of Object.values(draft.scenarios ?? {})) {
    if (!scenario) continue;
    if (draft.method === "dcf_3_statement") {
      if (scenario.discountRate !== undefined && scenario.terminalGrowthRate !== undefined && scenario.discountRate <= scenario.terminalGrowthRate) {
        throw new Error("WACC 必须高于永续增长率。");
      }
    }
    if (draft.method === "ddm_residual_income") {
      if (scenario.costOfEquity !== undefined && scenario.terminalGrowthRate !== undefined && scenario.costOfEquity <= scenario.terminalGrowthRate) {
        throw new Error("股权成本必须高于永续增长率。");
      }
    }
  }
}

export function calculateOperatingValuation(input: OperatingValuationInput): ValuationResult {
  validateQuantitativeDraft({
    method: "dcf_3_statement",
    archetype: "operating",
    currency: input.currency,
    asOf: input.asOf,
    scenarios: {
      bear: { discountRate: input.discountRate.high, terminalGrowthRate: input.terminalGrowthRate.low },
      base: { discountRate: input.discountRate.base, terminalGrowthRate: input.terminalGrowthRate.base },
      bull: { discountRate: input.discountRate.low, terminalGrowthRate: input.terminalGrowthRate.high },
    },
  });
  const scenarioValues = [
    ["bear", input.revenueGrowth.low, input.ebitMargin.low, input.capexRate.high, input.discountRate.high, input.terminalGrowthRate.low] as const,
    ["base", input.revenueGrowth.base, input.ebitMargin.base, input.capexRate.base, input.discountRate.base, input.terminalGrowthRate.base] as const,
    ["bull", input.revenueGrowth.high, input.ebitMargin.high, input.capexRate.low, input.discountRate.low, input.terminalGrowthRate.high] as const,
  ];
  const baseForecast = buildOperatingForecast(input, input.revenueGrowth.base, input.ebitMargin.base, input.capexRate.base);
  const scenarios = scenarioValues.map(([scenario, growth, margin, capexRate, discountRate, terminalGrowth]) => {
    const forecast = buildOperatingForecast(input, growth, margin, capexRate);
    const equityValue = dcfEquityValue(forecast.map((row) => row.freeCashFlow), discountRate, terminalGrowth, input.netDebt);
    return {
      scenario,
      equityValue,
      perShareValue: divideSafe(equityValue, input.sharesOutstanding),
      summary: `${scenarioLabel(scenario)}：收入增速 ${(growth * 100).toFixed(1)}%，EBIT率 ${(margin * 100).toFixed(1)}%，WACC ${(discountRate * 100).toFixed(1)}%。`,
    };
  });
  return {
    method: "dcf_3_statement",
    archetype: "operating",
    currency: input.currency,
    asOf: input.asOf,
    assumptions: operatingAssumptions(input),
    scenarios,
    forecastRows: baseForecast,
    sensitivity: buildOperatingSensitivity(input),
    peerRange: input.peerEvEbitda ? { low: input.peerEvEbitda.low, median: input.peerEvEbitda.base, high: input.peerEvEbitda.high, metric: "EV/EBITDA" } : undefined,
    evidenceHash: input.evidenceHash,
  };
}

export function calculateFinancialValuation(input: FinancialValuationInput, archetype: "bank" | "insurance" = "bank"): ValuationResult {
  validateQuantitativeDraft({
    method: "ddm_residual_income",
    archetype,
    currency: input.currency,
    asOf: input.asOf,
    scenarios: {
      bear: { costOfEquity: input.costOfEquity.high, terminalGrowthRate: input.terminalGrowthRate.low },
      base: { costOfEquity: input.costOfEquity.base, terminalGrowthRate: input.terminalGrowthRate.base },
      bull: { costOfEquity: input.costOfEquity.low, terminalGrowthRate: input.terminalGrowthRate.high },
    },
  });
  const scenarioValues = [
    ["bear", input.roe.low, input.payoutRatio.low, input.costOfEquity.high, input.terminalGrowthRate.low] as const,
    ["base", input.roe.base, input.payoutRatio.base, input.costOfEquity.base, input.terminalGrowthRate.base] as const,
    ["bull", input.roe.high, input.payoutRatio.high, input.costOfEquity.low, input.terminalGrowthRate.high] as const,
  ];
  const scenarios = scenarioValues.map(([scenario, roe, payoutRatio, costOfEquity, growth]) => {
    const earnings = input.bookValue * roe;
    const dividend = earnings * payoutRatio;
    const terminalValue = costOfEquity > growth ? (dividend * (1 + growth)) / (costOfEquity - growth) : 0;
    const residualIncomeValue = input.bookValue + (input.bookValue * (roe - costOfEquity)) / Math.max(costOfEquity - growth, 0.01);
    const equityValue = Math.max(0, (terminalValue + residualIncomeValue) / 2);
    return {
      scenario,
      equityValue,
      perShareValue: divideSafe(equityValue, input.sharesOutstanding),
      summary: `${scenarioLabel(scenario)}：ROE ${(roe * 100).toFixed(1)}%，派息率 ${(payoutRatio * 100).toFixed(1)}%，股权成本 ${(costOfEquity * 100).toFixed(1)}%。`,
    };
  });
  return {
    method: "ddm_residual_income",
    archetype,
    currency: input.currency,
    asOf: input.asOf,
    assumptions: financialAssumptions(input),
    scenarios,
    evidenceHash: input.evidenceHash,
  };
}

export function calculateCyclicalValuation(input: CyclicalValuationInput): ValuationResult {
  const scenarioValues = [
    ["bear", input.midCycleEbitda.low, input.evEbitdaMultiple.low, input.replacementAssetValue?.low] as const,
    ["base", input.midCycleEbitda.base, input.evEbitdaMultiple.base, input.replacementAssetValue?.base] as const,
    ["bull", input.midCycleEbitda.high, input.evEbitdaMultiple.high, input.replacementAssetValue?.high] as const,
  ];
  const scenarios = scenarioValues.map(([scenario, ebitda, multiple, assetValue]) => {
    const earningsValue = ebitda * multiple + input.normalizedNetCash;
    const equityValue = assetValue ? (earningsValue + assetValue) / 2 : earningsValue;
    return {
      scenario,
      equityValue,
      perShareValue: divideSafe(equityValue, input.sharesOutstanding),
      summary: `${scenarioLabel(scenario)}：中周期 EBITDA ${formatNumber(ebitda)}，EV/EBITDA ${multiple.toFixed(1)}x。`,
    };
  });
  return {
    method: "mid_cycle_nav",
    archetype: "cyclical",
    currency: input.currency,
    asOf: input.asOf,
    assumptions: cyclicalAssumptions(input),
    scenarios,
    peerRange: { low: input.evEbitdaMultiple.low, median: input.evEbitdaMultiple.base, high: input.evEbitdaMultiple.high, metric: "Mid-cycle EV/EBITDA" },
    evidenceHash: input.evidenceHash,
  };
}

export function calculateQuantitativeDraft(draft: QuantitativeDraft): ValuationResult {
  validateQuantitativeDraft(draft);
  if (draft.method === "ddm_residual_income") {
    if (!draft.financial) throw new Error("financial valuation input is required");
    return calculateFinancialValuation(draft.financial, draft.archetype === "insurance" ? "insurance" : "bank");
  }
  if (draft.method === "mid_cycle_nav") {
    if (!draft.cyclical) throw new Error("cyclical valuation input is required");
    return calculateCyclicalValuation(draft.cyclical);
  }
  if (!draft.operating) throw new Error("operating valuation input is required");
  return calculateOperatingValuation(draft.operating);
}

export function aggregateModelRange(results: ValuationResult["modelResults"] = []): { low?: number; base?: number; high?: number } {
  const weighted = results
    .map((result) => ({
      weight: result.weight ?? 1,
      low: result.low ?? result.perShareValue,
      base: result.perShareValue,
      high: result.high ?? result.perShareValue,
    }))
    .filter((result): result is { weight: number; low: number; base: number; high: number } =>
      Number.isFinite(result.weight) && result.weight > 0
      && Number.isFinite(result.low)
      && Number.isFinite(result.base)
      && Number.isFinite(result.high),
    );
  const totalWeight = weighted.reduce((sum, result) => sum + result.weight, 0);
  if (totalWeight <= 0) return {};
  return {
    low: weighted.reduce((sum, result) => sum + result.low * result.weight, 0) / totalWeight,
    base: weighted.reduce((sum, result) => sum + result.base * result.weight, 0) / totalWeight,
    high: weighted.reduce((sum, result) => sum + result.high * result.weight, 0) / totalWeight,
  };
}

export function calculateActualReview(rows: ActualReviewInput[]): NonNullable<ValuationResult["actualReviews"]> {
  return rows.map((row) => {
    const absoluteError = Math.abs(row.actualValue - row.forecastValue);
    return {
      ...row,
      absoluteError,
      percentageError: row.forecastValue === 0 ? undefined : absoluteError / Math.abs(row.forecastValue),
    };
  });
}

function buildOperatingForecast(input: OperatingValuationInput, revenueGrowth: number, ebitMargin: number, capexRate: number): ThreeStatementForecastRow[] {
  const rows: ThreeStatementForecastRow[] = [];
  let revenue = input.baseRevenue;
  for (let year = 1; year <= 5; year += 1) {
    const override = input.forecastOverrides?.find((item) => item.year === year);
    const yearGrowth = override?.revenueGrowth ?? revenueGrowth;
    const yearMargin = override?.ebitMargin ?? ebitMargin;
    const yearCapexRate = override?.capexRate ?? capexRate;
    const yearWorkingCapitalRate = override?.workingCapitalRate ?? input.workingCapitalRate;
    revenue *= 1 + yearGrowth;
    const ebit = revenue * yearMargin;
    const tax = Math.max(0, ebit * input.taxRate);
    const nopat = ebit - tax;
    const depreciationAmortization = revenue * input.depreciationRate;
    const capex = revenue * yearCapexRate;
    const workingCapitalChange = revenue * yearWorkingCapitalRate;
    const freeCashFlow = nopat + depreciationAmortization - capex - workingCapitalChange;
    rows.push({ year, revenue, ebit, tax, nopat, depreciationAmortization, capex, workingCapitalChange, freeCashFlow });
  }
  return rows;
}

function dcfEquityValue(cashFlows: number[], discountRate: number, terminalGrowthRate: number, netDebt: number) {
  if (discountRate <= terminalGrowthRate) return 0;
  let enterpriseValue = 0;
  for (let i = 0; i < cashFlows.length; i += 1) {
    enterpriseValue += cashFlows[i] / Math.pow(1 + discountRate, i + 1);
  }
  const terminalCashFlow = cashFlows[cashFlows.length - 1] * (1 + terminalGrowthRate);
  enterpriseValue += (terminalCashFlow / (discountRate - terminalGrowthRate)) / Math.pow(1 + discountRate, cashFlows.length);
  return Math.max(0, enterpriseValue - netDebt);
}

function buildOperatingSensitivity(input: OperatingValuationInput) {
  const discountRates = [input.discountRate.low, input.discountRate.base, input.discountRate.high];
  const terminalGrowthRates = [input.terminalGrowthRate.low, input.terminalGrowthRate.base, input.terminalGrowthRate.high];
  return terminalGrowthRates.flatMap((growth) =>
    discountRates.map((discount) => {
      const forecast = buildOperatingForecast(input, input.revenueGrowth.base, input.ebitMargin.base, input.capexRate.base);
      const equityValue = dcfEquityValue(forecast.map((row) => row.freeCashFlow), discount, growth, input.netDebt);
      return {
        row: `g ${(growth * 100).toFixed(1)}%`,
        column: `WACC ${(discount * 100).toFixed(1)}%`,
        discountRate: discount,
        terminalGrowthRate: growth,
        perShareValue: divideSafe(equityValue, input.sharesOutstanding),
      };
    }),
  );
}

function operatingAssumptions(input: OperatingValuationInput): ValuationAssumption[] {
  return [
    tripleAssumption("revenueGrowth", "收入增速", input.revenueGrowth, "%"),
    tripleAssumption("ebitMargin", "EBIT 利润率", input.ebitMargin, "%"),
    tripleAssumption("capexRate", "资本开支/收入", input.capexRate, "%"),
    tripleAssumption("discountRate", "WACC", input.discountRate, "%"),
    tripleAssumption("terminalGrowthRate", "永续增长率", input.terminalGrowthRate, "%"),
  ];
}

function financialAssumptions(input: FinancialValuationInput): ValuationAssumption[] {
  return [
    tripleAssumption("roe", "ROE", input.roe, "%"),
    tripleAssumption("payoutRatio", "派息率", input.payoutRatio, "%"),
    tripleAssumption("costOfEquity", "股权成本", input.costOfEquity, "%"),
    tripleAssumption("terminalGrowthRate", "长期增长率", input.terminalGrowthRate, "%"),
  ];
}

function cyclicalAssumptions(input: CyclicalValuationInput): ValuationAssumption[] {
  return [
    tripleAssumption("midCycleEbitda", "中周期 EBITDA", input.midCycleEbitda, "money"),
    tripleAssumption("evEbitdaMultiple", "EV/EBITDA 倍数", input.evEbitdaMultiple, "x"),
  ];
}

function tripleAssumption(key: string, label: string, value: ScenarioTriple, unit: string): ValuationAssumption {
  const multiplier = unit === "%" ? 100 : 1;
  return {
    key,
    label,
    low: value.low * multiplier,
    base: value.base * multiplier,
    high: value.high * multiplier,
    unit,
    origin: "ai",
    evidenceRefs: [],
    confidence: 0.55,
    locked: false,
  };
}

function divideSafe(value: number, denominator: number) {
  return denominator > 0 ? value / denominator : 0;
}

function scenarioLabel(value: string) {
  return value === "bear" ? "保守" : value === "bull" ? "乐观" : "中性";
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 1 }) : "0";
}
