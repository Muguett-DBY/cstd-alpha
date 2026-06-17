import type { ValuationAssumption, ValuationRunSummary } from "./shared/valuation";

export type ValuationAssumptionDisplay = {
  key: string;
  label: string;
  value: string;
  meta: string;
};

const ASSUMPTION_DISPLAY_ORDER = [
  "revenueGrowth",
  "ebitMargin",
  "roe",
  "payoutRatio",
  "midCycleEbitda",
  "evEbitdaMultiple",
  "discountRate",
  "costOfEquity",
  "terminalGrowthRate",
  "capexRate",
];

export function hasActiveValuationRuns(runs: ValuationRunSummary[]) {
  return runs.some((run) => run.status === "queued" || run.status === "running");
}

export function mergeValuationRuns(_current: ValuationRunSummary[], latest: ValuationRunSummary[]) {
  return latest;
}

export function filterValuationRunsForDisplay(runs: ValuationRunSummary[]) {
  return runs.filter((run) => run.status !== "completed" || (run.result?.methodologyVersion ?? 0) >= 2);
}

export function valuationAssumptionsForDisplay(run: ValuationRunSummary, limit = 5): ValuationAssumptionDisplay[] {
  const assumptions = run.result?.assumptions ?? [];
  return [...assumptions]
    .sort((left, right) => assumptionOrder(left.key) - assumptionOrder(right.key))
    .slice(0, limit)
    .map((assumption) => ({
      key: assumption.key,
      label: assumption.label,
      value: formatAssumptionValue(assumption),
      meta: formatAssumptionMeta(assumption),
    }));
}

function assumptionOrder(key: string) {
  const index = ASSUMPTION_DISPLAY_ORDER.indexOf(key);
  return index >= 0 ? index : ASSUMPTION_DISPLAY_ORDER.length;
}

function formatAssumptionValue(assumption: ValuationAssumption) {
  if (assumption.unit === "%") return `${formatCompactNumber(assumption.base)}%`;
  if (assumption.unit === "x") return `${formatCompactNumber(assumption.base)}x`;
  if (assumption.unit === "money") return formatCompactNumber(assumption.base);
  return `${formatCompactNumber(assumption.base)}${assumption.unit ? ` ${assumption.unit}` : ""}`;
}

function formatAssumptionMeta(assumption: ValuationAssumption) {
  const parts = [];
  if (assumption.locked) parts.push("锁定");
  parts.push(`置信 ${Math.round(assumption.confidence * 100)}%`);
  parts.push(`证据 ${assumption.evidenceRefs.length}`);
  return parts.join(" / ");
}

function formatCompactNumber(value: number) {
  return Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : "-";
}
