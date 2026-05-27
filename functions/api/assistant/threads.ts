import { ensureAssistantSchema, getOrCreateDefaultThread, json, listAssistantThreads, createAssistantThread, requireAdminSession, type AssistantEnv } from "../../_shared/assistant-db";

export const onRequestGet: PagesFunction<AssistantEnv> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureAssistantSchema(env.REPORT_LIBRARY_DB);
  const threads = await listAssistantThreads(env.REPORT_LIBRARY_DB, session.userId);
  if (!threads.length) {
    const thread = await getOrCreateDefaultThread(env.REPORT_LIBRARY_DB, session.userId);
    return json({ threads: [{ id: thread.id, title: thread.title, summary: thread.summary, updatedAt: thread.updated_at }] });
  }
  return json({ threads: threads.map((t) => ({ id: t.id, title: t.title, summary: t.summary, updatedAt: t.updated_at })) });
};

export const onRequestPost: PagesFunction<AssistantEnv> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const body = await request.json().catch(() => null) as { title?: string } | null;
  const thread = await createAssistantThread(env.REPORT_LIBRARY_DB, session.userId, body?.title || "新对话");
  return json({ thread: { id: thread.id, title: thread.title, summary: thread.summary, updatedAt: thread.updated_at } });
};
