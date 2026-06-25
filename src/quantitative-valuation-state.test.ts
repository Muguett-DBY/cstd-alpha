import { describe, expect, test } from "vitest";
import {
  applyDraftEdit,
  applySensitivityPoint,
  buildDraftDecisionNote,
  compareQuantitativeDrafts,
  createDraftHistory,
  describeQuantitativeSaveGuidance,
  draftWarnings,
  findAssumption,
  pushDraftHistory,
  undoDraftHistory,
  userLockedAssumptions,
} from "./quantitative-valuation-state";
import type { QuantitativeDraft } from "./shared/quantitative-valuation";

describe("quantitative valuation editor state", () => {
  test("parses percentage input and creates a user lock", () => {
    const next = applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" });

    expect(findAssumption(next, "revenueGrowth")).toMatchObject({ base: 12.5, origin: "user", locked: true });
    expect(next.operating?.revenueGrowth.base).toBe(0.125);
  });

  test("returns an error when terminal growth is not below WACC", () => {
    const next = applyDraftEdit(baseDraft(), { key: "terminalGrowthRate", scenario: "base", rawValue: "10" });

    expect(draftWarnings(next)).toContainEqual(expect.objectContaining({ level: "error", message: "WACC 必须高于永续增长率。" }));
  });

  test("stores an advanced yearly override and applies it to calculation input", () => {
    const next = applyDraftEdit(baseDraft(), { key: "ebitMargin", scenario: "base", forecastYear: 2, rawValue: "20" });

    expect(findAssumption(next, "ebitMargin", 2)).toMatchObject({ base: 20, forecastYear: 2, origin: "user", locked: true });
    expect(next.operating?.forecastOverrides).toContainEqual(expect.objectContaining({ year: 2, ebitMargin: 0.2 }));
  });

  test("sends only assumptions explicitly edited by the user", () => {
    const next = applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" });

    expect(userLockedAssumptions(next).map((item) => item.key)).toEqual(["revenueGrowth"]);
  });

  test("edits revenue base as a direct operating amount", () => {
    const next = applyDraftEdit(baseDraft(), { key: "baseRevenue", scenario: "base", rawValue: "1800" });

    expect(findAssumption(next, "baseRevenue")).toMatchObject({ base: 1800, origin: "user", locked: true });
    expect(next.operating?.baseRevenue).toBe(1800);
  });

  test("applies a sensitivity point to the base case without changing outer scenarios", () => {
    const next = applySensitivityPoint(baseDraft(), {
      discountRate: 0.09,
      terminalGrowthRate: 0.035,
      perShareValue: 18.6,
    });

    expect(findAssumption(next, "discountRate")).toMatchObject({
      bear: 11.5,
      base: 9,
      bull: 8.5,
      origin: "user",
      locked: true,
    });
    expect(findAssumption(next, "terminalGrowthRate")).toMatchObject({
      bear: 1.5,
      base: 3.5,
      bull: 3.5,
      origin: "user",
      locked: true,
    });
    expect(next.operating?.discountRate).toEqual({ low: 0.085, base: 0.09, high: 0.115 });
    expect(next.operating?.terminalGrowthRate).toEqual({ low: 0.015, base: 0.035, high: 0.035 });
  });

  test("compares scenario values and changed assumptions against a saved baseline", () => {
    const baseline = baseDraft();
    const current = applyDraftEdit(baseline, { key: "revenueGrowth", scenario: "base", rawValue: "12.5" });

    const comparison = compareQuantitativeDrafts(current, baseline);

    expect(comparison.scenarios.find((item) => item.scenario === "base")).toMatchObject({
      baselineValue: expect.any(Number),
      currentValue: expect.any(Number),
      delta: expect.any(Number),
    });
    expect(comparison.scenarios.find((item) => item.scenario === "base")?.delta).not.toBe(0);
    expect(comparison.assumptions).toContainEqual(expect.objectContaining({
      key: "revenueGrowth",
      label: "收入增速",
      baselineValue: 7,
      currentValue: 12.5,
      delta: 5.5,
      unit: "%",
    }));
  });

  test("keeps the initial draft in history so the first edit can be undone", () => {
    const initial = baseDraft();
    const edited = applyDraftEdit(initial, { key: "revenueGrowth", scenario: "base", rawValue: "12.5" });
    const history = pushDraftHistory(createDraftHistory(initial), edited);

    expect(history.index).toBe(1);
    expect(undoDraftHistory(history).entries[0]).toEqual(initial);
    expect(findAssumption(undoDraftHistory(history).current, "revenueGrowth")?.base).toBe(7);
  });

  test("summarizes edited assumptions into a concise version decision note", () => {
    const current = applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" });

    expect(buildDraftDecisionNote(current, baseDraft())).toBe("调整收入增速：7% → 12.5%。");
  });

  test("describes save readiness with manual note and changed assumptions", () => {
    const current = applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" });

    expect(describeQuantitativeSaveGuidance({
      phase: "ready",
      warnings: [],
      current,
      baseline: baseDraft(),
      decisionNote: "半年报订单兑现，上调收入假设。",
    })).toMatchObject({
      tone: "ready",
      canSave: true,
      changedAssumptionCount: 1,
      title: "准备保存新版本",
      detail: "1 项关键假设已调整，备注将写入版本历史。",
      notePreview: "半年报订单兑现，上调收入假设。",
    });
  });

  test("explains automatic audit note when no manual note is provided", () => {
    const current = applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" });

    expect(describeQuantitativeSaveGuidance({
      phase: "ready",
      warnings: [],
      current,
      baseline: baseDraft(),
      decisionNote: "",
      autoDecisionNote: buildDraftDecisionNote(current, baseDraft()),
    })).toMatchObject({
      tone: "ready",
      canSave: true,
      notePreview: "调整收入增速：7% → 12.5%。",
    });
  });

  test("blocks save guidance when draft has validation errors", () => {
    expect(describeQuantitativeSaveGuidance({
      phase: "ready",
      warnings: [{ level: "error", message: "WACC 必须高于永续增长率。" }],
      current: baseDraft(),
      baseline: baseDraft(),
      decisionNote: "",
    })).toMatchObject({
      tone: "blocked",
      canSave: false,
      title: "先修正参数错误",
      detail: "WACC 必须高于永续增长率。",
    });
  });

  test("shows saving feedback while a new version is being persisted", () => {
    expect(describeQuantitativeSaveGuidance({
      phase: "saving",
      warnings: [],
      current: baseDraft(),
      baseline: baseDraft(),
      decisionNote: "",
    })).toMatchObject({
      tone: "saving",
      canSave: false,
      title: "正在保存新版本",
    });
  });
});

function baseDraft(): QuantitativeDraft {
  return {
    method: "dcf_3_statement",
    archetype: "operating",
    currency: "CNY",
    asOf: "2026-06-21",
    scenarios: {
      bear: { discountRate: 0.115, terminalGrowthRate: 0.015 },
      base: { discountRate: 0.1, terminalGrowthRate: 0.025 },
      bull: { discountRate: 0.085, terminalGrowthRate: 0.035 },
    },
    assumptions: [
      { key: "revenueGrowth", label: "收入增速", bear: 3, base: 7, bull: 11, unit: "%", origin: "formula", locked: false },
      { key: "baseRevenue", label: "营业收入基数", value: 100, base: 100, unit: "亿元", origin: "formula", locked: false },
      { key: "ebitMargin", label: "EBIT 利润率", bear: 8, base: 13, bull: 18, unit: "%", origin: "formula", locked: false },
      { key: "discountRate", label: "WACC", bear: 11.5, base: 10, bull: 8.5, unit: "%", origin: "formula", locked: false },
      { key: "terminalGrowthRate", label: "永续增长率", bear: 1.5, base: 2.5, bull: 3.5, unit: "%", origin: "formula", locked: false },
    ],
    operating: {
      currency: "CNY", asOf: "2026-06-21", baseRevenue: 100, sharesOutstanding: 10, netDebt: 5,
      revenueGrowth: { low: 0.03, base: 0.07, high: 0.11 },
      ebitMargin: { low: 0.08, base: 0.13, high: 0.18 }, taxRate: 0.2, depreciationRate: 0.035,
      capexRate: { low: 0.04, base: 0.06, high: 0.08 }, workingCapitalRate: 0.015,
      discountRate: { low: 0.085, base: 0.1, high: 0.115 },
      terminalGrowthRate: { low: 0.015, base: 0.025, high: 0.035 },
    },
  };
}
