import { requireAdminSession, type AssistantEnv } from "../_shared/assistant-db";
import { json } from "../_shared/user-research-db";
import { listResearchItems, upsertResearchItem } from "../_shared/research-workbench-db";
import type { ResearchEntityType, ResearchStage } from "../../src/shared/research-workbench";

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
  const body = (await request.json().catch(() => null)) as {
    entityType?: ResearchEntityType;
    entityId?: string;
    title?: string;
    subtitle?: string;
    source?: string;
    evidenceHash?: string;
    stage?: ResearchStage;
  } | null;
  if (body?.entityType !== "company" && body?.entityType !== "industry") return json({ error: "entityType must be company or industry." }, 400);
  if (!body.entityId?.trim() || !body.title?.trim()) return json({ error: "缺少研究对象。" }, 400);
  const item = await upsertResearchItem(env.REPORT_LIBRARY_DB, {
    userKey: session.userId,
    entityType: body.entityType,
    entityId: body.entityId.trim(),
    title: body.title.trim(),
    subtitle: body.subtitle?.trim(),
    source: body.source?.trim() || "manual",
    evidenceHash: body.evidenceHash?.trim(),
    stage: body.stage,
  });
  return json({ item });
};
