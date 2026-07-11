import { requireAdminSession, type AssistantEnv } from "../../_shared/assistant-db";
import { json } from "../../_shared/user-research-db";
import { confirmResearchStage, readResearchItemById } from "../../_shared/research-workbench-db";
import { RESEARCH_STAGES, type ResearchStage } from "../../../src/shared/research-workbench";

type Env = AssistantEnv & {
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const id = String(params.id || "");
  const item = await readResearchItemById(env.REPORT_LIBRARY_DB, session.userId, id);
  return item ? json({ item }) : json({ error: "Research item not found." }, 404);
};

export const onRequestPatch: PagesFunction<Env> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const body = (await request.json().catch(() => null)) as { stage?: unknown; sortOrder?: unknown } | null;
  if (!body?.stage) return json({ error: "缺少阶段。" }, 400);
  const stage = body.stage as ResearchStage;
  if (!RESEARCH_STAGES.includes(stage)) return json({ error: "研究阶段数据无效。" }, 400);
  const sortOrder = body.sortOrder === undefined ? undefined : body.sortOrder;
  if (sortOrder !== undefined && (typeof sortOrder !== "number" || !Number.isFinite(sortOrder))) {
    return json({ error: "研究阶段数据无效。" }, 400);
  }
  const item = await confirmResearchStage(env.REPORT_LIBRARY_DB, session.userId, String(params.id || ""), stage, sortOrder);
  return item ? json({ item }) : json({ error: "Research item not found." }, 404);
};
