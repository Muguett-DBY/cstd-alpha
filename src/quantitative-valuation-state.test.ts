import { describe, expect, test } from "vitest";
import {
  applyDraftEdit,
  applyQuantitativePreset,
  applySensitivityPoint,
  buildQuantitativeStarterPresets,
  buildDraftDecisionNote,
  compareQuantitativeDrafts,
  createQuantitativePreset,
  createDraftHistory,
  describeQuantitativePresetLibrary,
  describeQuantitativePresetChangeSummary,
  describeQuantitativePresetImpact,
  describeQuantitativeDecision,
  describeQuantitativeSaveGuidance,
  describeYearlyOverrideSummary,
  deleteQuantitativePreset,
  draftWarnings,
  findAssumption,
  pushDraftHistory,
  renameQuantitativePreset,
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

  test("creates a named valuation preset from current user-locked assumptions", () => {
    const current = applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" });

    const next = createQuantitativePreset(current, "半年报兑现", "2026-06-26T00:00:00.000Z");

    expect(next.presets).toHaveLength(1);
    expect(next.presets?.[0]).toMatchObject({
      id: "preset-20260626000000-1",
      name: "半年报兑现",
      createdAt: "2026-06-26T00:00:00.000Z",
      assumptions: [expect.objectContaining({ key: "revenueGrowth", base: 12.5, origin: "user", locked: true })],
    });
  });

  test("applies a saved valuation preset back into the editable draft", () => {
    const current = createQuantitativePreset(
      applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" }),
      "半年报兑现",
      "2026-06-26T00:00:00.000Z",
    );

    const next = applyQuantitativePreset(baseDraft(), current.presets?.[0]);

    expect(findAssumption(next, "revenueGrowth")).toMatchObject({ base: 12.5, origin: "user", locked: true });
    expect(next.operating?.revenueGrowth.base).toBe(0.125);
  });

  test("describes the valuation impact before applying a preset", () => {
    const presetDraft = createQuantitativePreset(
      applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" }),
      "半年报兑现",
      "2026-06-26T00:00:00.000Z",
    );

    const impact = describeQuantitativePresetImpact(baseDraft(), presetDraft.presets?.[0]);

    expect(impact).toMatchObject({
      tone: "changes",
      title: "将调整 1 项关键假设",
      changedAssumptionCount: 1,
      canApply: true,
    });
    expect(impact.baseDelta).not.toBe(0);
  });

  test("marks a preset as already current when it would not change the draft", () => {
    const presetDraft = createQuantitativePreset(
      applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" }),
      "半年报兑现",
      "2026-06-26T00:00:00.000Z",
    );

    expect(describeQuantitativePresetImpact(presetDraft, presetDraft.presets?.[0])).toMatchObject({
      tone: "current",
      title: "已是当前假设组合",
      changedAssumptionCount: 0,
      canApply: false,
    });
  });

  test("summarizes the preset library for UI status badges", () => {
    const presetDraft = createQuantitativePreset(
      applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" }),
      "半年报兑现",
      "2026-06-26T00:00:00.000Z",
    );

    expect(describeQuantitativePresetLibrary(baseDraft(), presetDraft.presets)).toEqual({
      total: 1,
      currentCount: 0,
      actionableCount: 1,
      title: "1 个可载入方案",
    });
    expect(describeQuantitativePresetLibrary(presetDraft, presetDraft.presets)).toEqual({
      total: 1,
      currentCount: 1,
      actionableCount: 0,
      title: "1 个当前匹配方案",
    });
  });

  test("renames a valuation preset without changing its saved assumptions", () => {
    const presetDraft = createQuantitativePreset(
      applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" }),
      "半年报兑现",
      "2026-06-26T00:00:00.000Z",
    );

    const next = renameQuantitativePreset(presetDraft, "preset-20260626000000-1", "  半年报复核方案  ");

    expect(next.presets?.[0]).toMatchObject({
      id: "preset-20260626000000-1",
      name: "半年报复核方案",
      assumptions: [expect.objectContaining({ key: "revenueGrowth", base: 12.5 })],
    });
  });

  test("deletes a stale valuation preset and updates library summary", () => {
    const presetDraft = createQuantitativePreset(
      applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" }),
      "半年报兑现",
      "2026-06-26T00:00:00.000Z",
    );

    const next = deleteQuantitativePreset(presetDraft, "preset-20260626000000-1");

    expect(next.presets).toEqual([]);
    expect(describeQuantitativePresetLibrary(baseDraft(), next.presets)).toEqual({
      total: 0,
      currentCount: 0,
      actionableCount: 0,
      title: "暂无预设",
    });
  });

  test("summarizes unsaved preset library changes against the latest version", () => {
    const latest = createQuantitativePreset(
      applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" }),
      "半年报兑现",
      "2026-06-26T00:00:00.000Z",
    );
    const renamed = renameQuantitativePreset(latest, "preset-20260626000000-1", "半年报复核方案");

    expect(describeQuantitativePresetChangeSummary(renamed, latest)).toEqual({
      hasChanges: true,
      changedPresetCount: 1,
      title: "预设库变更待保存",
      detail: "重命名 1 个方案，保存新版本后写入历史。",
    });
    expect(describeQuantitativePresetChangeSummary(latest, latest)).toEqual({
      hasChanges: false,
      changedPresetCount: 0,
      title: "预设库已同步",
      detail: "当前预设库与最新版本一致。",
    });
  });

  test("makes preset-only edits visible in save guidance", () => {
    const latest = createQuantitativePreset(
      applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" }),
      "半年报兑现",
      "2026-06-26T00:00:00.000Z",
    );
    const current = deleteQuantitativePreset(latest, "preset-20260626000000-1");

    expect(describeQuantitativeSaveGuidance({
      phase: "ready",
      warnings: [],
      current,
      baseline: latest,
      decisionNote: "",
    })).toMatchObject({
      tone: "ready",
      canSave: true,
      changedAssumptionCount: 0,
      title: "准备保存预设库变更",
      detail: "删除 1 个方案，保存新版本后写入历史。",
    });
  });

  test("builds starter preset templates from baseline assumptions", () => {
    const starters = buildQuantitativeStarterPresets(baseDraft(), "2026-06-26T00:00:00.000Z");

    expect(starters.map((preset) => preset.name)).toEqual(["基准复核", "谨慎下修", "压力测试"]);
    expect(starters[0]).toMatchObject({
      id: "starter-base-review-20260626000000",
      assumptions: [
        expect.objectContaining({ key: "revenueGrowth", origin: "user", locked: true }),
        expect.objectContaining({ key: "ebitMargin", origin: "user", locked: true }),
        expect.objectContaining({ key: "discountRate", origin: "user", locked: true }),
        expect.objectContaining({ key: "terminalGrowthRate", origin: "user", locked: true }),
      ],
    });
    const pressure = starters.find((preset) => preset.name === "压力测试");
    expect(pressure?.assumptions.find((item) => item.key === "revenueGrowth")?.base).toBeLessThan(7);
    expect(describeQuantitativePresetImpact(baseDraft(), pressure)).toMatchObject({
      tone: "changes",
      canApply: true,
    });
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

  test("summarizes yearly forecast overrides before saving", () => {
    const current = applyDraftEdit(baseDraft(), { key: "ebitMargin", scenario: "base", forecastYear: 2, rawValue: "20" });

    expect(describeYearlyOverrideSummary(current)).toEqual({
      count: 1,
      title: "1 项逐年覆写",
      detail: "第 2 年 EBIT 利润率 20%",
    });
    expect(describeYearlyOverrideSummary(baseDraft())).toEqual({
      count: 0,
      title: "无逐年覆写",
      detail: "高级逐年预测未覆盖基准假设。",
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

  test("summarizes a meaningful base-case discount against the market price", () => {
    expect(describeQuantitativeDecision({
      currentPrice: 100,
      scenarios: [
        { scenario: "bear", perShareValue: 80 },
        { scenario: "base", perShareValue: 120 },
        { scenario: "bull", perShareValue: 160 },
      ],
    })).toEqual({
      tone: "opportunity",
      title: "基准情景显示 20.0% 上行空间",
      detail: "保守情景下行 20.0%，乐观情景上行 60.0%。",
      baseGap: 0.2,
    });
  });

  test("reports unavailable market comparison without inventing a conclusion", () => {
    expect(describeQuantitativeDecision({
      scenarios: [
        { scenario: "bear", perShareValue: 80 },
        { scenario: "base", perShareValue: 120 },
        { scenario: "bull", perShareValue: 160 },
      ],
    })).toMatchObject({
      tone: "unpriced",
      title: "等待市场价格验证",
      baseGap: undefined,
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
