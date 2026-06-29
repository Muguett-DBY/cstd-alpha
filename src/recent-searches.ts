import { getBrowserLocalStorage, type BrowserStorage } from "./browser-storage";

const RECENT_SEARCHES_KEY = "cstd-alpha:recent-searches";
const RECENT_SEARCHES_PROBE_KEY = "cstd-alpha:recent-searches:probe";
const RECENT_SEARCH_LIMIT = 8;

type RecentSearchWindow = Pick<Window, "localStorage">;

export type RecentSearchUpdate = {
  searches: string[];
  persisted: boolean;
  persistenceAvailable: boolean;
};

export function loadRecentSearches(browserWindow: RecentSearchWindow | undefined = typeof window === "undefined" ? undefined : window) {
  const storage = getRecentSearchStorage(browserWindow);
  if (!storage) return [];
  const raw = safeGetStorageItem(storage, RECENT_SEARCHES_KEY);
  if (!raw) return [];
  try {
    return normalizeRecentSearches(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function rememberRecentSearch(
  term: string,
  currentSearches: readonly string[],
  browserWindow: RecentSearchWindow | undefined = typeof window === "undefined" ? undefined : window,
): RecentSearchUpdate {
  const searches = buildRecentSearches(term, currentSearches);
  const storage = getRecentSearchStorage(browserWindow);
  const persistenceAvailable = Boolean(storage);
  const persisted = storage ? safeSetStorageItem(storage, RECENT_SEARCHES_KEY, JSON.stringify(searches)) : false;
  return { searches, persisted, persistenceAvailable };
}

export function canPersistRecentSearches(browserWindow: RecentSearchWindow | undefined = typeof window === "undefined" ? undefined : window) {
  const storage = getRecentSearchStorage(browserWindow);
  if (!storage) return false;
  try {
    storage.setItem(RECENT_SEARCHES_PROBE_KEY, "1");
    storage.removeItem(RECENT_SEARCHES_PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

function buildRecentSearches(term: string, currentSearches: readonly string[]) {
  const normalizedTerm = term.trim();
  if (!normalizedTerm) return normalizeRecentSearches(currentSearches);
  return normalizeRecentSearches([normalizedTerm, ...currentSearches.filter((search) => search.trim() !== normalizedTerm)]);
}

function normalizeRecentSearches(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const term = item.trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    normalized.push(term);
    if (normalized.length >= RECENT_SEARCH_LIMIT) break;
  }
  return normalized;
}

function getRecentSearchStorage(browserWindow: RecentSearchWindow | undefined) {
  return getBrowserLocalStorage(browserWindow);
}

function safeGetStorageItem(storage: BrowserStorage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorageItem(storage: BrowserStorage, key: string, value: string) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
