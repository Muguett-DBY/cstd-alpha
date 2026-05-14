import { describe, expect, test } from "vitest";
import { buildReportLibraryEntry, normalizeEntryConclusion, normalizeEntryPositionAdvice } from "./report-library";
import { validateReportPayload } from "./report";

describe("report library entries", () => {
  test("normalizes stale buy and hold position advice for ranking entries", () => {
    expect(normalizeEntryPositionAdvice("买入", "观察仓", 80, 80)).toBe("标准仓 8-15%");
    expect(normalizeEntryPositionAdvice("加仓", "观察仓", 90, 90)).toBe("15-20% 上限");
    expect(normalizeEntryPositionAdvice("持有", "观察仓", 75, 70)).toBe("小仓 3-8%");
    expect(normalizeEntryPositionAdvice("回避", "0-3% 观察上限")).toBe("0%");
    expect(normalizeEntryPositionAdvice("卖出", "观察仓")).toBe("0%");
  });

  test("downgrades stale bullish entry conclusions when scores do not support them", () => {
    expect(normalizeEntryConclusion("买入", 50.74, 50.95)).toBe("观察");
    expect(normalizeEntryConclusion("买入", 72, 70)).toBe("持有");
    expect(normalizeEntryConclusion("买入", 80, 78)).toBe("买入");
  });

  test("builds report library entries from normalized report decisions", () => {
    const report = validateReportPayload({
      company: { name: "测试公司", ticker: "600000", market: "SH-A", industry: "银行Ⅱ" },
      conclusion: "回避",
      cqs: 55,
      ias: 55,
      summaryDashboard: { positionAdvice: "0-3% 观察上限" },
      evidence: [
        { title: "财报", source: "公开财报", url: "https://example.com", retrievedAt: "2026-05-14T00:00:00.000Z", freshness: "latest-public", notes: "ok" },
        { title: "行情", source: "公开行情", url: "https://example.com/quote", retrievedAt: "2026-05-14T00:00:00.000Z", freshness: "latest-public", notes: "ok" },
      ],
    });

    const entry = buildReportLibraryEntry(report, "id", "2026-05-14T00:00:00.000Z");

    expect(entry.conclusion).toBe("回避");
    expect(entry.positionAdvice).toBe("0%");
    expect(entry.industry).toBe("银行");
  });
});
