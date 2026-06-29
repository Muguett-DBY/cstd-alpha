import { describe, expect, test } from "vitest";
import { resolveWatchlistMembership, watchlistActionLabel, watchlistMembershipPresentation } from "./watchlist-membership";
import type { CompanyCandidate } from "./shared/report";
import type { WatchlistItem } from "./shared/user-research";

const company: CompanyCandidate = {
  id: "eastmoney:1.600519",
  name: "贵州茅台",
  code: "600519",
  exchange: "上海证券交易所",
  listingPlace: "A股",
  marketType: "AStock",
  source: "eastmoney",
};

describe("watchlist membership", () => {
  test("matches the API unique company identity", () => {
    expect(resolveWatchlistMembership([watchlistItem()], company)).toBe("present");
    expect(resolveWatchlistMembership([watchlistItem({ market: "港股" })], company)).toBe("absent");
  });

  test("normalizes code and listing place values", () => {
    expect(resolveWatchlistMembership([watchlistItem({ code: " 600519 ", market: " a股 " })], company)).toBe("present");
  });

  test("keeps checking and unavailable states distinct in the action copy", () => {
    expect(watchlistActionLabel("checking")).toBe("检查自选状态…");
    expect(watchlistActionLabel("present")).toBe("已加入自选");
    expect(watchlistActionLabel("absent")).toBe("加入自选");
    expect(watchlistActionLabel("unavailable")).toBe("加入自选");
  });

  test("describes the report header membership state for action grouping", () => {
    expect(watchlistMembershipPresentation("checking")).toMatchObject({
      statusLabel: "正在核验自选状态",
      actionDisabled: true,
      ariaBusy: true,
      showResearchLink: false,
    });
    expect(watchlistMembershipPresentation("present")).toMatchObject({
      statusLabel: "已在自选研究中",
      actionDisabled: true,
      showResearchLink: true,
    });
    expect(watchlistMembershipPresentation("absent")).toMatchObject({
      statusLabel: "尚未加入自选",
      actionDisabled: false,
      showResearchLink: false,
    });
    expect(watchlistMembershipPresentation("unavailable")).toMatchObject({
      statusLabel: "自选状态待确认",
      actionDisabled: false,
      showResearchLink: false,
    });
  });
});

function watchlistItem(overrides: { code?: string; market?: string } = {}): WatchlistItem {
  return {
    id: "watch-1",
    userId: "user-1",
    company: {
      ...company,
      code: overrides.code ?? company.code,
      listingPlace: overrides.market ?? company.listingPlace,
    },
    addedAt: "2026-06-30T00:00:00.000Z",
  };
}
