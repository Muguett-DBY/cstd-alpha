import { verifySessionCookie } from "../_shared/auth";
import { fetchChartBundle } from "../_shared/providers";
import type { PriceMode } from "../../src/shared/chart";
import type { CompanyCandidate } from "../../src/shared/report";

type Env = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
};

type ChartRequest = {
  company?: CompanyCandidate;
  priceMode?: PriceMode;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const body = (await request.json().catch(() => null)) as ChartRequest | null;
  if (!isValidCompanyCandidateInput(body?.company)) return json({ error: "请先搜索并选择一个候选公司。" }, 400);
  const priceMode = body.priceMode === "raw" ? "raw" : "adjusted";

  const bundle = await fetchChartBundle({ company: body.company, priceMode, signal: request.signal });
  return json(bundle);
};

function isValidCompanyCandidateInput(company: CompanyCandidate | undefined): company is CompanyCandidate {
  if (!company || typeof company.name !== "string" || typeof company.code !== "string") return false;
  const name = company.name.trim();
  const code = company.code.trim();
  if (!name || !code || name.length > 120 || code.length > 40) return false;
  if (typeof company.listingPlace === "string" && company.listingPlace.length > 40) return false;
  if (typeof company.marketType === "string" && company.marketType.length > 40) return false;
  return true;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
