import { requireAdminSession, type AssistantEnv } from "../_shared/assistant-db";
import { json } from "../_shared/user-research-db";
import { listResearchItems, upsertResearchItem } from "../_shared/research-workbench-db";
import { RESEARCH_STAGES, type ResearchEntityType, type ResearchStage } from "../../src/shared/research-workbench";

type Env = AssistantEnv & {
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const items = await listResearchItems(env.REPORT_LIBRARY_DB, session.userId);
  return json({ items });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const entityType = normalizeEntityType(body?.entityType);
  const entityId = normalizeRequiredText(body?.entityId);
  const title = normalizeRequiredText(body?.title);
  const subtitle = normalizeOptionalText(body?.subtitle);
  const source = normalizeOptionalText(body?.source);
  const evidenceHash = normalizeOptionalText(body?.evidenceHash);
  const stage = body && "stage" in body ? normalizeResearchStage(body.stage) : undefined;
  if (!entityType) return json({ error: "entityType must be company or industry." }, 400);
  if (!entityId || !title) return json({ error: "缺少研究对象。" }, 400);
  if (subtitle === null || source === null || evidenceHash === null) return json({ error: "研究对象数据无效。" }, 400);
  if (stage === null) return json({ error: "研究阶段数据无效。" }, 400);
  const result = await upsertResearchItem(env.REPORT_LIBRARY_DB, {
    userKey: session.userId,
    entityType,
    entityId,
    title,
    subtitle,
    source: source || "manual",
    evidenceHash,
    stage,
  });
  return json(result);
};

function normalizeEntityType(value: unknown): ResearchEntityType | null {
  return value === "company" || value === "industry" ? value : null;
}

function normalizeResearchStage(value: unknown): ResearchStage | null {
  return RESEARCH_STAGES.includes(value as ResearchStage) ? value as ResearchStage : null;
}

function normalizeRequiredText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalText(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  return value.trim() || undefined;
}
