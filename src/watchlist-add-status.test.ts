import { describe, expect, test } from "vitest";
import { watchlistAddToastMessage } from "./watchlist-add-status";

describe("watchlist add status copy", () => {
  test("distinguishes new and existing watchlist companies", () => {
    expect(watchlistAddToastMessage("贵州茅台", "created")).toContain("已加入自选股");
    expect(watchlistAddToastMessage("贵州茅台", "updated")).toContain("已在自选股中");
  });
});
