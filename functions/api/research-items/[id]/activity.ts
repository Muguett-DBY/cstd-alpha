import { requireAdminSession, type AssistantEnv } from "../../../_shared/assistant-db";
import { json } from "../../../_shared/user-research-db";
import { listActivityEvents } from "../../../_shared/research-workbench-db";

type Env = AssistantEnv & {
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const itemId = Array.isArray(params.id) ? params.id[0] : String(params.id || "");
  if (!itemId) return json({ error: "缺少研究项 ID。" }, 400);
  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;
  const events = await listActivityEvents(env.REPORT_LIBRARY_DB, session.userId, itemId, limit);
  return json({ events });
};
