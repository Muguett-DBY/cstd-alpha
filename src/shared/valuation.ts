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

export type ValuationSensitivityPoint = {
  row: string;
  column: string;
  discountRate: number;
  terminalGrowthRate: number;
  perShareValue: number;
};

export type ValuationResult = {
  methodologyVersion?: number;
  quantitativeVersionId?: string;
  sourceSnapshotId?: string;
  warnings?: string[];
  method: ValuationMethod;
  archetype: CompanyArchetype;
  currency: string;
  asOf: string;
  assumptions: ValuationAssumption[];
  scenarios: ValuationScenarioResult[];
  forecastRows?: ThreeStatementForecastRow[];
  sensitivity?: ValuationSensitivityPoint[];
  peerRange?: { low: number; median: number; high: number; metric: string };
  evidenceHash?: string;
  modelResults?: Array<{ modelKey: string; weight?: number; perShareValue?: number; low?: number; high?: number; summary?: string }>;
  actualReviews?: Array<{ metricKey: string; forecastYear: number; forecastValue: number; actualValue: number; absoluteError: number; percentageError?: number }>;
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
