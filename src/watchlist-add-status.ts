import type { WatchlistAddStatus } from "./shared/user-research";

export function watchlistAddToastMessage(companyName: string, status: WatchlistAddStatus) {
  return status === "updated"
    ? `${companyName} 已在自选股中，已同步最新公司信息。`
    : `${companyName} 已加入自选股，可在我的研究继续跟踪。`;
}
