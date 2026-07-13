import { describe, expect, test, vi } from "vitest";
import { persistRankingReportImport } from "./ranking-import";
import type { InvestmentReport } from "./shared/report";

describe("ranking report import scope", () => {
  test("keeps non-admin imports local without mutating the global report library", async () => {
    const reports = [{ company: { name: "测试公司" } }] as InvestmentReport[];
    const importGlobal = vi.fn();
    const localEntries = [{ report: reports[0], importedAt: "2026-07-13T00:00:00.000Z" }];
    const upsertLocal = vi.fn(() => localEntries);

    const result = await persistRankingReportImport(reports, false, { importGlobal, upsertLocal });

    expect(importGlobal).not.toHaveBeenCalled();
    expect(upsertLocal).toHaveBeenCalledWith(reports);
    expect(result).toEqual({ saved: [], imported: localEntries, scope: "local" });
  });

  test("syncs admin imports globally before updating the local ranking cache", async () => {
    const reports = [{ company: { name: "测试公司" } }] as InvestmentReport[];
    const saved = [{ id: "report-1" }];
    const importGlobal = vi.fn(async () => saved);
    const upsertLocal = vi.fn(() => []);

    const result = await persistRankingReportImport(reports, true, { importGlobal, upsertLocal });

    expect(importGlobal).toHaveBeenCalledWith(reports);
    expect(upsertLocal).toHaveBeenCalledWith(reports);
    expect(result).toEqual({ saved, imported: [], scope: "global" });
  });
});
