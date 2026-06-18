import { requireAdminSession, type AssistantEnv } from "../../_shared/assistant-db";
import { json } from "../../_shared/user-research-db";
import { reorderResearchItems } from "../../_shared/research-workbench-db";

type Env = AssistantEnv & {
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const body = (await request.json().catch(() => null)) as { updates?: Array<{ id: string; stage: string; sortOrder: number }> } | null;
  if (!body?.updates?.length) return json({ error: "缺少更新数据。" }, 400);
  if (body.updates.length > 50) return json({ error: "单次最多更新 50 项。" }, 400);
  await reorderResearchItems(env.REPORT_LIBRARY_DB, session.userId, body.updates);
  return json({ ok: true });
};
