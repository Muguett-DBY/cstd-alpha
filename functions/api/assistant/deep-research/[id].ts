import { readAssistantDeepResearchJob } from "../../../_shared/assistant-deep-research";
import { json, requireAdminSession, type AssistantEnv } from "../../../_shared/assistant-db";

export const onRequestGet: PagesFunction<AssistantEnv> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const id = typeof params.id === "string" ? params.id : "";
  if (!id) return json({ error: "深度研究任务不存在。" }, 404);
  const job = await readAssistantDeepResearchJob(env.REPORT_LIBRARY_DB, session.userId, id);
  return job ? json({ job }) : json({ error: "深度研究任务不存在。" }, 404);
};
