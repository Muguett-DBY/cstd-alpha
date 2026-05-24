import { confirmMemoryCandidate, json, requireAdminSession, type AssistantEnv } from "../../../../_shared/assistant-db";

export const onRequestPost: PagesFunction<AssistantEnv> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const id = String(params.id || "").trim();
  if (!id) return json({ error: "缺少记忆候选 ID。" }, 400);
  const memory = await confirmMemoryCandidate(env.REPORT_LIBRARY_DB, session.userId, id);
  if (!memory) return json({ error: "记忆候选不存在或已处理。" }, 404);
  return json({ memory });
};
