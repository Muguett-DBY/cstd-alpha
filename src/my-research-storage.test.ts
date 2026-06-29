import { describe, expect, test } from "vitest";
import {
  buildCompanyNewsCacheKey,
  clearRecentTemplateIds,
  loadCachedCompanyNewsBundle,
  loadRecentTemplateIds,
  rememberRecentTemplateId,
  saveCachedCompanyNewsBundle,
} from "./my-research-storage";
import type { CompanyNewsBundle } from "./shared/news";
import type { WatchlistItem } from "./shared/user-research";

describe("my research storage", () => {
  test("keeps recent templates unique and bounded", () => {
    const storage = memoryStorage({
      cstd_recent_templates: JSON.stringify(["template-2", "template-1", "template-2", "", 3]),
    });

    expect(loadRecentTemplateIds(storage)).toEqual(["template-2", "template-1"]);
    expect(rememberRecentTemplateId("template-3", storage)).toEqual(["template-3", "template-2", "template-1"]);
    expect(rememberRecentTemplateId("template-4", storage)).toEqual(["template-4", "template-3", "template-2", "template-1"]);
    expect(rememberRecentTemplateId("template-5", storage)).toEqual(["template-5", "template-4", "template-3", "template-2"]);
  });

  test("does not throw when recent template storage is blocked", () => {
    const storage = throwingStorage();

    expect(loadRecentTemplateIds(storage)).toEqual([]);
    expect(rememberRecentTemplateId("template-1", storage)).toEqual(["template-1"]);
    expect(clearRecentTemplateIds(storage)).toBe(false);
  });

  test("loads and saves cached news bundles safely", () => {
    const storage = memoryStorage();
    const item = watchlistItem();
    const bundle = newsBundle();

    expect(buildCompanyNewsCacheKey(item)).toBe("cstd-news-cache:v5:A:CN:600519");
    expect(loadCachedCompanyNewsBundle(item, storage)).toBeNull();
    expect(saveCachedCompanyNewsBundle(item, bundle, storage)).toBe(true);
    expect(loadCachedCompanyNewsBundle(item, storage)).toEqual(bundle);
  });

  test("falls back from malformed or blocked news cache entries", () => {
    const item = watchlistItem();
    const storage = memoryStorage({ [buildCompanyNewsCacheKey(item)]: "{" });

    expect(loadCachedCompanyNewsBundle(item, storage)).toBeNull();
    expect(saveCachedCompanyNewsBundle(item, newsBundle(), throwingStorage())).toBe(false);
  });
});

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function throwingStorage(): Storage {
  return {
    get length() {
      return 0;
    },
    clear: () => undefined,
    getItem: () => {
      throw new DOMException("Blocked", "SecurityError");
    },
    key: () => null,
    removeItem: () => {
      throw new DOMException("Blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("Blocked", "SecurityError");
    },
  };
}

function watchlistItem(): WatchlistItem {
  return {
    id: "watch-1",
    company: {
      id: "maotai",
      name: "贵州茅台",
      code: "600519",
      listingPlace: "CN",
      marketType: "A",
      exchange: "SSE",
      currency: "CNY",
    },
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
  };
}

function newsBundle(): CompanyNewsBundle {
  const summary = {
    total: 0,
    positive: 0,
    negative: 0,
    neutral: 0,
    positivePct: 0,
    negativePct: 0,
    neutralPct: 0,
    overall: "neutral" as const,
    overallLabel: "中性",
    sourceCount: 0,
    sources: [],
    qualityLabel: "无样本",
  };

  return {
    company: watchlistItem().company,
    companyNews: [],
    industryNews: [],
    companySummary: summary,
    industrySummary: summary,
    companyQuery: "贵州茅台",
    industryQuery: "白酒",
    industryLabel: "白酒",
    fetchedAt: "2026-06-29T00:00:00.000Z",
  };
}
