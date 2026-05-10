import { afterEach, describe, expect, test, vi } from "vitest";
import { loadLastReport, saveLastReport } from "./storage";
import { emptyReport, validateReportPayload } from "./shared/report";

describe("report storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("does not restore legacy DeepSeek empty-response fallback reports", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem("cstd-alpha:last-report", JSON.stringify(emptyReport("贵州茅台", "DeepSeek returned an empty final response. finish_reason=length")));

    expect(loadLastReport()).toBeNull();
  });

  test("restores validated real reports", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const report = validateReportPayload({
      company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
      asOf: "2026-05-10T00:00:00.000Z",
      conclusion: "观察",
      oneSentence: "真实报告",
      scoreItems20: [],
      evidence: [],
      sections: { companyOverview: "概况" },
      disclaimer: "仅供研究。",
    });

    saveLastReport(report);

    expect(loadLastReport()?.company).toMatchObject({ name: "贵州茅台", ticker: "600519" });
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
