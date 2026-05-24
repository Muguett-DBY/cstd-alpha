import { ensureAssistantSchema, getOrCreateDefaultThread, json, requireAdminSession, type AssistantEnv } from "../../_shared/assistant-db";

export const onRequestGet: PagesFunction<AssistantEnv> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureAssistantSchema(env.REPORT_LIBRARY_DB);
  const thread = await getOrCreateDefaultThread(env.REPORT_LIBRARY_DB, session.userId);
  return json({ threads: [{ id: thread.id, title: thread.title, summary: thread.summary, updatedAt: thread.updated_at }] });
};
