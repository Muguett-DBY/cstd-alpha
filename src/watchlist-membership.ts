import { normalizeIdentity } from "./shared/report-identity";
import type { CompanyCandidate } from "./shared/report";
import type { WatchlistItem } from "./shared/user-research";

export type WatchlistMembership = "checking" | "present" | "absent" | "unavailable";

export type WatchlistMembershipPresentation = {
  status: WatchlistMembership;
  statusLabel: string;
  detail: string;
  actionLabel: string;
  actionDisabled: boolean;
  ariaBusy: boolean;
  showResearchLink: boolean;
};

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

export function watchlistMembershipPresentation(membership: WatchlistMembership): WatchlistMembershipPresentation {
  const actionLabel = watchlistActionLabel(membership);
  switch (membership) {
    case "checking":
      return {
        status: membership,
        statusLabel: "正在核验自选状态",
        detail: "正在同步云端自选股，避免重复加入。",
        actionLabel,
        actionDisabled: true,
        ariaBusy: true,
        showResearchLink: false,
      };
    case "present":
      return {
        status: membership,
        statusLabel: "已在自选研究中",
        detail: "可直接回到 My Research 查看模板、历史和研究进度。",
        actionLabel,
        actionDisabled: true,
        ariaBusy: false,
        showResearchLink: true,
      };
    case "absent":
      return {
        status: membership,
        statusLabel: "尚未加入自选",
        detail: "加入后可在 My Research 持续跟踪模板、笔记和报告。",
        actionLabel,
        actionDisabled: false,
        ariaBusy: false,
        showResearchLink: false,
      };
    case "unavailable":
      return {
        status: membership,
        statusLabel: "自选状态待确认",
        detail: "当前无法确认云端状态，仍可尝试加入自选。",
        actionLabel,
        actionDisabled: false,
        ariaBusy: false,
        showResearchLink: false,
      };
  }
}
