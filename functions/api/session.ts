import { createSessionCookie, normalizeUsername, readSessionCookie, usernameToKey } from "../_shared/auth";

type Env = {
  REPORT_PASSWORD: string;
  AUTH_SECRET: string;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await readSessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
  return json({ authenticated: Boolean(session), user: session ? { username: session.username, userKey: session.userKey } : null }, session ? 200 : 401);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = (await request.json().catch(() => null)) as { password?: string; username?: string } | null;

  if (!env.REPORT_PASSWORD || !env.AUTH_SECRET) {
    return json({ error: "服务器认证尚未配置。" }, 500);
  }

  if (!body?.password || body.password !== env.REPORT_PASSWORD) {
    return json({ error: "密码不正确。" }, 401);
  }

  const username = normalizeUsername(body.username);
  return json(
    { authenticated: true, user: { username, userKey: usernameToKey(username) } },
    200,
    {
      "set-cookie": await createSessionCookie(env.AUTH_SECRET, new Date().toISOString(), { username: body.username }),
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
