import { describe, expect, test } from "vitest";
import { canWriteStorage, getBrowserLocalStorage, safeGetStorageItem, safeListStorageKeys, safeRemoveStorageItem, safeSetStorageItem } from "./browser-storage";

describe("browser storage helpers", () => {
  test("returns undefined when the browser localStorage getter is blocked", () => {
    const blockedWindow = {};
    Object.defineProperty(blockedWindow, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("localStorage disabled", "SecurityError");
      },
    });

    expect(getBrowserLocalStorage(blockedWindow as Window)).toBeUndefined();
  });

  test("reads, writes, removes, lists, and probes storage without leaking probe keys", () => {
    const storage = memoryStorage();

    expect(safeSetStorageItem(storage, "alpha", "1")).toBe(true);
    expect(safeGetStorageItem(storage, "alpha")).toBe("1");
    expect(safeListStorageKeys(storage, (key) => key.startsWith("a"))).toEqual(["alpha"]);
    expect(safeRemoveStorageItem(storage, "alpha")).toBe(true);
    expect(canWriteStorage(storage, "probe")).toBe(true);
    expect(safeListStorageKeys(storage)).toEqual([]);
  });

  test("treats throwing storage operations as unavailable instead of crashing", () => {
    const storage = throwingStorage();

    expect(safeGetStorageItem(storage, "alpha")).toBeNull();
    expect(safeSetStorageItem(storage, "alpha", "1")).toBe(false);
    expect(safeRemoveStorageItem(storage, "alpha")).toBe(false);
    expect(safeListStorageKeys(storage)).toEqual([]);
    expect(canWriteStorage(storage, "probe")).toBe(false);
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
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
      throw new DOMException("Blocked", "SecurityError");
    },
    clear: () => undefined,
    getItem: () => {
      throw new DOMException("Blocked", "SecurityError");
    },
    key: () => {
      throw new DOMException("Blocked", "SecurityError");
    },
    removeItem: () => {
      throw new DOMException("Blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("Blocked", "SecurityError");
    },
  };
}
