import { ensureAssistantSchema, getOrCreateDefaultThread, json, readAllMemories, readLatestUsage, readPendingMemoryCandidates, readRecentMessages, requireAdminSession, type AssistantEnv } from "../../_shared/assistant-db";

export const onRequestGet: PagesFunction<AssistantEnv> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureAssistantSchema(env.REPORT_LIBRARY_DB);
  const url = new URL(request.url);
  const threadId = url.searchParams.get("threadId");
  const thread = threadId
    ? await getOrCreateDefaultThread(env.REPORT_LIBRARY_DB, session.userId, threadId)
    : await getOrCreateDefaultThread(env.REPORT_LIBRARY_DB, session.userId);
  const [messages, memories, memoryCandidates, latestUsage] = await Promise.all([
    readRecentMessages(env.REPORT_LIBRARY_DB, session.userId, thread.id, 80),
    readAllMemories(env.REPORT_LIBRARY_DB, session.userId),
    readPendingMemoryCandidates(env.REPORT_LIBRARY_DB, session.userId),
    readLatestUsage(env.REPORT_LIBRARY_DB, session.userId, thread.id),
  ]);
  return json({
    thread: {
      id: thread.id,
      title: thread.title,
      summary: thread.summary,
      updatedAt: thread.updated_at,
      messages,
      memories,
      memoryCandidates,
      latestUsage,
    },
  });
};
