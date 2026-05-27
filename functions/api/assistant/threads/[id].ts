import { deleteAssistantThread, json, requireAdminSession, type AssistantEnv } from "../../../_shared/assistant-db";

export const onRequestDelete: PagesFunction<AssistantEnv> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const threadId = params.id as string;
  if (!threadId) return json({ error: "Missing thread ID." }, 400);
  await deleteAssistantThread(env.REPORT_LIBRARY_DB, threadId, session.userId);
  return json({ ok: true });
};
