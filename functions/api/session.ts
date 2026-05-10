import { createSessionCookie, verifySessionCookie } from "../_shared/auth";

type Env = {
  REPORT_PASSWORD: string;
  AUTH_SECRET: string;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const ok = await verifySessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
  return json({ authenticated: ok }, ok ? 200 : 401);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = (await request.json().catch(() => null)) as { password?: string } | null;

  if (!env.REPORT_PASSWORD || !env.AUTH_SECRET) {
    return json({ error: "服务器认证尚未配置。" }, 500);
  }

  if (!body?.password || body.password !== env.REPORT_PASSWORD) {
    return json({ error: "密码不正确。" }, 401);
  }

  return json(
    { authenticated: true },
    200,
    {
      "set-cookie": await createSessionCookie(env.AUTH_SECRET),
    },
  );
};

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}
