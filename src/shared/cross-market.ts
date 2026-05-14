export type CrossMarketAnchor = {
  anchorTicker: string;
};

const HK_TO_A_SHARE_ANCHORS: Record<string, CrossMarketAnchor> = {
  "00300": { anchorTicker: "000333" },
  "00386": { anchorTicker: "600028" },
  "00728": { anchorTicker: "601728" },
  "00762": { anchorTicker: "600050" },
  "00857": { anchorTicker: "601857" },
  "00939": { anchorTicker: "601939" },
  "00941": { anchorTicker: "600941" },
  "00981": { anchorTicker: "688981" },
  "01088": { anchorTicker: "601088" },
  "01211": { anchorTicker: "002594" },
  "01288": { anchorTicker: "601288" },
  "01398": { anchorTicker: "601398" },
  "01772": { anchorTicker: "002460" },
  "02318": { anchorTicker: "601318" },
  "02333": { anchorTicker: "601633" },
  "02359": { anchorTicker: "603259" },
  "02600": { anchorTicker: "601600" },
  "03606": { anchorTicker: "600660" },
  "03750": { anchorTicker: "300750" },
  "03968": { anchorTicker: "600036" },
  "03988": { anchorTicker: "601988" },
  "06030": { anchorTicker: "600030" },
  "06690": { anchorTicker: "600690" },
  "06886": { anchorTicker: "601688" },
  "09696": { anchorTicker: "002466" },
};

export function crossMarketAnchorForListing(ticker: unknown, market: unknown) {
  if (!isHongKongListing(market)) return undefined;
  return HK_TO_A_SHARE_ANCHORS[normalizeHongKongTicker(ticker)];
}

export function crossMarketAnchorTickersForListings(listings: Array<{ ticker?: string; market?: string }>) {
  const tickers = new Set<string>();
  for (const listing of listings) {
    const anchor = crossMarketAnchorForListing(listing.ticker, listing.market);
    if (anchor?.anchorTicker) tickers.add(anchor.anchorTicker);
  }
  return Array.from(tickers);
}

function normalizeHongKongTicker(value: unknown) {
  if (typeof value !== "string") return "";
  const digits = value.trim().match(/\d+/)?.[0] ?? "";
  return digits ? digits.padStart(5, "0") : "";
}

function isHongKongListing(value: unknown) {
  if (typeof value !== "string") return false;
  const text = value.trim().toUpperCase();
  return /港股|HK|HKG|HKEX|HONG KONG|香港/.test(text);
}
