import { requireAdminSession, type AssistantEnv } from "../_shared/assistant-db";
import { createQuantitativeVersion, readQuantitativeWorkspace } from "../_shared/research-workbench-db";
import { json } from "../_shared/user-research-db";
import {
  calculateQuantitativeDraft,
  validateQuantitativeDraft,
  type EditableAssumption,
  type QuantitativeDraft,
  type QuantitativePreset,
} from "../../src/shared/quantitative-valuation";

type Env = AssistantEnv & { REPORT_LIBRARY_DB?: D1Database };
type UserAssumptionEdit = Partial<EditableAssumption> & { key: string };

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const runId = new URL(request.url).searchParams.get("runId")?.trim();
  if (!runId) return json({ error: "缺少估值任务。" }, 400);
  const workspace = await readQuantitativeWorkspace(env.REPORT_LIBRARY_DB, session.userId, runId);
  if (!workspace) return json({ error: "估值任务不存在。" }, 404);
  if (!workspace.versions.length) return json({ error: "估值草稿尚未准备完成。" }, 409);
  return json({ workspace });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const body = await request.json().catch(() => null) as {
    runId?: string;
    parentVersionId?: string;
    assumptions?: UserAssumptionEdit[];
    decisionNote?: string;
    presets?: QuantitativePreset[];
  } | null;
  if (!body?.runId?.trim() || !body.parentVersionId?.trim() || !Array.isArray(body.assumptions)) {
    return json({ error: "估值保存参数不完整。" }, 400);
  }
  const workspace = await readQuantitativeWorkspace(env.REPORT_LIBRARY_DB, session.userId, body.runId.trim());
  if (!workspace) return json({ error: "估值任务不存在。" }, 404);
  const latest = workspace.versions[0];
  if (!latest?.draft || !workspace.snapshot) return json({ error: "估值草稿尚未准备完成。" }, 409);
  if (body.parentVersionId !== latest.id) return json({ error: "估值版本已更新，请刷新后再保存。" }, 409);
  try {
    const draft = mergeUserAssumptions(latest.draft, body.assumptions, { presets: body.presets });
    validateQuantitativeDraft(draft);
    const result = calculateQuantitativeDraft(draft);
    const version = await createQuantitativeVersion(env.REPORT_LIBRARY_DB, {
      userKey: session.userId,
      runId: body.runId.trim(),
      snapshotId: workspace.snapshot.id,
      draft,
      result,
      parentVersionId: latest.id,
      createdBy: "user",
      decisionNote: body.decisionNote,
    });
    const nextWorkspace = await readQuantitativeWorkspace(env.REPORT_LIBRARY_DB, session.userId, body.runId.trim());
    return json({ workspace: nextWorkspace, version }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "估值保存失败。" }, 400);
  }
};

export function isAshareResearchItem(item: { entityType: string; entityId: string; subtitle?: string }) {
  if (item.entityType !== "company") return false;
  const text = `${item.entityId} ${item.subtitle ?? ""}`;
  return /\d{6}/.test(text) && /A股|沪A|深A|创业板|科创板|SH-A|SZ-A|ASTOCK/i.test(text);
}

export function mergeUserAssumptions(draft: QuantitativeDraft, edits: UserAssumptionEdit[], options: { presets?: QuantitativePreset[] } = {}): QuantitativeDraft {
  const assumptions = (draft.assumptions ?? []).map((assumption) => {
    const edit = edits.find((candidate) => candidate.key === assumption.key && candidate.forecastYear === assumption.forecastYear);
    return edit ? { ...assumption, ...editableFields(edit), origin: "user" as const, locked: true } : assumption;
  });
  const merged: QuantitativeDraft = { ...draft, assumptions, presets: normalizeValuationPresets(options.presets ?? draft.presets) };
  if (!merged.operating) return merged;
  const lookup = (key: string) => assumptions.find((assumption) => assumption.key === key);
  const percentTriple = (key: string, fallback: { low: number; base: number; high: number }) => {
    const assumption = lookup(key);
    return assumption && assumption.bear !== undefined && assumption.base !== undefined && assumption.bull !== undefined
      ? { low: assumption.bear / 100, base: assumption.base / 100, high: assumption.bull / 100 }
      : fallback;
  };
  const inversePercentTriple = (key: string, fallback: { low: number; base: number; high: number }) => {
    const assumption = lookup(key);
    return assumption && assumption.bear !== undefined && assumption.base !== undefined && assumption.bull !== undefined
      ? { low: assumption.bull / 100, base: assumption.base / 100, high: assumption.bear / 100 }
      : fallback;
  };
  const percentScalar = (key: string, fallback: number) => {
    const assumption = lookup(key);
    const value = assumption?.value ?? assumption?.base;
    return typeof value === "number" ? value / 100 : fallback;
  };
  const numberScalar = (key: string, fallback: number) => {
    const assumption = lookup(key);
    const value = assumption?.base ?? assumption?.value;
    return typeof value === "number" ? value : fallback;
  };
  merged.operating = {
    ...merged.operating,
    baseRevenue: numberScalar("baseRevenue", merged.operating.baseRevenue),
    revenueGrowth: percentTriple("revenueGrowth", merged.operating.revenueGrowth),
    ebitMargin: percentTriple("ebitMargin", merged.operating.ebitMargin),
    capexRate: percentTriple("capexRate", merged.operating.capexRate),
    discountRate: inversePercentTriple("discountRate", merged.operating.discountRate),
    terminalGrowthRate: percentTriple("terminalGrowthRate", merged.operating.terminalGrowthRate),
    taxRate: percentScalar("taxRate", merged.operating.taxRate),
    workingCapitalRate: percentScalar("workingCapitalRate", merged.operating.workingCapitalRate),
    netDebt: numberScalar("netDebt", merged.operating.netDebt),
    sharesOutstanding: numberScalar("sharesOutstanding", merged.operating.sharesOutstanding),
  };
  merged.scenarios = {
    bear: { discountRate: merged.operating.discountRate.high, terminalGrowthRate: merged.operating.terminalGrowthRate.low },
    base: { discountRate: merged.operating.discountRate.base, terminalGrowthRate: merged.operating.terminalGrowthRate.base },
    bull: { discountRate: merged.operating.discountRate.low, terminalGrowthRate: merged.operating.terminalGrowthRate.high },
  };
  return merged;
}

function editableFields(edit: UserAssumptionEdit) {
  return Object.fromEntries(Object.entries(edit).filter(([key, value]) =>
    ["value", "bear", "base", "bull", "forecastYear"].includes(key) && typeof value === "number" && Number.isFinite(value),
  ));
}

function normalizeValuationPresets(presets: QuantitativePreset[] | undefined): QuantitativePreset[] | undefined {
  const normalized = (presets ?? []).flatMap((preset) => {
    if (!preset || typeof preset.id !== "string" || typeof preset.name !== "string" || typeof preset.createdAt !== "string") return [];
    const assumptions = Array.isArray(preset.assumptions) ? preset.assumptions.flatMap(normalizePresetAssumption) : [];
    if (!assumptions.length) return [];
    return [{
      id: preset.id.replace(/[^\w:-]/g, "").slice(0, 80) || crypto.randomUUID(),
      name: preset.name.replace(/\s+/g, " ").trim().slice(0, 40) || "未命名预设",
      createdAt: preset.createdAt,
      assumptions,
    }];
  });
  return normalized.length ? normalized.slice(-12) : undefined;
}

function normalizePresetAssumption(assumption: EditableAssumption): EditableAssumption[] {
  if (!assumption || typeof assumption.key !== "string" || typeof assumption.label !== "string") return [];
  const next: EditableAssumption = {
    key: assumption.key,
    label: assumption.label,
    unit: typeof assumption.unit === "string" ? assumption.unit : undefined,
    origin: "user",
    locked: true,
    forecastYear: typeof assumption.forecastYear === "number" && Number.isFinite(assumption.forecastYear) ? assumption.forecastYear : undefined,
  };
  for (const key of ["value", "bear", "base", "bull"] as const) {
    const value = assumption[key];
    if (typeof value === "number" && Number.isFinite(value)) next[key] = value;
  }
  return next.value === undefined && next.base === undefined && next.bear === undefined && next.bull === undefined ? [] : [next];
}
