import { describe, expect, test, vi } from "vitest";
import {
  applyThemePreference,
  getBrowserThemeStorage,
  nextThemePreference,
  readThemePreference,
  resolveThemePreference,
  THEME_STORAGE_KEY,
} from "./theme";

describe("theme preferences", () => {
  test("falls back to system when storage is unavailable or invalid", () => {
    expect(readThemePreference()).toBe("system");
    expect(readThemePreference({ getItem: () => "sepia" })).toBe("system");
    expect(readThemePreference({ getItem: () => { throw new Error("blocked"); } })).toBe("system");
  });

  test("does not throw when browser localStorage is blocked at the property getter", () => {
    const blockedWindow = {};
    Object.defineProperty(blockedWindow, "localStorage", {
      get() {
        throw new Error("storage blocked");
      },
    });
    const writableStorage = { getItem: vi.fn(), setItem: vi.fn() };

    expect(getBrowserThemeStorage(blockedWindow as Pick<Window, "localStorage">)).toBeUndefined();
    expect(getBrowserThemeStorage({ localStorage: writableStorage } as Pick<Window, "localStorage">)).toBe(writableStorage);
  });

  test("resolves system preference and explicit overrides", () => {
    expect(resolveThemePreference("system", true)).toBe("dark");
    expect(resolveThemePreference("system", false)).toBe("light");
    expect(resolveThemePreference("light", true)).toBe("light");
    expect(resolveThemePreference("dark", false)).toBe("dark");
  });

  test("cycles through system, light, and dark preferences", () => {
    expect(nextThemePreference("system")).toBe("light");
    expect(nextThemePreference("light")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("system");
  });

  test("applies the resolved theme to the document and persists the preference", () => {
    const root = {
      dataset: {} as Record<string, string>,
      style: { colorScheme: "" },
    };
    const meta = { setAttribute: vi.fn() };
    const storage = { setItem: vi.fn() };

    const resolved = applyThemePreference("dark", {
      root,
      meta,
      storage,
      systemPrefersDark: false,
    });

    expect(resolved).toBe("dark");
    expect(root.dataset).toEqual({ theme: "dark", themePreference: "dark" });
    expect(root.style.colorScheme).toBe("dark");
    expect(meta.setAttribute).toHaveBeenCalledWith("content", "#101513");
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
  });
});
