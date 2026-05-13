import { verifySessionCookie } from "../_shared/auth";
import { fetchPublicCompanyEvidence } from "../_shared/providers";
import type { CompanyCandidate } from "../../src/shared/report";

type Env = {
  AUTH_SECRET: string;
};

type EvidenceRequest = {
  company?: CompanyCandidate;
  companyName?: string;
  ticker?: string;
  market?: string;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const body = (await request.json().catch(() => null)) as EvidenceRequest | null;
  const companyName = body?.company?.name?.trim() || body?.companyName?.trim();
  if (!companyName) return json({ error: "请先提供公司名称。" }, 400);

  const evidence = await fetchPublicCompanyEvidence({
    companyName,
    ticker: body?.company?.code || body?.ticker,
    market: body?.company?.listingPlace || body?.market,
    company: body?.company,
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
