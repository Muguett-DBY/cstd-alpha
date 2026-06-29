import {
  getBrowserLocalStorage,
  safeGetStorageItem,
  safeSetStorageItem,
  type BrowserStorage,
} from "./browser-storage";
import { RESEARCH_STAGE_LABELS, RESEARCH_STAGES, type ResearchStage } from "./shared/research-workbench";

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

export type ResearchWorkspacePreferenceSummaryChip = {
  key: string;
  label: string;
  tone: "active" | "neutral";
};

export type ResearchWorkspacePreferenceSummary = {
  resultLabel: string;
  activeCount: number;
  chips: ResearchWorkspacePreferenceSummaryChip[];
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
const THESIS_FILTER_LABELS: Record<ResearchThesisFilter, string> = { all: "全部", with: "已有论点", without: "未生成" };
const SORT_ORDER_LABELS: Record<ResearchSortOrder, string> = { recent: "最近更新", name: "名称", stage: "阶段" };
const DATE_FILTER_LABELS: Record<ResearchDateFilter, string> = { all: "全部时间", today: "今天", week: "本周", month: "本月" };
const VIEW_MODE_LABELS: Record<ResearchViewMode, string> = { kanban: "看板", list: "列表", compact: "紧凑" };

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

export function describeResearchWorkspacePreferenceSummary(
  preferences: Pick<ResearchWorkspacePreferences, "queueQuery" | "stageFilter" | "thesisFilter" | "sortOrder" | "dateFilter" | "viewMode">,
  visibleCount: number,
  totalCount: number,
): ResearchWorkspacePreferenceSummary {
  const chips: ResearchWorkspacePreferenceSummaryChip[] = [];
  let activeCount = 0;
  const queueQuery = preferences.queueQuery.trim();

  if (queueQuery) {
    activeCount += 1;
    chips.push({ key: "query", label: `搜索：${truncateChipValue(queueQuery)}`, tone: "active" });
  }

  if (preferences.stageFilter !== "all") {
    activeCount += 1;
    chips.push({ key: "stage", label: `阶段：${RESEARCH_STAGE_LABELS[preferences.stageFilter]}`, tone: "active" });
  }

  if (preferences.thesisFilter !== "all") {
    activeCount += 1;
    chips.push({ key: "thesis", label: `论点：${THESIS_FILTER_LABELS[preferences.thesisFilter]}`, tone: "active" });
  }

  if (preferences.dateFilter !== "all") {
    activeCount += 1;
    chips.push({ key: "date", label: `时间：${DATE_FILTER_LABELS[preferences.dateFilter]}`, tone: "active" });
  }

  if (!chips.length && preferences.sortOrder === "recent") {
    chips.push({ key: "all", label: "全部队列", tone: "neutral" });
  }

  if (preferences.sortOrder !== "recent") {
    activeCount += 1;
    chips.push({ key: "sort", label: `排序：${SORT_ORDER_LABELS[preferences.sortOrder]}`, tone: "active" });
  } else {
    chips.push({ key: "sort", label: `排序：${SORT_ORDER_LABELS[preferences.sortOrder]}`, tone: "neutral" });
  }

  chips.push({ key: "view", label: `视图：${VIEW_MODE_LABELS[preferences.viewMode]}`, tone: "neutral" });

  return {
    resultLabel: `${normalizeCount(visibleCount)}/${normalizeCount(totalCount)} 项可见`,
    activeCount,
    chips,
  };
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

function truncateChipValue(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 18 ? `${normalized.slice(0, 18)}…` : normalized;
}

function normalizeCount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
