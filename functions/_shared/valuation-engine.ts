import type { CompanyArchetype, ThreeStatementForecastRow, ValuationAssumption, ValuationMethod, ValuationResult } from "../../src/shared/valuation";

export type ValuationRouteInput = {
  industry?: string;
  sector?: string;
  companyName?: string;
  mainBusiness?: string;
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

export type ScenarioTriple = {
  low: number;
  base: number;
  high: number;
};

const OPERATING_KEYWORDS = /软件|互联网|消费|制造|医药|科技|半导体|电子|设备|食品|白酒|汽车|传媒|服务|零售|通信|云|AI|芯片/i;
const BANK_KEYWORDS = /银行|bank|金融控股|金融服务/i;
const INSURANCE_KEYWORDS = /保险|insurance|寿险|财险|再保险/i;
const CYCLICAL_KEYWORDS = /煤|铜|铝|钢|水泥|地产|航运|化工|石油|天然气|矿|稀土|锂|光伏|资源|周期/i;

export function routeValuationMethod(input: ValuationRouteInput): { archetype: CompanyArchetype; method: ValuationMethod } {
  const text = `${input.companyName ?? ""} ${input.industry ?? ""} ${input.sector ?? ""} ${input.mainBusiness ?? ""}`;
  if (BANK_KEYWORDS.test(text)) return { archetype: "bank", method: "ddm_residual_income" };
  if (INSURANCE_KEYWORDS.test(text)) return { archetype: "insurance", method: "ddm_residual_income" };
  if (CYCLICAL_KEYWORDS.test(text) && !OPERATING_KEYWORDS.test(text)) return { archetype: "cyclical", method: "mid_cycle_nav" };
  return { archetype: "operating", method: "dcf_3_statement" };
}

export function computeOperatingDcf(input: OperatingValuationInput): ValuationResult {
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

export function computeFinancialDdm(input: FinancialValuationInput, archetype: "bank" | "insurance" = "bank"): ValuationResult {
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

export function computeCyclicalMidCycle(input: CyclicalValuationInput): ValuationResult {
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

function buildOperatingForecast(input: OperatingValuationInput, revenueGrowth: number, ebitMargin: number, capexRate: number): ThreeStatementForecastRow[] {
  const rows: ThreeStatementForecastRow[] = [];
  let revenue = input.baseRevenue;
  for (let year = 1; year <= 5; year += 1) {
    revenue *= 1 + revenueGrowth;
    const ebit = revenue * ebitMargin;
    const tax = Math.max(0, ebit * input.taxRate);
    const nopat = ebit - tax;
    const depreciationAmortization = revenue * input.depreciationRate;
    const capex = revenue * capexRate;
    const workingCapitalChange = revenue * input.workingCapitalRate;
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
      return { row: `g ${(growth * 100).toFixed(1)}%`, column: `WACC ${(discount * 100).toFixed(1)}%`, perShareValue: divideSafe(equityValue, input.sharesOutstanding) };
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
