import type { ValuationRunSummary } from "./shared/valuation";

export function hasActiveValuationRuns(runs: ValuationRunSummary[]) {
  return runs.some((run) => run.status === "queued" || run.status === "running");
}

export function mergeValuationRuns(_current: ValuationRunSummary[], latest: ValuationRunSummary[]) {
  return latest;
}

export function filterValuationRunsForDisplay(runs: ValuationRunSummary[]) {
  return runs.filter((run) => run.status !== "completed" || (run.result?.methodologyVersion ?? 0) >= 2);
}
