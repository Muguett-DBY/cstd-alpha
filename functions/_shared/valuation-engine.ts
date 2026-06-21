import type { CompanyArchetype, ValuationMethod, ValuationResult } from "../../src/shared/valuation";
import {
  calculateCyclicalValuation,
  calculateFinancialValuation,
  calculateOperatingValuation,
  type CyclicalValuationInput,
  type FinancialValuationInput,
  type OperatingValuationInput,
  type ScenarioTriple,
} from "../../src/shared/quantitative-valuation";

export type {
  CyclicalValuationInput,
  FinancialValuationInput,
  OperatingValuationInput,
  ScenarioTriple,
};

export type ValuationRouteInput = {
  industry?: string;
  sector?: string;
  companyName?: string;
  mainBusiness?: string;
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
  return calculateOperatingValuation(input);
}

export function computeFinancialDdm(input: FinancialValuationInput, archetype: "bank" | "insurance" = "bank"): ValuationResult {
  return calculateFinancialValuation(input, archetype);
}

export function computeCyclicalMidCycle(input: CyclicalValuationInput): ValuationResult {
  return calculateCyclicalValuation(input);
}
