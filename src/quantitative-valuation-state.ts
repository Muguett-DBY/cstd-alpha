import {
  calculateQuantitativeDraft,
  validateQuantitativeDraft,
  type EditableAssumption,
  type QuantitativeDraft,
  type QuantitativePreset,
} from "./shared/quantitative-valuation";
import type { ValuationScenarioName } from "./shared/valuation";

export type DraftEdit = {
  key: string;
  scenario: "bear" | "base" | "bull";
  rawValue: string;
  forecastYear?: number;
};

export type DraftWarning = { level: "error" | "warning"; message: string };

export type DraftHistory = {
  entries: QuantitativeDraft[];
  index: number;
  current: QuantitativeDraft;
};

export type QuantitativeDraftComparison = {
  scenarios: Array<{
    scenario: ValuationScenarioName;
    baselineValue: number;
    currentValue: number;
    delta: number;
    deltaPercent?: number;
  }>;
  assumptions: Array<{
    key: string;
    label: string;
    unit?: string;
    baselineValue: number;
    currentValue: number;
    delta: number;
  }>;
};

export type QuantitativeSaveGuidance = {
  tone: "ready" | "blocked" | "saving" | "unchanged";
  title: string;
  detail: string;
  notePreview: string;
  changedAssumptionCount: number;
  canSave: boolean;
};

export type QuantitativeDecision = {
  tone: "opportunity" | "risk" | "balanced" | "unpriced";
  title: string;
  detail: string;
  baseGap?: number;
};

export type QuantitativePresetImpact = {
  tone: "changes" | "current" | "invalid";
  title: string;
  detail: string;
  changedAssumptionCount: number;
  canApply: boolean;
  baseDelta?: number;
  baseDeltaPercent?: number;
};

export type QuantitativePresetLibrary = {
  total: number;
  currentCount: number;
  actionableCount: number;
  title: string;
};

export type QuantitativePresetChangeSummary = {
  hasChanges: boolean;
  changedPresetCount: number;
  title: string;
  detail: string;
};

export type YearlyOverrideSummary = {
  count: number;
  title: string;
  detail: string;
};

export function describeQuantitativeDecision(input: {
  currentPrice?: number;
  scenarios: Array<{ scenario: ValuationScenarioName; perShareValue: number }>;
}): QuantitativeDecision {
  const base = input.scenarios.find((item) => item.scenario === "base");
  if (!base || !input.currentPrice || input.currentPrice <= 0) {
    return {
      tone: "unpriced",
      title: "等待市场价格验证",
      detail: "三情景估值已完成，补齐可信市场价格后显示安全边际。",
      baseGap: undefined,
    };
  }
  const bear = input.scenarios.find((item) => item.scenario === "bear");
  const bull = input.scenarios.find((item) => item.scenario === "bull");
  const baseGap = Number((base.perShareValue / input.currentPrice - 1).toFixed(6));
  const tone = baseGap >= 0.1 ? "opportunity" : baseGap <= -0.1 ? "risk" : "balanced";
  const title = tone === "opportunity"
    ? `基准情景显示 ${formatDecisionGap(baseGap)} 上行空间`
    : tone === "risk"
      ? `基准情景显示 ${formatDecisionGap(baseGap)} 下行风险`
      : `基准情景接近当前市价（${formatSignedDecisionGap(baseGap)}）`;
  const detail = bear && bull
    ? `保守情景${formatDecisionDirection(bear.perShareValue / input.currentPrice - 1)}，乐观情景${formatDecisionDirection(bull.perShareValue / input.currentPrice - 1)}。`
    : "情景结果已完成，继续检查关键假设和敏感性组合。";
  return { tone, title, detail, baseGap };
}

export function describeQuantitativeSaveGuidance(input: {
  phase: "loading" | "ready" | "saving" | "error";
  warnings: DraftWarning[];
  current?: QuantitativeDraft;
  baseline?: QuantitativeDraft;
  decisionNote?: string;
  autoDecisionNote?: string;
}): QuantitativeSaveGuidance {
  const error = input.warnings.find((warning) => warning.level === "error");
  const manualNote = input.decisionNote?.trim() ?? "";
  const notePreview = manualNote || input.autoDecisionNote || "保存为审计版本：关键假设未变化。";
  let changedAssumptionCount = 0;
  if (input.current && input.baseline && !error) {
    try {
      changedAssumptionCount = compareQuantitativeDrafts(input.current, input.baseline).assumptions.length;
    } catch {
      changedAssumptionCount = 0;
    }
  }

  if (input.phase === "saving") {
    return {
      tone: "saving",
      title: "正在保存新版本",
      detail: "正在写入用户锁定假设和版本说明，请稍候。",
      notePreview,
      changedAssumptionCount,
      canSave: false,
    };
  }

  if (error) {
    return {
      tone: "blocked",
      title: "先修正参数错误",
      detail: error.message,
      notePreview,
      changedAssumptionCount,
      canSave: false,
    };
  }

  if (changedAssumptionCount === 0) {
    const presetSummary = input.current && input.baseline
      ? describeQuantitativePresetChangeSummary(input.current, input.baseline)
      : undefined;
    if (presetSummary?.hasChanges) {
      return {
        tone: "ready",
        title: "准备保存预设库变更",
        detail: presetSummary.detail,
        notePreview,
        changedAssumptionCount,
        canSave: true,
      };
    }
    return {
      tone: "unchanged",
      title: "可保存审计快照",
      detail: "关键假设未变化，保存后会记录当前数据快照和备注。",
      notePreview,
      changedAssumptionCount,
      canSave: true,
    };
  }

  return {
    tone: "ready",
    title: "准备保存新版本",
    detail: `${changedAssumptionCount} 项关键假设已调整，备注将写入版本历史。`,
    notePreview,
    changedAssumptionCount,
    canSave: true,
  };
}

export function describeYearlyOverrideSummary(draft: QuantitativeDraft): YearlyOverrideSummary {
  const overrides = (draft.assumptions ?? [])
    .filter((assumption) => assumption.forecastYear !== undefined && assumption.origin === "user" && assumption.locked)
    .sort((left, right) => (left.forecastYear ?? 0) - (right.forecastYear ?? 0) || left.label.localeCompare(right.label, "zh-CN"));
  if (!overrides.length) {
    return {
      count: 0,
      title: "无逐年覆写",
      detail: "高级逐年预测未覆盖基准假设。",
    };
  }
  const detail = overrides.slice(0, 3).map((assumption) =>
    `第 ${assumption.forecastYear} 年 ${assumption.label} ${formatCompactAssumption(assumption.base ?? assumption.value ?? 0, assumption.unit)}`,
  ).join("；");
  const suffix = overrides.length > 3 ? `；另 ${overrides.length - 3} 项` : "";
  return {
    count: overrides.length,
    title: `${overrides.length} 项逐年覆写`,
    detail: detail + suffix,
  };
}

export const SIMPLE_EDITOR_FIELDS = [
  "baseRevenue", "revenueGrowth", "ebitMargin", "capexRate", "workingCapitalRate", "taxRate",
  "discountRate", "terminalGrowthRate", "netDebt", "sharesOutstanding",
] as const;

export function applyDraftEdit(draft: QuantitativeDraft, edit: DraftEdit): QuantitativeDraft {
  const numeric = Number(edit.rawValue.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return draft;
  const assumptions = [...(draft.assumptions ?? [])];
  let index = assumptions.findIndex((item) => item.key === edit.key && item.forecastYear === edit.forecastYear);
  if (index < 0 && edit.forecastYear !== undefined) {
    const base = assumptions.find((item) => item.key === edit.key && item.forecastYear === undefined);
    if (!base) return draft;
    assumptions.push({ ...base, forecastYear: edit.forecastYear });
    index = assumptions.length - 1;
  }
  if (index < 0) return draft;
  const current = assumptions[index];
  assumptions[index] = { ...current, [edit.scenario]: numeric, origin: "user", locked: true };
  return synchronizeDraft({ ...draft, assumptions }, assumptions[index]);
}

export function applySensitivityPoint(
  draft: QuantitativeDraft,
  point: { discountRate: number; terminalGrowthRate: number; perShareValue: number },
) {
  const withDiscountRate = applyDraftEdit(draft, {
    key: "discountRate",
    scenario: "base",
    rawValue: sensitivityPercent(point.discountRate),
  });
  return applyDraftEdit(withDiscountRate, {
    key: "terminalGrowthRate",
    scenario: "base",
    rawValue: sensitivityPercent(point.terminalGrowthRate),
  });
}

export function createQuantitativePreset(draft: QuantitativeDraft, name: string, now = new Date().toISOString()): QuantitativeDraft {
  const assumptions = userLockedAssumptions(draft);
  if (!assumptions.length) return draft;
  const presets = [...(draft.presets ?? [])];
  const preset: QuantitativePreset = {
    id: `preset-${now.replace(/\D/g, "").slice(0, 14)}-${presets.length + 1}`,
    name: normalizePresetName(name, presets.length + 1),
    createdAt: now,
    assumptions: assumptions.map((assumption) => ({ ...assumption })),
  };
  return { ...draft, presets: [...presets, preset].slice(-12) };
}

export function renameQuantitativePreset(draft: QuantitativeDraft, presetId: string, name: string): QuantitativeDraft {
  const presets = draft.presets ?? [];
  const index = presets.findIndex((preset) => preset.id === presetId);
  if (index < 0) return draft;
  const nextName = normalizePresetName(name, index + 1);
  if (presets[index].name === nextName) return draft;
  return {
    ...draft,
    presets: presets.map((preset) => preset.id === presetId ? { ...preset, name: nextName } : preset),
  };
}

export function deleteQuantitativePreset(draft: QuantitativeDraft, presetId: string): QuantitativeDraft {
  const presets = draft.presets ?? [];
  const nextPresets = presets.filter((preset) => preset.id !== presetId);
  if (nextPresets.length === presets.length) return draft;
  return { ...draft, presets: nextPresets };
}

export function buildQuantitativeStarterPresets(draft: QuantitativeDraft, now = new Date().toISOString()): QuantitativePreset[] {
  const stamp = now.replace(/\D/g, "").slice(0, 14);
  const templates: Array<{
    slug: string;
    name: string;
    transforms: Record<string, (value: number) => number>;
  }> = [
    {
      slug: "base-review",
      name: "基准复核",
      transforms: {
        revenueGrowth: (value) => value,
        ebitMargin: (value) => value,
        discountRate: (value) => value,
        terminalGrowthRate: (value) => value,
      },
    },
    {
      slug: "cautious-cut",
      name: "谨慎下修",
      transforms: {
        revenueGrowth: (value) => value * 0.85,
        ebitMargin: (value) => value - 1,
        discountRate: (value) => value + 0.5,
        terminalGrowthRate: (value) => value - 0.25,
      },
    },
    {
      slug: "pressure-test",
      name: "压力测试",
      transforms: {
        revenueGrowth: (value) => value * 0.65,
        ebitMargin: (value) => value - 2,
        capexRate: (value) => value + 1,
        discountRate: (value) => value + 1,
        terminalGrowthRate: (value) => value - 0.75,
      },
    },
  ];
  return templates.flatMap((template) => {
    const assumptions = Object.entries(template.transforms)
      .map(([key, transform]) => starterPresetAssumption(draft, key, transform))
      .filter((item): item is EditableAssumption => Boolean(item));
    if (!assumptions.length) return [];
    return [{
      id: `starter-${template.slug}-${stamp}`,
      name: template.name,
      createdAt: now,
      assumptions,
    }];
  });
}

export function applyQuantitativePreset(draft: QuantitativeDraft, preset?: QuantitativePreset): QuantitativeDraft {
  if (!preset?.assumptions.length) return draft;
  let next = draft;
  for (const assumption of preset.assumptions) {
    next = applyPresetAssumption(next, assumption);
  }
  return next;
}

export function describeQuantitativePresetImpact(draft: QuantitativeDraft, preset?: QuantitativePreset): QuantitativePresetImpact {
  if (!preset?.assumptions.length) {
    return {
      tone: "invalid",
      title: "预设不可用",
      detail: "这个预设没有可应用的关键假设。",
      changedAssumptionCount: 0,
      canApply: false,
    };
  }
  try {
    const applied = applyQuantitativePreset(draft, preset);
    const comparison = compareQuantitativeDrafts(applied, draft);
    const base = comparison.scenarios.find((item) => item.scenario === "base");
    if (!comparison.assumptions.length && (!base || Math.abs(base.delta) < 0.000001)) {
      return {
        tone: "current",
        title: "已是当前假设组合",
        detail: "载入后不会改变当前草稿。",
        changedAssumptionCount: 0,
        canApply: false,
        baseDelta: 0,
        baseDeltaPercent: 0,
      };
    }
    return {
      tone: "changes",
      title: `将调整 ${comparison.assumptions.length} 项关键假设`,
      detail: base ? `基准估值变化 ${formatSignedCompact(base.delta)}。` : "载入后会更新当前草稿。",
      changedAssumptionCount: comparison.assumptions.length,
      canApply: true,
      baseDelta: base?.delta,
      baseDeltaPercent: base?.deltaPercent,
    };
  } catch (error) {
    return {
      tone: "invalid",
      title: "预设参数需修正",
      detail: error instanceof Error ? error.message : "载入预设后参数无效。",
      changedAssumptionCount: 0,
      canApply: false,
    };
  }
}

export function describeQuantitativePresetLibrary(draft: QuantitativeDraft, presets: QuantitativePreset[] | undefined): QuantitativePresetLibrary {
  const impacts = (presets ?? []).map((preset) => describeQuantitativePresetImpact(draft, preset));
  const currentCount = impacts.filter((impact) => impact.tone === "current").length;
  const actionableCount = impacts.filter((impact) => impact.canApply).length;
  const total = impacts.length;
  const title = total === 0
    ? "暂无预设"
    : currentCount > 0
      ? `${currentCount} 个当前匹配方案`
      : `${actionableCount} 个可载入方案`;
  return { total, currentCount, actionableCount, title };
}

export function describeQuantitativePresetChangeSummary(
  current: QuantitativeDraft,
  baseline?: QuantitativeDraft,
): QuantitativePresetChangeSummary {
  const currentPresets = current.presets ?? [];
  const baselinePresets = baseline?.presets ?? [];
  const baselineById = new Map(baselinePresets.map((preset) => [preset.id, preset]));
  const currentById = new Map(currentPresets.map((preset) => [preset.id, preset]));
  const added = currentPresets.filter((preset) => !baselineById.has(preset.id)).length;
  const removed = baselinePresets.filter((preset) => !currentById.has(preset.id)).length;
  const renamed = currentPresets.filter((preset) => {
    const previous = baselineById.get(preset.id);
    return previous && previous.name !== preset.name && presetAssumptionsSignature(previous) === presetAssumptionsSignature(preset);
  }).length;
  const edited = currentPresets.filter((preset) => {
    const previous = baselineById.get(preset.id);
    return previous && presetAssumptionsSignature(previous) !== presetAssumptionsSignature(preset);
  }).length;
  const changedPresetCount = added + removed + renamed + edited;
  if (!changedPresetCount) {
    return {
      hasChanges: false,
      changedPresetCount: 0,
      title: "预设库已同步",
      detail: "当前预设库与最新版本一致。",
    };
  }
  const parts = [
    added ? `新增 ${added} 个方案` : "",
    renamed ? `重命名 ${renamed} 个方案` : "",
    removed ? `删除 ${removed} 个方案` : "",
    edited ? `更新 ${edited} 个方案` : "",
  ].filter(Boolean);
  return {
    hasChanges: true,
    changedPresetCount,
    title: "预设库变更待保存",
    detail: `${parts.join("、")}，保存新版本后写入历史。`,
  };
}

export function clearDraftEdit(draft: QuantitativeDraft, key: string, forecastYear?: number) {
  return {
    ...draft,
    assumptions: (draft.assumptions ?? []).filter((item) => !(item.key === key && item.forecastYear === forecastYear && forecastYear !== undefined)),
  };
}

export function findAssumption(draft: QuantitativeDraft, key: string, forecastYear?: number) {
  return draft.assumptions?.find((item) => item.key === key && item.forecastYear === forecastYear);
}

export function draftWarnings(draft: QuantitativeDraft): DraftWarning[] {
  const warnings: DraftWarning[] = (draft.warnings ?? []).map((message) => ({ level: "warning", message }));
  try {
    validateQuantitativeDraft(draft);
  } catch (error) {
    warnings.unshift({ level: "error", message: error instanceof Error ? error.message : "估值参数无效。" });
  }
  if (draft.operating && draft.operating.sharesOutstanding <= 0) warnings.unshift({ level: "error", message: "总股本必须大于 0。" });
  if (draft.operating && draft.operating.baseRevenue <= 0) warnings.unshift({ level: "error", message: "营业收入基数必须大于 0。" });
  return warnings;
}

export function simpleEditorFields(draft: QuantitativeDraft) {
  return SIMPLE_EDITOR_FIELDS.map((key) => findAssumption(draft, key)).filter((item): item is EditableAssumption => Boolean(item));
}

export function userLockedAssumptions(draft: QuantitativeDraft) {
  return (draft.assumptions ?? []).filter((item) => item.origin === "user" && item.locked);
}

export function createDraftHistory(draft: QuantitativeDraft): DraftHistory {
  return { entries: [draft], index: 0, current: draft };
}

export function pushDraftHistory(history: DraftHistory, draft: QuantitativeDraft): DraftHistory {
  const entries = [...history.entries.slice(0, history.index + 1), draft].slice(-50);
  return { entries, index: entries.length - 1, current: draft };
}

export function undoDraftHistory(history: DraftHistory): DraftHistory {
  const index = Math.max(0, history.index - 1);
  return { ...history, index, current: history.entries[index] };
}

export function redoDraftHistory(history: DraftHistory): DraftHistory {
  const index = Math.min(history.entries.length - 1, history.index + 1);
  return { ...history, index, current: history.entries[index] };
}

export function compareQuantitativeDrafts(current: QuantitativeDraft, baseline: QuantitativeDraft): QuantitativeDraftComparison {
  const currentResult = calculateQuantitativeDraft(current);
  const baselineResult = calculateQuantitativeDraft(baseline);
  const baselineScenarios = new Map(baselineResult.scenarios.map((item) => [item.scenario, item]));
  const scenarios = currentResult.scenarios.flatMap((item) => {
    const baselineItem = baselineScenarios.get(item.scenario);
    if (!baselineItem) return [];
    const delta = item.perShareValue - baselineItem.perShareValue;
    return [{
      scenario: item.scenario,
      baselineValue: baselineItem.perShareValue,
      currentValue: item.perShareValue,
      delta,
      deltaPercent: baselineItem.perShareValue === 0 ? undefined : delta / Math.abs(baselineItem.perShareValue),
    }];
  });
  const assumptions = SIMPLE_EDITOR_FIELDS.flatMap((key) => {
    const currentAssumption = findAssumption(current, key);
    const baselineAssumption = findAssumption(baseline, key);
    const currentValue = currentAssumption?.base ?? currentAssumption?.value;
    const baselineValue = baselineAssumption?.base ?? baselineAssumption?.value;
    if (!currentAssumption || !baselineAssumption || typeof currentValue !== "number" || typeof baselineValue !== "number" || currentValue === baselineValue) return [];
    return [{
      key,
      label: currentAssumption.label,
      unit: currentAssumption.unit,
      baselineValue,
      currentValue,
      delta: currentValue - baselineValue,
    }];
  });
  return { scenarios, assumptions };
}

export function buildDraftDecisionNote(current: QuantitativeDraft, baseline?: QuantitativeDraft) {
  if (!baseline) return "";
  const comparison = compareQuantitativeDrafts(current, baseline);
  if (!comparison.assumptions.length) return "保存为审计版本：关键假设未变化。";
  const summary = comparison.assumptions.slice(0, 3).map((item) =>
    `${item.label}：${formatCompactAssumption(item.baselineValue, item.unit)} → ${formatCompactAssumption(item.currentValue, item.unit)}`,
  ).join("；");
  const suffix = comparison.assumptions.length > 3 ? `；另 ${comparison.assumptions.length - 3} 项` : "";
  return `调整${summary}${suffix}。`;
}

function synchronizeDraft(draft: QuantitativeDraft, changed: EditableAssumption): QuantitativeDraft {
  if (!draft.operating) return draft;
  const percent = (value: number | undefined) => value === undefined ? undefined : value / 100;
  if (changed.forecastYear !== undefined) {
    const overrides = [...(draft.operating.forecastOverrides ?? [])];
    const index = overrides.findIndex((item) => item.year === changed.forecastYear);
    const current = index >= 0 ? overrides[index] : { year: changed.forecastYear };
    const base = percent(changed.base);
    if (base === undefined) return draft;
    const field = forecastOverrideField(changed.key);
    if (!field) return draft;
    const next = { ...current, [field]: base };
    if (index >= 0) overrides[index] = next; else overrides.push(next);
    return { ...draft, operating: { ...draft.operating, forecastOverrides: overrides.sort((a, b) => a.year - b.year) } };
  }
  const scenarioTriple = assumptionTriple(changed);
  const operating = { ...draft.operating };
  if (scenarioTriple) {
    if (changed.key === "discountRate") operating.discountRate = { low: scenarioTriple.bull, base: scenarioTriple.base, high: scenarioTriple.bear };
    else if (changed.key === "terminalGrowthRate") operating.terminalGrowthRate = { low: scenarioTriple.bear, base: scenarioTriple.base, high: scenarioTriple.bull };
    else if (changed.key === "revenueGrowth") operating.revenueGrowth = { low: scenarioTriple.bear, base: scenarioTriple.base, high: scenarioTriple.bull };
    else if (changed.key === "ebitMargin") operating.ebitMargin = { low: scenarioTriple.bear, base: scenarioTriple.base, high: scenarioTriple.bull };
    else if (changed.key === "capexRate") operating.capexRate = { low: scenarioTriple.bear, base: scenarioTriple.base, high: scenarioTriple.bull };
  }
  const scalar = percent(changed.value ?? changed.base);
  if (changed.key === "taxRate" && scalar !== undefined) operating.taxRate = scalar;
  if (changed.key === "workingCapitalRate" && scalar !== undefined) operating.workingCapitalRate = scalar;
  const number = changed.base ?? changed.value;
  if (changed.key === "baseRevenue" && number !== undefined) operating.baseRevenue = number;
  if (changed.key === "netDebt" && number !== undefined) operating.netDebt = number;
  if (changed.key === "sharesOutstanding" && number !== undefined) operating.sharesOutstanding = number;
  const next = { ...draft, operating };
  next.scenarios = {
    bear: { discountRate: operating.discountRate.high, terminalGrowthRate: operating.terminalGrowthRate.low },
    base: { discountRate: operating.discountRate.base, terminalGrowthRate: operating.terminalGrowthRate.base },
    bull: { discountRate: operating.discountRate.low, terminalGrowthRate: operating.terminalGrowthRate.high },
  };
  return next;
}

function assumptionTriple(assumption: EditableAssumption) {
  if (assumption.bear === undefined || assumption.base === undefined || assumption.bull === undefined) return undefined;
  return { bear: assumption.bear / 100, base: assumption.base / 100, bull: assumption.bull / 100 };
}

function forecastOverrideField(key: string) {
  if (key === "revenueGrowth" || key === "ebitMargin" || key === "capexRate" || key === "workingCapitalRate") return key;
  return undefined;
}

function applyPresetAssumption(draft: QuantitativeDraft, presetAssumption: EditableAssumption): QuantitativeDraft {
  const assumptions = [...(draft.assumptions ?? [])];
  let index = assumptions.findIndex((item) => item.key === presetAssumption.key && item.forecastYear === presetAssumption.forecastYear);
  if (index < 0) {
    const base = assumptions.find((item) => item.key === presetAssumption.key && item.forecastYear === undefined);
    if (!base) return draft;
    assumptions.push({ ...base, forecastYear: presetAssumption.forecastYear });
    index = assumptions.length - 1;
  }
  const merged: EditableAssumption = {
    ...assumptions[index],
    value: presetAssumption.value,
    bear: presetAssumption.bear,
    base: presetAssumption.base,
    bull: presetAssumption.bull,
    origin: "user",
    locked: true,
  };
  assumptions[index] = merged;
  return synchronizeDraft({ ...draft, assumptions }, merged);
}

function starterPresetAssumption(draft: QuantitativeDraft, key: string, transform: (value: number) => number): EditableAssumption | undefined {
  const source = findAssumption(draft, key);
  if (!source) return undefined;
  const nextValue = (value: number | undefined) => value === undefined ? undefined : normalizeStarterValue(key, transform(value));
  return {
    ...source,
    value: nextValue(source.value),
    bear: nextValue(source.bear),
    base: nextValue(source.base),
    bull: nextValue(source.bull),
    origin: "user",
    locked: true,
  };
}

function presetAssumptionsSignature(preset: QuantitativePreset) {
  return JSON.stringify(preset.assumptions ?? []);
}

function normalizeStarterValue(key: string, value: number) {
  const floor = key === "terminalGrowthRate" ? 0 : key === "ebitMargin" || key === "revenueGrowth" || key === "capexRate" ? -50 : value;
  const ceiling = key === "discountRate" ? 30 : key === "terminalGrowthRate" ? 8 : 100;
  return Number(Math.min(ceiling, Math.max(floor, value)).toFixed(4));
}

function normalizePresetName(name: string, index: number) {
  const normalized = name.replace(/\s+/g, " ").trim().slice(0, 40);
  return normalized || `情景预设 ${index}`;
}

function formatCompactAssumption(value: number, unit?: string) {
  const formatted = Number.isInteger(value) ? String(value) : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return `${formatted}${unit ?? ""}`;
}

function formatSignedCompact(value: number) {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

function sensitivityPercent(value: number) {
  return String(Number((value * 100).toFixed(4)));
}

function formatDecisionGap(value: number) {
  return `${Math.abs(value * 100).toFixed(1)}%`;
}

function formatSignedDecisionGap(value: number) {
  return `${value >= 0 ? "+" : "−"}${formatDecisionGap(value)}`;
}

function formatDecisionDirection(value: number) {
  return `${value >= 0 ? "上行" : "下行"} ${formatDecisionGap(value)}`;
}
