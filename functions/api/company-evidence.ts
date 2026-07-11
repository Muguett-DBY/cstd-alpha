import { verifySessionCookie } from "../_shared/auth";
import { fetchPublicCompanyEvidence } from "../_shared/providers";
import type { CompanyCandidate } from "../../src/shared/report";

type Env = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
  TUSHARE_TOKEN?: string;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const rawCompany = isRecord(body?.company) ? body.company : undefined;
  const company = normalizeCompanyCandidate(rawCompany);
  const companyName = normalizeRequiredText(rawCompany?.name) || normalizeRequiredText(body?.companyName);
  if (!companyName) return json({ error: "请先提供公司名称。" }, 400);
  if (companyName.length > 120) return json({ error: "公司名称过长，请重新选择上市主体。" }, 400);
  const ticker = normalizeOptionalText(rawCompany?.code) || normalizeOptionalText(body?.ticker);
  const market = normalizeOptionalText(rawCompany?.listingPlace) || normalizeOptionalText(body?.market);
  if (ticker && ticker.length > 40) return json({ error: "股票代码过长，请重新选择上市主体。" }, 400);
  if (market && market.length > 40) return json({ error: "市场信息过长，请重新选择上市主体。" }, 400);

  const evidence = await fetchPublicCompanyEvidence({
    companyName,
    ticker,
    market,
    company,
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

function normalizeCompanyCandidate(value: Record<string, unknown> | undefined): CompanyCandidate | undefined {
  if (!value) return undefined;
  const id = normalizeRequiredText(value.id);
  const name = normalizeRequiredText(value.name);
  const code = normalizeRequiredText(value.code);
  const exchange = normalizeRequiredText(value.exchange);
  const listingPlace = normalizeRequiredText(value.listingPlace);
  const marketType = normalizeRequiredText(value.marketType);
  const source = value.source === "eastmoney" || value.source === "yahoo" ? value.source : undefined;
  if (!id || !name || !code || !exchange || !listingPlace || !marketType || !source) return undefined;
  return {
    id,
    name,
    code,
    exchange,
    listingPlace,
    marketType,
    source,
    industry: normalizeOptionalText(value.industry),
    sector: normalizeOptionalText(value.sector),
    quoteId: normalizeOptionalText(value.quoteId),
    secid: normalizeOptionalText(value.secid),
    yahooSymbol: normalizeOptionalText(value.yahooSymbol),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRequiredText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalText(value: unknown) {
  const text = normalizeRequiredText(value);
  return text || undefined;
}
