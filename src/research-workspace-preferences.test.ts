import { describe, expect, test } from "vitest";
import {
  DEFAULT_RESEARCH_WORKSPACE_PREFERENCES,
  hasActiveResearchWorkspaceFilters,
  loadResearchWorkspacePreferences,
  saveResearchWorkspacePreference,
} from "./research-workspace-preferences";

describe("research workspace preferences", () => {
  test("loads valid persisted filters, sorting, view mode, and item order", () => {
    const storage = memoryStorage({
      cstd_research_queue_query: "贵州茅台",
      cstd_research_stage_filter: "deepResearch",
      cstd_research_thesis_filter: "with",
      cstd_research_sort_order: "name",
      cstd_research_date_filter: "week",
      cstd_research_view_mode: "compact",
      cstd_research_item_order: JSON.stringify({ screening: ["item-2", "item-1"] }),
    });

    expect(loadResearchWorkspacePreferences(storage)).toEqual({
      queueQuery: "贵州茅台",
      stageFilter: "deepResearch",
      thesisFilter: "with",
      sortOrder: "name",
      dateFilter: "week",
      viewMode: "compact",
      itemOrder: { screening: ["item-2", "item-1"] },
    });
  });

  test("falls back from invalid enum values and sanitizes malformed item order", () => {
    const storage = memoryStorage({
      cstd_research_stage_filter: "not-a-stage",
      cstd_research_thesis_filter: "sometimes",
      cstd_research_sort_order: "random",
      cstd_research_date_filter: "year",
      cstd_research_view_mode: "grid",
      cstd_research_item_order: JSON.stringify({
        screening: ["item-1", "", "item-1", 3],
        deepResearch: "item-2",
        unknown: ["item-3"],
      }),
    });

    expect(loadResearchWorkspacePreferences(storage)).toEqual({
      ...DEFAULT_RESEARCH_WORKSPACE_PREFERENCES,
      itemOrder: { screening: ["item-1"] },
    });
  });

  test("falls back when persisted item order is not valid JSON", () => {
    const storage = memoryStorage({ cstd_research_item_order: "{" });

    expect(loadResearchWorkspacePreferences(storage).itemOrder).toEqual({});
  });

  test("persists new date and view preferences through the shared adapter", () => {
    const storage = memoryStorage();

    expect(saveResearchWorkspacePreference("dateFilter", "month", storage)).toBe(true);
    expect(saveResearchWorkspacePreference("viewMode", "list", storage)).toBe(true);
    expect(storage.getItem("cstd_research_date_filter")).toBe("month");
    expect(storage.getItem("cstd_research_view_mode")).toBe("list");
  });

  test("reports write failure without throwing", () => {
    const storage = throwingStorage();

    expect(saveResearchWorkspacePreference("sortOrder", "stage", storage)).toBe(false);
  });

  test("treats non-default sorting or date as active filters", () => {
    expect(hasActiveResearchWorkspaceFilters({
      queueQuery: "",
      stageFilter: "all",
      thesisFilter: "all",
      sortOrder: "name",
      dateFilter: "all",
    })).toBe(true);
    expect(hasActiveResearchWorkspaceFilters({
      queueQuery: "",
      stageFilter: "all",
      thesisFilter: "all",
      sortOrder: "recent",
      dateFilter: "week",
    })).toBe(true);
    expect(hasActiveResearchWorkspaceFilters(DEFAULT_RESEARCH_WORKSPACE_PREFERENCES)).toBe(false);
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
    getItem: () => null,
    key: () => null,
    removeItem: () => undefined,
    setItem: () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    },
  };
}
