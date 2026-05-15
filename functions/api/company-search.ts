import { verifySessionCookie } from "../_shared/auth";
import { searchCompanyCandidates } from "../_shared/providers";

type Env = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "未登录。" }, 401);

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  if (!query) return json({ candidates: [] });

  const candidates = await searchCompanyCandidates(query, fetch, request.signal);
  return json({ candidates });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
