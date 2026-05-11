import { verifySessionCookie } from "../_shared/auth";
import { fetchChartBundle } from "../_shared/providers";
import type { PriceMode } from "../../src/shared/chart";
import type { CompanyCandidate } from "../../src/shared/report";

type Env = {
  AUTH_SECRET: string;
};

type ChartRequest = {
  company?: CompanyCandidate;
  priceMode?: PriceMode;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const body = (await request.json().catch(() => null)) as ChartRequest | null;
  if (!body?.company?.name || !body.company.code) return json({ error: "请先搜索并选择一个候选公司。" }, 400);
  const priceMode = body.priceMode === "raw" ? "raw" : "adjusted";

  const bundle = await fetchChartBundle({ company: body.company, priceMode, signal: request.signal });
  return json(bundle);
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
