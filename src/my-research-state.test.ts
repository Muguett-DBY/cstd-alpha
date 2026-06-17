import { describe, expect, test } from "vitest";
import { filterWatchlistItems, findWatchlistItemForCompany, summarizeWatchlistAnalysis } from "./my-research-state";
import type { CompanyCandidate } from "./shared/report";
import type { TemplateAnalysisResult, WatchlistItem } from "./shared/user-research";

function makeWatchlistItem(overrides: Partial<WatchlistItem> & { company: CompanyCandidate }): WatchlistItem {
  return {
    id: "w1",
    userId: "user1",
    reportLibraryId: undefined,
    createdAt: "2026-01-01",
    ...overrides,
  };
}

function makeCompany(overrides: Partial<CompanyCandidate> = {}): CompanyCandidate {
  return {
    id: "test:000001",
    name: "Test Company",
    code: "000001",
    exchange: "SZ",
    listingPlace: "A股",
    marketType: "A",
    source: "eastmoney",
    ...overrides,
  };
}

describe("filterWatchlistItems", () => {
  const items = [
    makeWatchlistItem({ id: "w1", company: makeCompany({ name: "腾讯控股", code: "00700" }) }),
    makeWatchlistItem({ id: "w2", company: makeCompany({ name: "阿里巴巴", code: "BABA" }) }),
  ];

  test("returns all items when query is empty", () => {
    expect(filterWatchlistItems(items, "")).toHaveLength(2);
    expect(filterWatchlistItems(items, "  ")).toHaveLength(2);
  });

  test("filters by company name", () => {
    const result = filterWatchlistItems(items, "腾讯");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("w1");
  });

  test("filters by company code", () => {
    const result = filterWatchlistItems(items, "00700");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("w1");
  });

  test("filters case-insensitively", () => {
    const result = filterWatchlistItems(items, "baba");
    expect(result).toHaveLength(1);
  });

  test("returns empty array when nothing matches", () => {
    expect(filterWatchlistItems(items, "nothing")).toHaveLength(0);
  });

  test("handles empty list", () => {
    expect(filterWatchlistItems([], "test")).toHaveLength(0);
  });
});

describe("summarizeWatchlistAnalysis", () => {
  function makeAnalysis(overrides: Partial<TemplateAnalysisResult> = {}): TemplateAnalysisResult {
    return {
      id: "a1",
      watchlistId: "w1",
      templateId: "t1",
      templateTitle: "Test",
      status: "completed",
      resultMarkdown: "analysis",
      evidenceCount: 0,
      generatedAt: "2026-01-01",
      expiresAt: "2026-02-01",
      ...overrides,
    };
  }

  test("counts completed analyses", () => {
    const result = summarizeWatchlistAnalysis([makeAnalysis({ status: "completed", watchlistId: "w1" })], "w1");
    expect(result.total).toBe(1);
    expect(result.completed).toBe(1);
  });

  test("counts running and pending analyses", () => {
    const result = summarizeWatchlistAnalysis(
      [makeAnalysis({ status: "running", watchlistId: "w1" }), makeAnalysis({ status: "pending", watchlistId: "w1" })],
      "w1",
    );
    expect(result.running).toBe(2);
  });

  test("counts failed analyses", () => {
    const result = summarizeWatchlistAnalysis(
      [makeAnalysis({ status: "failed", watchlistId: "w1" }), makeAnalysis({ status: "failed_retryable", watchlistId: "w1" })],
      "w1",
    );
    expect(result.failed).toBe(2);
  });

  test("filters by watchlistId", () => {
    const result = summarizeWatchlistAnalysis(
      [makeAnalysis({ watchlistId: "w1" }), makeAnalysis({ watchlistId: "w2" })],
      "w1",
    );
    expect(result.total).toBe(1);
  });

  test("handles empty analyses array", () => {
    const result = summarizeWatchlistAnalysis([], "w1");
    expect(result.total).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.running).toBe(0);
    expect(result.failed).toBe(0);
  });
});

describe("findWatchlistItemForCompany", () => {
  const items = [
    makeWatchlistItem({ id: "w1", company: makeCompany({ name: "腾讯控股", code: "00700", listingPlace: "港股", exchange: "HKEX" }) }),
    makeWatchlistItem({ id: "w2", company: makeCompany({ name: "阿里巴巴", code: "BABA", listingPlace: "美股", exchange: "NASDAQ" }) }),
  ];

  test("matches by code and listing place", () => {
    const company = makeCompany({ code: "00700", listingPlace: "港股" });
    const result = findWatchlistItemForCompany(items, company);
    expect(result?.id).toBe("w1");
  });

  test("matches by code alone when listing place differs", () => {
    const company = makeCompany({ code: "00700", listingPlace: "A股" });
    const result = findWatchlistItemForCompany(items, company);
    expect(result?.id).toBe("w1");
  });

  test("matches by company name", () => {
    const company = makeCompany({ code: "UNKNOWN", name: "腾讯控股" });
    const result = findWatchlistItemForCompany(items, company);
    expect(result?.id).toBe("w1");
  });

  test("returns null when no match found", () => {
    const company = makeCompany({ code: "999999", name: "Nonexistent" });
    expect(findWatchlistItemForCompany(items, company)).toBeNull();
  });

  test("returns null for null company", () => {
    expect(findWatchlistItemForCompany(items, null)).toBeNull();
  });

  test("handles empty items array", () => {
    expect(findWatchlistItemForCompany([], makeCompany())).toBeNull();
  });
});
