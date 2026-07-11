import { requireAdminSession, type AssistantEnv } from "../../_shared/assistant-db";
import { json } from "../../_shared/user-research-db";
import { deleteResearchItems } from "../../_shared/research-workbench-db";

type Env = AssistantEnv & {
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
  if (!Array.isArray(body?.ids) || !body.ids.length) return json({ error: "缺少删除目标。" }, 400);
  const ids = body.ids.map((id) => (typeof id === "string" ? id.trim() : ""));
  if (ids.some((id) => !id)) return json({ error: "删除目标数据无效。" }, 400);
  if (ids.length > 50) return json({ error: "单次最多删除 50 项。" }, 400);
  await deleteResearchItems(env.REPORT_LIBRARY_DB, session.userId, ids);
  return json({ ok: true, deleted: ids.length });
};
