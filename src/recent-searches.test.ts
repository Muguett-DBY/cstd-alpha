import { describe, expect, test } from "vitest";
import { canPersistRecentSearches, loadRecentSearches, rememberRecentSearch } from "./recent-searches";

describe("recent search persistence", () => {
  test("keeps the latest unique search terms within the visible history limit", () => {
    expect(rememberRecentSearch("  腾讯控股  ", ["贵州茅台", "腾讯控股", "宁德时代"]).searches).toEqual(["腾讯控股", "贵州茅台", "宁德时代"]);
    expect(rememberRecentSearch("新公司", ["a", "b", "c", "d", "e", "f", "g", "h"]).searches).toEqual(["新公司", "a", "b", "c", "d", "e", "f", "g"]);
  });

  test("does not throw when browser localStorage is blocked at the property getter", () => {
    const blockedWindow = {};
    Object.defineProperty(blockedWindow, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("localStorage disabled", "SecurityError");
      },
    });

    expect(loadRecentSearches(blockedWindow as Window)).toEqual([]);
    expect(rememberRecentSearch("万科A", [], blockedWindow as Window)).toEqual({
      searches: ["万科A"],
      persisted: false,
      persistenceAvailable: false,
    });
  });

  test("keeps the in-memory recent search update when persistence writes fail", () => {
    const storage = {
      getItem: () => JSON.stringify(["贵州茅台"]),
      setItem: () => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      },
      removeItem: () => undefined,
    } as Pick<Storage, "getItem" | "setItem">;

    expect(loadRecentSearches({ localStorage: storage } as Window)).toEqual(["贵州茅台"]);
    expect(rememberRecentSearch("宁德时代", ["贵州茅台"], { localStorage: storage } as Window)).toEqual({
      searches: ["宁德时代", "贵州茅台"],
      persisted: false,
      persistenceAvailable: true,
    });
    expect(canPersistRecentSearches({ localStorage: storage } as Window)).toBe(false);
  });

  test("detects writable browser persistence without keeping the probe key", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } as Pick<Storage, "getItem" | "setItem" | "removeItem">;

    expect(canPersistRecentSearches({ localStorage: storage } as Window)).toBe(true);
    expect(Array.from(values.keys())).toEqual([]);
  });
});
