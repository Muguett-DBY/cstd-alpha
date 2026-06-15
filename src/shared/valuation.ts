export type CompanyArchetype = "operating" | "bank" | "insurance" | "cyclical";

export type ValuationMethod = "dcf_3_statement" | "ddm_residual_income" | "mid_cycle_nav";

export type ValuationScenarioName = "bear" | "base" | "bull";

export type ValuationAssumption = {
  key: string;
  label: string;
  low: number;
  base: number;
  high: number;
  unit: string;
  origin: "provider" | "formula" | "ai" | "user";
  evidenceRefs: string[];
  confidence: number;
  locked: boolean;
};

export type ValuationScenarioResult = {
  scenario: ValuationScenarioName;
  equityValue: number;
  perShareValue: number;
  summary: string;
};

export type ThreeStatementForecastRow = {
  year: number;
  revenue: number;
  ebit: number;
  tax: number;
  nopat: number;
  depreciationAmortization: number;
  capex: number;
  workingCapitalChange: number;
  freeCashFlow: number;
};

export type ValuationResult = {
  methodologyVersion?: number;
  method: ValuationMethod;
  archetype: CompanyArchetype;
  currency: string;
  asOf: string;
  assumptions: ValuationAssumption[];
  scenarios: ValuationScenarioResult[];
  forecastRows?: ThreeStatementForecastRow[];
  sensitivity?: Array<{ row: string; column: string; perShareValue: number }>;
  peerRange?: { low: number; median: number; high: number; metric: string };
  evidenceHash?: string;
};

export type ValuationRunStatus = "queued" | "running" | "completed" | "failed";

export type ValuationRunSummary = {
  id: string;
  researchItemId?: string;
  entityType: "company" | "industry";
  entityId: string;
  title: string;
  status: ValuationRunStatus;
  method: ValuationMethod;
  archetype: CompanyArchetype;
  currency: string;
  result?: ValuationResult;
  objectKey?: string;
  createdAt: string;
  updatedAt: string;
};
