import { requireAdminSession, type AssistantEnv } from "../../_shared/assistant-db";
import { json } from "../../_shared/user-research-db";
import { reorderResearchItems } from "../../_shared/research-workbench-db";
import { RESEARCH_STAGES, type ResearchStage } from "../../../src/shared/research-workbench";

type Env = AssistantEnv & {
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const body = (await request.json().catch(() => null)) as { updates?: unknown[] } | null;
  if (!body?.updates?.length) return json({ error: "缺少更新数据。" }, 400);
  if (body.updates.length > 50) return json({ error: "单次最多更新 50 项。" }, 400);
  const updates: Array<{ id: string; stage: ResearchStage; sortOrder: number }> = [];
  for (const update of body.updates) {
    const normalized = normalizeReorderUpdate(update);
    if (!normalized) return json({ error: "研究项排序数据无效。" }, 400);
    updates.push(normalized);
  }
  await reorderResearchItems(env.REPORT_LIBRARY_DB, session.userId, updates);
  return json({ ok: true });
};

function normalizeReorderUpdate(value: unknown): { id: string; stage: ResearchStage; sortOrder: number } | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const stage = typeof value.stage === "string" && RESEARCH_STAGES.includes(value.stage as ResearchStage)
    ? value.stage as ResearchStage
    : null;
  const sortOrder = typeof value.sortOrder === "number" && Number.isFinite(value.sortOrder)
    ? value.sortOrder
    : null;
  if (!id || !stage || sortOrder === null) return null;
  return { id, stage, sortOrder };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
