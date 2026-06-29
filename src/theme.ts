import { useEffect, useState } from "react";
import { getBrowserLocalStorage } from "./browser-storage";

export const THEME_STORAGE_KEY = "cstd-alpha:theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

type StorageReader = { getItem(key: string): string | null };
type StorageWriter = { setItem(key: string, value: string): void };
type ThemeRoot = {
  dataset: {
    theme?: string;
    themePreference?: string;
  };
  style: { colorScheme: string };
};
type ThemeMeta = { setAttribute(name: string, value: string): void };

const themeOrder: ThemePreference[] = ["system", "light", "dark"];

export function getBrowserThemeStorage(
  browserWindow: Pick<Window, "localStorage"> | undefined = typeof window === "undefined" ? undefined : window,
): (StorageReader & StorageWriter) | undefined {
  return getBrowserLocalStorage(browserWindow);
}

export function readThemePreference(storage?: StorageReader): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function resolveThemePreference(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  const index = themeOrder.indexOf(preference);
  return themeOrder[(index + 1) % themeOrder.length];
}

export function applyThemePreference(
  preference: ThemePreference,
  options: {
    root: ThemeRoot;
    meta?: ThemeMeta | null;
    storage?: StorageWriter;
    systemPrefersDark: boolean;
  },
) {
  const resolved = resolveThemePreference(preference, options.systemPrefersDark);
  options.root.dataset.theme = resolved;
  options.root.dataset.themePreference = preference;
  options.root.style.colorScheme = resolved;
  options.meta?.setAttribute("content", resolved === "dark" ? "#101513" : "#f2f3ef");
  try {
    options.storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Theme still applies when storage is blocked or full.
  }
  return resolved;
}

export function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    readThemePreference(getBrowserThemeStorage()),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemPrefersDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    applyThemePreference(preference, {
      root: document.documentElement,
      meta: document.querySelector('meta[name="theme-color"]'),
      storage: getBrowserThemeStorage(),
      systemPrefersDark,
    });
  }, [preference, systemPrefersDark]);

  return {
    preference,
    resolvedTheme: resolveThemePreference(preference, systemPrefersDark),
    setPreference,
  };
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}
