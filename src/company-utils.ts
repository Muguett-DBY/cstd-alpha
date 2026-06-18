import type { CompanyCandidate } from "./shared/report";

export function displayExchange(candidate: CompanyCandidate) {
  if (!candidate.exchange || /^\d+$/.test(candidate.exchange)) return candidate.source === "eastmoney" ? "东方财富" : "Yahoo";
  return candidate.exchange;
}
