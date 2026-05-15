import { verifySessionCookie } from "../_shared/auth";
import {
  buildReportLibraryEntry,
  cleanIndustryLabel,
  normalizeEntryConclusion,
  normalizeEntryPositionAdvice,
  normalizeEntryValuationView,
  parseReportLibraryReports,
  reportLibraryIdentity,
  validateLibraryReport,
  type ReportLibraryEntry,
} from "../../src/shared/report-library";
import { industryMembersForGroup } from "../../src/shared/industry";
import type { InvestmentReport } from "../../src/shared/report";

type Env = {
  AUTH_SECRET: string;
  REPORT_CACHE?: KVNamespace;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

type ReportLibraryRecord = {
  entry: ReportLibraryEntry;
  report: InvestmentReport;
};

const LIBRARY_VERSION = "v1";
const REPORT_PREFIX = `report-library:${LIBRARY_VERSION}:report:`;
const R2_REPORT_PREFIX = `report-library/${LIBRARY_VERSION}/reports/`;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim();
  if (id) {
    const record = (await readDurableReportRecord(env, id)) ?? (env.REPORT_CACHE ? await readKvReportRecord(env.REPORT_CACHE, id) : null);
    if (!record) return json({ error: "报告不存在。" }, 404);
    return json(record);
  }

  const limit = boundedListLimit(url.searchParams.get("limit"));
  const offset = boundedListOffset(url.searchParams.get("offset"));
  const order = listOrder(url.searchParams.get("sort"), url.searchParams.get("direction"));
  const industry = cleanIndustryLabel(url.searchParams.get("industry"));
  const market = parseMarketFilter(url.searchParams.get("market"));
  const seedCodes = parseTickerCodes(url.searchParams.get("seedCodes"));
  const tickers = parseTickerCodes(url.searchParams.get("tickers"));
  if (hasDurableLibrary(env)) {
    const [{ entries, total }, matchedTickers] = await Promise.all([
      listDurableReportEntries(env.REPORT_LIBRARY_DB, limit, offset, order, industry, market, tickers),
      listDurableMatchedTickers(env.REPORT_LIBRARY_DB, seedCodes, market),
    ]);
    return json({ entries, total, limit, offset, matchedTickers });
  }

  const { entries, total } = env.REPORT_CACHE ? await listKvReportEntries(env.REPORT_CACHE, limit, offset, industry, market, tickers) : { entries: [], total: 0 };
  return json({ entries, total, limit, offset, matchedTickers: [] });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);
  if (!hasDurableLibrary(env)) return json({ error: "REPORT_LIBRARY_DB/REPORT_LIBRARY_BUCKET is not configured." }, 500);

  try {
    const body = await request.json();
    const reports = parseReportLibraryReports(body);
    const importedAt = new Date().toISOString();
    const entries = await Promise.all(reports.map((report) => writeReportRecord(env, report, importedAt)));
    return json({ imported: entries });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "报告导入失败。" }, 400);
  }
};

async function writeReportRecord(env: Env, rawReport: InvestmentReport, importedAt: string) {
  const report = validateLibraryReport(rawReport);
  const id = await reportLibraryId(report);
  if (hasDurableLibrary(env)) return writeDurableReportRecord(env.REPORT_LIBRARY_DB, env.REPORT_LIBRARY_BUCKET, report, id, importedAt);
  throw new Error("REPORT_LIBRARY_DB/REPORT_LIBRARY_BUCKET is not configured.");
}

async function writeDurableReportRecord(db: D1Database, bucket: R2Bucket, report: InvestmentReport, id: string, importedAt: string) {
  const existing = await readDurableIndexRow(db, id);
  const reportJson = JSON.stringify(report);
  const reportHash = await sha256(reportJson);
  if (existing?.report_hash === reportHash) return rowToEntry(existing);

  const entry = buildReportLibraryEntry(report, id, importedAt);
  const objectKey = `${R2_REPORT_PREFIX}${id}.json`;
  await bucket.put(objectKey, reportJson, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { reportHash },
  });
  await db
    .prepare(
      `INSERT INTO report_library (
        id, company_name, ticker, market, industry, sector, cqs, ias, conclusion,
        qualitative_band, position_advice, valuation_view, as_of, imported_at,
        evidence_count, score_item_count, object_key, report_hash
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
      ON CONFLICT(id) DO UPDATE SET
        company_name = excluded.company_name,
        ticker = excluded.ticker,
        market = excluded.market,
        industry = excluded.industry,
        sector = excluded.sector,
        cqs = excluded.cqs,
        ias = excluded.ias,
        conclusion = excluded.conclusion,
        qualitative_band = excluded.qualitative_band,
        position_advice = excluded.position_advice,
        valuation_view = excluded.valuation_view,
        as_of = excluded.as_of,
        imported_at = excluded.imported_at,
        evidence_count = excluded.evidence_count,
        score_item_count = excluded.score_item_count,
        object_key = excluded.object_key,
        report_hash = excluded.report_hash`,
    )
    .bind(
      entry.id,
      entry.companyName,
      entry.ticker ?? null,
      entry.market ?? null,
      entry.industry ?? null,
      entry.sector ?? null,
      entry.cqs,
      entry.ias,
      entry.conclusion,
      entry.qualitativeBand,
      entry.positionAdvice,
      entry.valuationView,
      entry.asOf,
      entry.importedAt,
      entry.evidenceCount,
      entry.scoreItemCount,
      objectKey,
      reportHash,
    )
    .run();
  return entry;
}

async function readDurableReportRecord(env: Env, id: string): Promise<ReportLibraryRecord | null> {
  if (!hasDurableLibrary(env)) return null;
  const row = await readDurableIndexRow(env.REPORT_LIBRARY_DB, id);
  if (!row) return null;
  const object = await env.REPORT_LIBRARY_BUCKET.get(row.object_key);
  if (!object) return null;
  const report = validateLibraryReport(await object.json());
  return {
    entry: rowToEntry(row),
    report,
  };
}

async function readKvReportRecord(cache: KVNamespace, id: string): Promise<ReportLibraryRecord | null> {
  const record = await cache.get<ReportLibraryRecord>(`${REPORT_PREFIX}${id}`, "json");
  if (!isRecord(record) || !isRecord(record.entry) || !isRecord(record.report)) return null;
  const report = validateLibraryReport(record.report);
  return {
    entry: record.entry as ReportLibraryEntry,
    report,
  };
}

async function listDurableReportEntries(db: D1Database, limit: number, offset: number, order: string, industry?: string, market?: MarketFilter, tickers: string[] = []) {
  const filters = durableListFilters(industry, market, tickers);
  const selectParams = [...filters.params, limit, offset];
  const [countRow, result] = await Promise.all([
    bindD1(db.prepare(`SELECT COUNT(*) AS count FROM report_library ${filters.where}`), filters.params).first<{ count: number }>(),
    db
      .prepare(
        `SELECT
        id, company_name, ticker, market, industry, sector, cqs, ias, conclusion,
        qualitative_band, position_advice, valuation_view, as_of, imported_at,
        evidence_count, score_item_count, object_key, report_hash
      FROM report_library
      ${filters.where}
      ORDER BY ${order}
      LIMIT ?${filters.params.length + 1} OFFSET ?${filters.params.length + 2}`,
      )
      .bind(...selectParams)
      .all<ReportLibraryRow>(),
  ]);
  return { entries: (result.results ?? []).map(rowToEntry), total: countRow?.count ?? 0 };
}

async function listDurableMatchedTickers(db: D1Database, seedCodes: string[], market?: MarketFilter) {
  if (!seedCodes.length) return [];
  const marketCandidates = market ? marketMembersForGroup(market) : [];
  const tickerPlaceholders = seedCodes.map((_, index) => `?${index + 1}`).join(", ");
  const marketClause = marketCandidates.length
    ? ` AND ${normalizedMarketSql()} IN (${marketCandidates.map((_, index) => `?${seedCodes.length + index + 1}`).join(", ")})`
    : "";
  const result = await db
    .prepare(`SELECT DISTINCT ticker FROM report_library WHERE ticker IN (${tickerPlaceholders})${marketClause}`)
    .bind(...seedCodes, ...marketCandidates)
    .all<{ ticker: string }>();
  return (result.results ?? []).map((row) => row.ticker).filter(Boolean);
}

async function listKvReportEntries(cache: KVNamespace, limit: number, offset: number, industry?: string, market?: MarketFilter, tickers: string[] = []) {
  const entries: ReportLibraryEntry[] = [];
  const candidates = industry ? new Set(industryMembersForGroup(industry)) : null;
  const tickerSet = tickers.length ? new Set(tickers.map((ticker) => ticker.toUpperCase())) : null;
  let cursor: string | undefined;
  let total = 0;
  do {
    const page = await cache.list({ prefix: REPORT_PREFIX, cursor });
    total += page.keys.length;
    const pageEntries = await Promise.all(
      page.keys.map(async (key) => {
        const value = await cache.get<ReportLibraryRecord>(key.name, "json");
        return isRecord(value) && isValidEntry(value.entry) ? value.entry : null;
      }),
    );
    entries.push(
      ...pageEntries.filter((entry): entry is ReportLibraryEntry => {
        if (!entry) return false;
        if (market && !entryMatchesMarket(entry, market)) return false;
        if (tickerSet && !tickerSet.has((entry.ticker ?? "").toUpperCase())) return false;
        if (!candidates) return true;
        return candidates.has(cleanIndustryLabel(entry.industry) ?? "") || candidates.has(cleanIndustryLabel(entry.sector) ?? "");
      }),
    );
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const sorted = entries.sort((left, right) => {
    if (right.ias !== left.ias) return right.ias - left.ias;
    if (right.cqs !== left.cqs) return right.cqs - left.cqs;
    return left.companyName.localeCompare(right.companyName);
  });
  return { entries: sorted.slice(offset, offset + limit), total: candidates ? sorted.length : total };
}

async function readDurableIndexRow(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT
        id, company_name, ticker, market, industry, sector, cqs, ias, conclusion,
        qualitative_band, position_advice, valuation_view, as_of, imported_at,
        evidence_count, score_item_count, object_key, report_hash
      FROM report_library
      WHERE id = ?1`,
    )
    .bind(id)
    .first<ReportLibraryRow>();
}

async function reportLibraryId(report: InvestmentReport) {
  return sha256(reportLibraryIdentity(report));
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isValidEntry(value: unknown): value is ReportLibraryEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.companyName === "string" &&
    typeof value.cqs === "number" &&
    typeof value.ias === "number" &&
    typeof value.importedAt === "string"
  );
}

type ReportLibraryRow = {
  id: string;
  company_name: string;
  ticker: string | null;
  market: string | null;
  industry: string | null;
  sector: string | null;
  cqs: number;
  ias: number;
  conclusion: InvestmentReport["conclusion"];
  qualitative_band: string;
  position_advice: string;
  valuation_view: string;
  as_of: string;
  imported_at: string;
  evidence_count: number;
  score_item_count: number;
  object_key: string;
  report_hash: string;
};

function rowToEntry(row: ReportLibraryRow): ReportLibraryEntry {
  const conclusion = normalizeEntryConclusion(row.conclusion, row.cqs, row.ias);
  return {
    id: row.id,
    companyName: row.company_name,
    ticker: row.ticker ?? undefined,
    market: row.market ?? undefined,
    industry: cleanIndustryLabel(row.industry),
    sector: cleanIndustryLabel(row.sector),
    cqs: row.cqs,
    ias: row.ias,
    conclusion,
    qualitativeBand: row.qualitative_band,
    positionAdvice: normalizeEntryPositionAdvice(conclusion, row.position_advice, row.cqs, row.ias),
    valuationView: normalizeEntryValuationView(row.valuation_view),
    asOf: row.as_of,
    importedAt: row.imported_at,
    evidenceCount: row.evidence_count,
    scoreItemCount: row.score_item_count,
  };
}

function hasDurableLibrary(env: Env): env is Env & { REPORT_LIBRARY_DB: D1Database; REPORT_LIBRARY_BUCKET: R2Bucket } {
  return Boolean(env.REPORT_LIBRARY_DB && env.REPORT_LIBRARY_BUCKET);
}

function boundedListLimit(value: string | null) {
  const parsed = value ? Number(value) : 20;
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

function boundedListOffset(value: string | null) {
  const parsed = value ? Number(value) : 0;
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function parseTickerCodes(value: string | null) {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => /^[A-Za-z0-9.]{1,16}$/.test(item)),
    ),
  ).slice(0, 200);
}

type MarketFilter = "a-share" | "us" | "hk";

function parseMarketFilter(value: string | null): MarketFilter | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["a", "cn", "ashare", "a-share", "a股"].includes(normalized)) return "a-share";
  if (["us", "usa", "us-stock", "美股"].includes(normalized)) return "us";
  if (["hk", "hkg", "hk-stock", "港股"].includes(normalized)) return "hk";
  return undefined;
}

function durableListFilters(industry?: string, market?: MarketFilter, tickers: string[] = []) {
  const clauses: string[] = [];
  const params: string[] = [];
  const industryCandidates = industry ? industryMembersForGroup(industry) : [];
  if (industryCandidates.length) {
    clauses.push(`${normalizedIndustrySql()} IN (${industryCandidates.map((_, index) => `?${params.length + index + 1}`).join(", ")})`);
    params.push(...industryCandidates);
  }
  const marketCandidates = market ? marketMembersForGroup(market) : [];
  if (marketCandidates.length) {
    clauses.push(`${normalizedMarketSql()} IN (${marketCandidates.map((_, index) => `?${params.length + index + 1}`).join(", ")})`);
    params.push(...marketCandidates);
  }
  if (tickers.length) {
    clauses.push(`ticker IN (${tickers.map((_, index) => `?${params.length + index + 1}`).join(", ")})`);
    params.push(...tickers);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function marketMembersForGroup(market: MarketFilter) {
  if (market === "a-share") {
    return ["A股", "ASHARE", "ASTOCK", "沪A", "深A", "SH-A", "SZ-A", "CHINEXT", "STAR MARKET", "创业板", "科创板", "上海证券交易所", "深圳证券交易所"];
  }
  if (market === "us") return ["美股", "US", "USA", "USSTOCK", "NASDAQ", "NYSE", "AMEX", "NMS", "NYQ", "NGM", "NCM", "美国市场"];
  return ["港股", "HK", "HKG", "HKEX", "HONG KONG", "香港"];
}

function entryMatchesMarket(entry: ReportLibraryEntry, market: MarketFilter) {
  const members = new Set(marketMembersForGroup(market));
  return members.has(normalizeMarketLabel(entry.market)) || members.has(normalizeMarketLabel(entry.sector)) || members.has(normalizeMarketLabel(entry.industry));
}

function listOrder(sort: string | null, direction: string | null) {
  const dir = direction === "asc" ? "ASC" : "DESC";
  if (sort === "cqs") return `cqs ${dir}, ias ${dir}, company_name ASC`;
  if (sort === "name") return `company_name ${dir}, ias DESC, cqs DESC`;
  if (sort === "code") return `ticker ${dir}, ias DESC, cqs DESC`;
  if (sort === "sector") return `COALESCE(industry, sector, '') ${dir}, ias DESC, cqs DESC`;
  return `ias ${dir}, cqs ${dir}, company_name ASC`;
}

function normalizedIndustrySql() {
  return `TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(industry, sector, ''), 'Ⅰ', ''), 'Ⅱ', ''), 'Ⅲ', ''), 'Ⅳ', ''), 'Ⅴ', ''), 'Ⅵ', ''), 'Ⅶ', ''), 'Ⅷ', ''), 'Ⅸ', ''), 'Ⅹ', ''))`;
}

function normalizedMarketSql() {
  return `UPPER(TRIM(COALESCE(market, '')))`;
}

function normalizeMarketLabel(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function bindD1<T extends D1PreparedStatement>(statement: T, values: unknown[]) {
  return values.length ? statement.bind(...values) : statement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
