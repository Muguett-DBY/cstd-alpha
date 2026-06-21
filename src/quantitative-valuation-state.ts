import { validateQuantitativeDraft, type EditableAssumption, type QuantitativeDraft } from "./shared/quantitative-valuation";

export type DraftEdit = {
  key: string;
  scenario: "bear" | "base" | "bull";
  rawValue: string;
  forecastYear?: number;
};

export type DraftWarning = { level: "error" | "warning"; message: string };

export const SIMPLE_EDITOR_FIELDS = [
  "revenueGrowth", "ebitMargin", "capexRate", "workingCapitalRate", "taxRate",
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
  const number = changed.value ?? changed.base;
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
