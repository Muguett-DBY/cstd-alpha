import { json, requireAdminSession, type AssistantEnv } from "../../../_shared/assistant-db";

export const onRequestPost: PagesFunction<AssistantEnv> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_CACHE) return json({ error: "REPORT_CACHE is not configured." }, 500);

  const id = String(params.id || "").trim();
  if (!id) return json({ error: "缺少执行 ID。" }, 400);

  const body = (await request.json().catch(() => null)) as { output?: unknown; error?: unknown } | null;
  if (!body) return json({ error: "请求体为空。" }, 400);
  if (
    (body.output !== undefined && typeof body.output !== "string") ||
    (body.error !== undefined && typeof body.error !== "string")
  ) {
    return json({ error: "代码结果格式无效。" }, 400);
  }
  const output = body.output ?? "";
  const error = body.error ?? "";

  await env.REPORT_CACHE.put(
    `py-exec-${id}`,
    JSON.stringify({ output, error, status: error ? "error" : "completed" }),
    { expirationTtl: 300 },
  );

  return json({ ok: true });
};
