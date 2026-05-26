import { json, requireAdminSession, type AssistantEnv } from "../../../_shared/assistant-db";

export const onRequestPost: PagesFunction<AssistantEnv> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_CACHE) return json({ error: "REPORT_CACHE is not configured." }, 500);

  const id = String(params.id || "").trim();
  if (!id) return json({ error: "缺少执行 ID。" }, 400);

  const body = (await request.json().catch(() => null)) as { output?: string; error?: string } | null;
  if (!body) return json({ error: "请求体为空。" }, 400);

  await env.REPORT_CACHE.put(
    `py-exec-${id}`,
    JSON.stringify({ output: body.output ?? "", error: body.error ?? "", status: body.error ? "error" : "completed" }),
    { expirationTtl: 300 },
  );

  return json({ ok: true });
};
