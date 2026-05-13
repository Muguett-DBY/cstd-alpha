import { verifySessionCookie } from "../_shared/auth";
import {
  buildReportLibraryEntry,
  parseReportLibraryReports,
  reportLibraryIdentity,
  validateLibraryReport,
  type ReportLibraryEntry,
} from "../../src/shared/report-library";
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
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim();
  if (id) {
    const record = (await readDurableReportRecord(env, id)) ?? (env.REPORT_CACHE ? await readKvReportRecord(env.REPORT_CACHE, id) : null);
    if (!record) return json({ error: "报告不存在。" }, 404);
    return json(record);
  }

  const entries = hasDurableLibrary(env) ? await listDurableReportEntries(env.REPORT_LIBRARY_DB) : env.REPORT_CACHE ? await listKvReportEntries(env.REPORT_CACHE) : [];
  return json({ entries });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
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

async function listDurableReportEntries(db: D1Database) {
  const result = await db
    .prepare(
      `SELECT
        id, company_name, ticker, market, industry, sector, cqs, ias, conclusion,
        qualitative_band, position_advice, valuation_view, as_of, imported_at,
        evidence_count, score_item_count, object_key, report_hash
      FROM report_library
      ORDER BY ias DESC, cqs DESC, company_name ASC`,
    )
    .all<ReportLibraryRow>();
  return (result.results ?? []).map(rowToEntry);
}

async function listKvReportEntries(cache: KVNamespace) {
  const entries: ReportLibraryEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await cache.list({ prefix: REPORT_PREFIX, cursor });
    const pageEntries = await Promise.all(
      page.keys.map(async (key) => {
        const value = await cache.get<ReportLibraryRecord>(key.name, "json");
        return isRecord(value) && isValidEntry(value.entry) ? value.entry : null;
      }),
    );
    entries.push(...pageEntries.filter((entry): entry is ReportLibraryEntry => entry !== null));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return entries.sort((left, right) => {
    if (right.ias !== left.ias) return right.ias - left.ias;
    if (right.cqs !== left.cqs) return right.cqs - left.cqs;
    return left.companyName.localeCompare(right.companyName);
  });
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
  return {
    id: row.id,
    companyName: row.company_name,
    ticker: row.ticker ?? undefined,
    market: row.market ?? undefined,
    industry: row.industry ?? undefined,
    sector: row.sector ?? undefined,
    cqs: row.cqs,
    ias: row.ias,
    conclusion: row.conclusion,
    qualitativeBand: row.qualitative_band,
    positionAdvice: row.position_advice,
    valuationView: row.valuation_view,
    asOf: row.as_of,
    importedAt: row.imported_at,
    evidenceCount: row.evidence_count,
    scoreItemCount: row.score_item_count,
  };
}

function hasDurableLibrary(env: Env): env is Env & { REPORT_LIBRARY_DB: D1Database; REPORT_LIBRARY_BUCKET: R2Bucket } {
  return Boolean(env.REPORT_LIBRARY_DB && env.REPORT_LIBRARY_BUCKET);
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
