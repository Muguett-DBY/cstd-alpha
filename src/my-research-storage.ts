import {
  getBrowserLocalStorage,
  safeGetStorageItem,
  safeRemoveStorageItem,
  safeSetStorageItem,
  type BrowserStorage,
} from "./browser-storage";
import type { CompanyNewsBundle } from "./shared/news";
import type { WatchlistItem } from "./shared/user-research";

const RECENT_TEMPLATE_KEY = "cstd_recent_templates";
const MAX_RECENT_TEMPLATES = 4;
const NEWS_CACHE_VERSION = "v5";

export function loadRecentTemplateIds(storage: BrowserStorage | undefined = getBrowserLocalStorage()) {
  return normalizeRecentTemplateIds(safeGetStorageItem(storage, RECENT_TEMPLATE_KEY));
}

export function rememberRecentTemplateId(templateId: string, storage: BrowserStorage | undefined = getBrowserLocalStorage()) {
  const normalizedId = templateId.trim();
  if (!normalizedId) return loadRecentTemplateIds(storage);
  const next = [normalizedId, ...loadRecentTemplateIds(storage).filter((id) => id !== normalizedId)].slice(0, MAX_RECENT_TEMPLATES);
  safeSetStorageItem(storage, RECENT_TEMPLATE_KEY, JSON.stringify(next));
  return next;
}

export function clearRecentTemplateIds(storage: BrowserStorage | undefined = getBrowserLocalStorage()) {
  return safeRemoveStorageItem(storage, RECENT_TEMPLATE_KEY);
}

export function loadCachedCompanyNewsBundle(item: WatchlistItem, storage: BrowserStorage | undefined = getBrowserLocalStorage()) {
  const raw = safeGetStorageItem(storage, buildCompanyNewsCacheKey(item));
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isCompanyNewsBundle(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedCompanyNewsBundle(
  item: WatchlistItem,
  bundle: CompanyNewsBundle,
  storage: BrowserStorage | undefined = getBrowserLocalStorage(),
) {
  return safeSetStorageItem(storage, buildCompanyNewsCacheKey(item), JSON.stringify(bundle));
}

export function buildCompanyNewsCacheKey(item: WatchlistItem) {
  const company = item.company;
  return `cstd-news-cache:${NEWS_CACHE_VERSION}:${company.marketType || ""}:${company.listingPlace || ""}:${company.code || company.name}`;
}

function normalizeRecentTemplateIds(serialized: string | null) {
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))).slice(0, MAX_RECENT_TEMPLATES);
  } catch {
    return [];
  }
}

function isCompanyNewsBundle(value: unknown): value is CompanyNewsBundle {
  if (!value || typeof value !== "object") return false;
  const bundle = value as Partial<CompanyNewsBundle>;
  return Boolean(
    bundle.fetchedAt
    && Array.isArray(bundle.companyNews)
    && Array.isArray(bundle.industryNews)
    && bundle.companySummary
    && bundle.industrySummary,
  );
}
