import { authenticateUser, checkLoginRateLimit, cleanupOldLoginAttempts, clearSessionCookie, createAuthSession, createUser, ensureAuthSchema, publicUser, readSessionCookie, recordLoginAttempt, revokeSession, shouldCleanupLoginAttempts } from "../_shared/auth";

type Env = {
  AUTH_SECRET: string;
  REPORT_PASSWORD?: string;
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await readSessionCookie(request.headers.get("cookie"), env);
  return json({ authenticated: Boolean(session), user: session ? publicUser(session) : null }, session ? 200 : 401);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureAuthSchema(env.REPORT_LIBRARY_DB);
  const body = (await request.json().catch(() => null)) as { username?: string; password?: string } | null;
  const username = body?.username?.trim();
  const password = body?.password ?? "";
  if (!username || !password) return json({ error: "请输入账号和密码。" }, 400);
  if (username.length > 80 || password.length > 256) return json({ error: "账号或密码格式不正确。" }, 400);

  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = new Date();
  const rateLimit = await checkLoginRateLimit(env.REPORT_LIBRARY_DB, ip, username.toLowerCase(), now);
  if (!rateLimit.allowed) return json({ error: rateLimit.message }, 429);

  let user = await authenticateUser(env.REPORT_LIBRARY_DB, username, password);
  if (!user && env.REPORT_PASSWORD && password === env.REPORT_PASSWORD && (await userCount(env.REPORT_LIBRARY_DB)) === 0) {
    user = await createUser(env.REPORT_LIBRARY_DB, { username, password, displayName: username, role: "admin" });
  }
  if (!user) {
    await recordLoginAttempt(env.REPORT_LIBRARY_DB, ip, username.toLowerCase(), now);
    if (shouldCleanupLoginAttempts()) await cleanupOldLoginAttempts(env.REPORT_LIBRARY_DB, now).catch(() => {});
    return json({ error: "账号或密码不正确。" }, 401);
  }

  await cleanupOldLoginAttempts(env.REPORT_LIBRARY_DB, now).catch(() => {});
  const { cookie, session } = await createAuthSession(env.REPORT_LIBRARY_DB, user, now, isSecureRequest(request));
  return json({ authenticated: true, user: publicUser(session) }, 200, { "set-cookie": cookie });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  await revokeSession(request.headers.get("cookie"), env);
  return json({ authenticated: false, user: null }, 200, { "set-cookie": clearSessionCookie(isSecureRequest(request)) });
};

async function userCount(db: D1Database) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM users`).first<{ count: number }>();
  return row?.count ?? 0;
}

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function isSecureRequest(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProto) return forwardedProto === "https";
  return new URL(request.url).protocol === "https:";
}
