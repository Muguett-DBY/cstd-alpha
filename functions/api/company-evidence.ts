import { verifySessionCookie } from "../_shared/auth";
import { fetchPublicCompanyEvidence } from "../_shared/providers";
import type { CompanyCandidate } from "../../src/shared/report";

type Env = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
  TUSHARE_TOKEN?: string;
};

type EvidenceRequest = {
  company?: CompanyCandidate;
  companyName?: string;
  ticker?: string;
  market?: string;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const body = (await request.json().catch(() => null)) as EvidenceRequest | null;
  const companyName = body?.company?.name?.trim() || body?.companyName?.trim();
  if (!companyName) return json({ error: "请先提供公司名称。" }, 400);
  if (companyName.length > 120) return json({ error: "公司名称过长，请重新选择上市主体。" }, 400);
  const ticker = body?.company?.code || body?.ticker;
  const market = body?.company?.listingPlace || body?.market;
  if (typeof ticker === "string" && ticker.length > 40) return json({ error: "股票代码过长，请重新选择上市主体。" }, 400);
  if (typeof market === "string" && market.length > 40) return json({ error: "市场信息过长，请重新选择上市主体。" }, 400);

  const evidence = await fetchPublicCompanyEvidence({
    companyName,
    ticker,
    market,
    company: body?.company,
    tushareToken: env.TUSHARE_TOKEN,
    signal: request.signal,
  });
  return json({ evidence });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
