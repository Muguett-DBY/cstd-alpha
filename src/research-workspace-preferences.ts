import {
  getBrowserLocalStorage,
  safeGetStorageItem,
  safeSetStorageItem,
  type BrowserStorage,
} from "./browser-storage";
import { RESEARCH_STAGES, type ResearchStage } from "./shared/research-workbench";

export type ResearchThesisFilter = "all" | "with" | "without";
export type ResearchSortOrder = "recent" | "name" | "stage";
export type ResearchDateFilter = "all" | "today" | "week" | "month";
export type ResearchViewMode = "kanban" | "list" | "compact";

export type ResearchWorkspacePreferences = {
  queueQuery: string;
  stageFilter: "all" | ResearchStage;
  thesisFilter: ResearchThesisFilter;
  sortOrder: ResearchSortOrder;
  dateFilter: ResearchDateFilter;
  viewMode: ResearchViewMode;
  itemOrder: Record<string, string[]>;
};

export const DEFAULT_RESEARCH_WORKSPACE_PREFERENCES: ResearchWorkspacePreferences = {
  queueQuery: "",
  stageFilter: "all",
  thesisFilter: "all",
  sortOrder: "recent",
  dateFilter: "all",
  viewMode: "kanban",
  itemOrder: {},
};

const STORAGE_KEYS = {
  queueQuery: "cstd_research_queue_query",
  stageFilter: "cstd_research_stage_filter",
  thesisFilter: "cstd_research_thesis_filter",
  sortOrder: "cstd_research_sort_order",
  dateFilter: "cstd_research_date_filter",
  viewMode: "cstd_research_view_mode",
  itemOrder: "cstd_research_item_order",
} as const satisfies Record<keyof ResearchWorkspacePreferences, string>;

const STAGE_FILTERS = new Set<string>(["all", ...RESEARCH_STAGES]);
const THESIS_FILTERS = new Set<ResearchThesisFilter>(["all", "with", "without"]);
const SORT_ORDERS = new Set<ResearchSortOrder>(["recent", "name", "stage"]);
const DATE_FILTERS = new Set<ResearchDateFilter>(["all", "today", "week", "month"]);
const VIEW_MODES = new Set<ResearchViewMode>(["kanban", "list", "compact"]);

export function loadResearchWorkspacePreferences(
  storage: BrowserStorage | undefined = getBrowserLocalStorage(),
): ResearchWorkspacePreferences {
  return {
    queueQuery: safeGetStorageItem(storage, STORAGE_KEYS.queueQuery) ?? "",
    stageFilter: readOption(storage, STORAGE_KEYS.stageFilter, STAGE_FILTERS, "all") as "all" | ResearchStage,
    thesisFilter: readOption(storage, STORAGE_KEYS.thesisFilter, THESIS_FILTERS, "all"),
    sortOrder: readOption(storage, STORAGE_KEYS.sortOrder, SORT_ORDERS, "recent"),
    dateFilter: readOption(storage, STORAGE_KEYS.dateFilter, DATE_FILTERS, "all"),
    viewMode: readOption(storage, STORAGE_KEYS.viewMode, VIEW_MODES, "kanban"),
    itemOrder: readItemOrder(storage),
  };
}

export function saveResearchWorkspacePreference<K extends keyof ResearchWorkspacePreferences>(
  preference: K,
  value: ResearchWorkspacePreferences[K],
  storage: BrowserStorage | undefined = getBrowserLocalStorage(),
) {
  const serialized = preference === "itemOrder" ? JSON.stringify(value) : String(value);
  return safeSetStorageItem(storage, STORAGE_KEYS[preference], serialized);
}

export function hasActiveResearchWorkspaceFilters(
  preferences: Pick<ResearchWorkspacePreferences, "queueQuery" | "stageFilter" | "thesisFilter" | "sortOrder" | "dateFilter">,
) {
  return Boolean(
    preferences.queueQuery
    || preferences.stageFilter !== "all"
    || preferences.thesisFilter !== "all"
    || preferences.sortOrder !== "recent"
    || preferences.dateFilter !== "all",
  );
}

function readOption<T extends string>(
  storage: BrowserStorage | undefined,
  key: string,
  options: ReadonlySet<string>,
  fallback: T,
): T {
  const value = safeGetStorageItem(storage, key);
  return value && options.has(value) ? value as T : fallback;
}

function readItemOrder(storage: BrowserStorage | undefined): Record<string, string[]> {
  const serialized = safeGetStorageItem(storage, STORAGE_KEYS.itemOrder);
  if (!serialized) return {};

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const order: Record<string, string[]> = {};
    for (const stage of RESEARCH_STAGES) {
      const value = (parsed as Record<string, unknown>)[stage];
      if (!Array.isArray(value)) continue;
      const ids = Array.from(new Set(value.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean)));
      if (ids.length) order[stage] = ids;
    }
    return order;
  } catch {
    return {};
  }
}
