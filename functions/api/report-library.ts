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
};

type ReportLibraryRecord = {
  entry: ReportLibraryEntry;
  report: InvestmentReport;
};

const LIBRARY_VERSION = "v1";
const INDEX_PREFIX = `report-library:${LIBRARY_VERSION}:index:`;
const REPORT_PREFIX = `report-library:${LIBRARY_VERSION}:report:`;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_CACHE) return json({ error: "REPORT_CACHE is not configured." }, 500);

  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim();
  if (id) {
    const record = await readReportRecord(env.REPORT_CACHE, id);
    if (!record) return json({ error: "报告不存在。" }, 404);
    return json(record);
  }

  const entries = await listReportEntries(env.REPORT_CACHE);
  return json({ entries });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_CACHE) return json({ error: "REPORT_CACHE is not configured." }, 500);

  try {
    const body = await request.json();
    const reports = parseReportLibraryReports(body);
    const importedAt = new Date().toISOString();
    const entries = await Promise.all(reports.map((report) => writeReportRecord(env.REPORT_CACHE!, report, importedAt)));
    return json({ imported: entries });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "报告导入失败。" }, 400);
  }
};

async function writeReportRecord(cache: KVNamespace, rawReport: InvestmentReport, importedAt: string) {
  const report = validateLibraryReport(rawReport);
  const id = await reportLibraryId(report);
  const entry = buildReportLibraryEntry(report, id, importedAt);
  const record: ReportLibraryRecord = { entry, report };
  await Promise.all([cache.put(`${REPORT_PREFIX}${id}`, JSON.stringify(record)), cache.put(`${INDEX_PREFIX}${id}`, JSON.stringify(entry))]);
  return entry;
}

async function readReportRecord(cache: KVNamespace, id: string): Promise<ReportLibraryRecord | null> {
  const record = await cache.get<ReportLibraryRecord>(`${REPORT_PREFIX}${id}`, "json");
  if (!isRecord(record) || !isRecord(record.entry) || !isRecord(record.report)) return null;
  const report = validateLibraryReport(record.report);
  return {
    entry: record.entry as ReportLibraryEntry,
    report,
  };
}

async function listReportEntries(cache: KVNamespace) {
  const entries: ReportLibraryEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await cache.list({ prefix: INDEX_PREFIX, cursor });
    const pageEntries = await Promise.all(
      page.keys.map(async (key) => {
        const value = await cache.get<ReportLibraryEntry>(key.name, "json");
        return isValidEntry(value) ? value : null;
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
