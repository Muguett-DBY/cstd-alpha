import { verifySessionCookie } from "../_shared/auth";
import { callDeepSeekReport } from "../_shared/deepseek";
import { fetchPublicCompanyEvidence } from "../_shared/providers";

type Env = {
  AUTH_SECRET: string;
  DEEPSEEK_API_KEY: string;
};

type ReportRequest = {
  companyName?: string;
  ticker?: string;
  market?: string;
  language?: "zh-CN" | "en";
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const body = (await request.json().catch(() => null)) as ReportRequest | null;
  const companyName = body?.companyName?.trim();
  if (!companyName) return json({ error: "companyName is required." }, 400);
  if (!env.DEEPSEEK_API_KEY) return json({ error: "DEEPSEEK_API_KEY is not configured." }, 500);

  try {
    const evidence = await fetchPublicCompanyEvidence({
      companyName,
      ticker: body?.ticker?.trim() || undefined,
      market: body?.market?.trim() || undefined,
    });
    const report = await callDeepSeekReport({
      apiKey: env.DEEPSEEK_API_KEY,
      evidence,
      language: body?.language ?? "zh-CN",
    });

    return json({ report, evidence });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Report generation failed.",
      },
      502,
    );
  }
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
