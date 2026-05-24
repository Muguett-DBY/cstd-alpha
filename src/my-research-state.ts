import type { CompanyCandidate } from "./shared/report";
import type { TemplateAnalysisResult, WatchlistItem } from "./shared/user-research";

export function filterWatchlistItems(items: WatchlistItem[], query: string) {
  const needle = normalizeSearchText(query);
  if (!needle) return items;
  return items.filter((item) => normalizeSearchText(watchlistSearchText(item)).includes(needle));
}

export function summarizeWatchlistAnalysis(analyses: TemplateAnalysisResult[], watchlistId: string) {
  const related = analyses.filter((analysis) => analysis.watchlistId === watchlistId);
  return {
    total: related.length,
    completed: related.filter((analysis) => analysis.status === "completed").length,
    running: related.filter((analysis) => analysis.status === "running" || analysis.status === "pending").length,
    failed: related.filter((analysis) => analysis.status === "failed" || analysis.status === "failed_retryable").length,
  };
}

export function findWatchlistItemForCompany(items: WatchlistItem[], company: CompanyCandidate | null) {
  if (!company) return null;
  const code = normalizeSearchText(company.code);
  const listingPlace = normalizeSearchText(company.listingPlace);
  const exchange = normalizeSearchText(company.exchange);
  const name = normalizeSearchText(company.name);
  return (
    items.find((item) => {
      const itemCompany = item.company;
      const sameCode = normalizeSearchText(itemCompany.code) === code;
      const sameListing = !listingPlace || normalizeSearchText(itemCompany.listingPlace) === listingPlace;
      const sameExchange = !exchange || normalizeSearchText(itemCompany.exchange) === exchange;
      return sameCode && (sameListing || sameExchange);
    }) ??
    items.find((item) => normalizeSearchText(item.company.code) === code) ??
    items.find((item) => normalizeSearchText(item.company.name) === name) ??
    null
  );
}

function watchlistSearchText(item: WatchlistItem) {
  const company = item.company;
  return [
    company.name,
    company.code,
    company.exchange,
    company.listingPlace,
    company.marketType,
  ].join(" ");
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
