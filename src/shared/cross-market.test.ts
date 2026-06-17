import { describe, expect, test } from "vitest";
import { crossMarketAnchorForListing, crossMarketAnchorTickersForListings } from "./cross-market";

describe("cross-market anchors", () => {
  test("returns A-share anchor for known Hong Kong ticker", () => {
    const result = crossMarketAnchorForListing("06030", "港股");
    expect(result).toEqual({ anchorTicker: "600030" });
  });

  test("returns anchor for HKEX-listed stock", () => {
    const result = crossMarketAnchorForListing("06030", "HONG KONG");
    expect(result).toEqual({ anchorTicker: "600030" });
  });

  test("returns undefined for unknown Hong Kong ticker", () => {
    const result = crossMarketAnchorForListing("09999", "港股");
    expect(result).toBeUndefined();
  });

  test("returns undefined for A-share ticker", () => {
    const result = crossMarketAnchorForListing("000001", "A股");
    expect(result).toBeUndefined();
  });

  test("returns undefined for US stock", () => {
    const result = crossMarketAnchorForListing("AAPL", "美股");
    expect(result).toBeUndefined();
  });

  test("returns undefined for null market", () => {
    const result = crossMarketAnchorForListing("00700", null);
    expect(result).toBeUndefined();
  });

  test("returns undefined for undefined ticker", () => {
    const result = crossMarketAnchorForListing(undefined, "港股");
    expect(result).toBeUndefined();
  });

  test("pads short HK ticker to 5 digits", () => {
    const result = crossMarketAnchorForListing("6030", "港股");
    expect(result).toEqual({ anchorTicker: "600030" });
  });

  test("extracts anchor for each HK listing with known mapping", () => {
    const result = crossMarketAnchorTickersForListings([
      { ticker: "00941", market: "港股" },
      { ticker: "06030", market: "HKEX" },
      { ticker: "AAPL", market: "美股" },
    ]);
    expect(result).toEqual(["600941", "600030"]);
  });

  test("returns empty array when no HK listings have anchors", () => {
    const result = crossMarketAnchorTickersForListings([
      { ticker: "00001", market: "港股" },
      { ticker: "AAPL", market: "美股" },
    ]);
    expect(result).toEqual([]);
  });

  test("handles empty listings array", () => {
    const result = crossMarketAnchorTickersForListings([]);
    expect(result).toEqual([]);
  });

  test("deduplicates same anchor ticker from multiple listings", () => {
    const result = crossMarketAnchorTickersForListings([
      { ticker: "02318", market: "港股" },
      { ticker: "02318", market: "HKEX" },
    ]);
    expect(result).toEqual(["601318"]);
  });
});
