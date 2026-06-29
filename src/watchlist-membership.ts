import { normalizeIdentity } from "./shared/report-identity";
import type { CompanyCandidate } from "./shared/report";
import type { WatchlistItem } from "./shared/user-research";

export type WatchlistMembership = "checking" | "present" | "absent" | "unavailable";

export function resolveWatchlistMembership(items: WatchlistItem[], company: CompanyCandidate): WatchlistMembership {
  const code = normalizeIdentity(company.code);
  const market = normalizeIdentity(company.listingPlace);
  return items.some((item) => normalizeIdentity(item.company.code) === code && normalizeIdentity(item.company.listingPlace) === market)
    ? "present"
    : "absent";
}

export function watchlistActionLabel(membership: WatchlistMembership) {
  if (membership === "checking") return "检查自选状态…";
  return membership === "present" ? "已加入自选" : "加入自选";
}
