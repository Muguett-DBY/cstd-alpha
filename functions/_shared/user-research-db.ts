import { readSessionCookie } from "./auth";
import type { CompanyCandidate } from "../../src/shared/report";
import type { TemplateAnalysisResult, WatchlistItem } from "../../src/shared/user-research";

const STALE_RUNNING_MS = 8 * 60 * 1000;

export type UserResearchEnv = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
};

export async function requireUserSession(request: Request, env: UserResearchEnv) {
  const session = await readSessionCookie(request.headers.get("cookie"), env);
  if (!session) return null;
  return session;
}

export async function ensureUserResearchSchema(db: D1Database) {
  await db.batch([
    db
      .prepare(
        `CREATE TABLE IF NOT EXISTS user_watchlist (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          user_key TEXT NOT NULL,
          company_name TEXT NOT NULL,
          ticker TEXT NOT NULL,
          market TEXT NOT NULL,
          exchange_name TEXT,
          listing_place TEXT,
          market_type TEXT,
          source TEXT,
          report_library_id TEXT,
          added_at TEXT NOT NULL,
          UNIQUE(user_key, ticker, market)
        )`,
      ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_watchlist_user ON user_watchlist (user_key, added_at DESC)`),
    db
      .prepare(
        `CREATE TABLE IF NOT EXISTS template_analysis (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          user_key TEXT NOT NULL,
          watchlist_id TEXT NOT NULL,
          template_id TEXT NOT NULL,
          template_title TEXT NOT NULL,
          company_name TEXT NOT NULL,
          ticker TEXT NOT NULL,
          market TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'completed',
          title TEXT NOT NULL,
          score REAL,
          verdict TEXT NOT NULL,
          summary TEXT NOT NULL,
          content_json TEXT NOT NULL,
          object_key TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          error_message TEXT,
          UNIQUE(user_key, watchlist_id, template_id)
        )`,
      ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_template_analysis_user ON template_analysis (user_key, updated_at DESC)`),
  ]);
  await Promise.all([
    ensureColumn(db, "user_watchlist", "user_id", "TEXT"),
    ensureColumn(db, "template_analysis", "user_id", "TEXT"),
    ensureColumn(db, "template_analysis", "status", "TEXT NOT NULL DEFAULT 'completed'"),
    ensureColumn(db, "template_analysis", "object_key", "TEXT"),
    ensureColumn(db, "template_analysis", "started_at", "TEXT"),
    ensureColumn(db, "template_analysis", "completed_at", "TEXT"),
    ensureColumn(db, "template_analysis", "error_message", "TEXT"),
  ]);
}

export function watchlistRowToItem(row: WatchlistRow): WatchlistItem {
  return {
    id: row.id,
    userId: row.user_id || row.user_key,
    company: {
      id: `watchlist:${row.market}:${row.ticker}`,
      name: row.company_name,
      code: row.ticker,
      exchange: row.exchange_name || row.market,
      listingPlace: row.listing_place || row.market,
      marketType: row.market_type || "Library",
      source: row.source === "yahoo" ? "yahoo" : "eastmoney",
    },
    reportLibraryId: row.report_library_id || undefined,
    addedAt: row.added_at,
  };
}

export function analysisRowToResult(row: AnalysisRow): TemplateAnalysisResult {
  const content = parseAnalysisContent(row.content_json);
  const status = templateStatus(row.status);
  const staleRunning = status === "running" && Date.now() - new Date(row.updated_at).getTime() > STALE_RUNNING_MS;
  const effectiveStatus = staleRunning ? "failed_retryable" : status;
  const staleMessage = "上一次生成连接超时或被中断，任务已可重试。";
  return {
    id: row.id,
    userId: row.user_id || row.user_key,
    watchlistId: row.watchlist_id,
    templateId: row.template_id,
    templateTitle: row.template_title,
    companyName: row.company_name,
    ticker: row.ticker,
    market: row.market,
    model: row.model,
    status: effectiveStatus,
    title: row.title,
    score: row.score ?? undefined,
    verdict: row.verdict,
    summary: staleRunning ? staleMessage : row.summary,
    objectKey: row.object_key || undefined,
    errorMessage: row.error_message || (staleRunning ? staleMessage : undefined),
    keyPoints: content.keyPoints,
    riskFlags: content.riskFlags,
    followUps: content.followUps,
    sections: content.sections,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
  };
}

export function normalizeCompany(value: unknown): CompanyCandidate | null {
  if (!isRecord(value)) return null;
  const name = stringValue(value.name);
  const code = stringValue(value.code);
  const listingPlace = stringValue(value.listingPlace) || stringValue(value.market);
  if (!name || !code || !listingPlace) return null;
  return {
    id: stringValue(value.id) || `manual:${listingPlace}:${code}`,
    name,
    code,
    exchange: stringValue(value.exchange) || listingPlace,
    listingPlace,
    marketType: stringValue(value.marketType) || "Library",
    quoteId: stringValue(value.quoteId) || undefined,
    source: candidateSource(value.source),
  };
}

export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export type WatchlistRow = {
  id: string;
  user_id?: string | null;
  user_key: string;
  company_name: string;
  ticker: string;
  market: string;
  exchange_name: string | null;
  listing_place: string | null;
  market_type: string | null;
  source: string | null;
  report_library_id: string | null;
  added_at: string;
};

export type AnalysisRow = {
  id: string;
  user_id?: string | null;
  user_key: string;
  watchlist_id: string;
  template_id: string;
  template_title: string;
  company_name: string;
  ticker: string;
  market: string;
  model: string;
  status?: string | null;
  title: string;
  score: number | null;
  verdict: string;
  summary: string;
  content_json: string;
  object_key?: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
};

function parseAnalysisContent(raw: string) {
  const fallback = { keyPoints: [], riskFlags: [], followUps: [], sections: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<Pick<TemplateAnalysisResult, "keyPoints" | "riskFlags" | "followUps" | "sections">>;
    return {
      keyPoints: stringArray(parsed.keyPoints),
      riskFlags: stringArray(parsed.riskFlags),
      followUps: stringArray(parsed.followUps),
      sections: Array.isArray(parsed.sections)
        ? parsed.sections
            .filter(isRecord)
            .map((item) => ({ heading: stringValue(item.heading) || "分析", body: stringValue(item.body) || "未提供。" }))
        : [],
    };
  } catch {
    return fallback;
  }
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function candidateSource(value: unknown): CompanyCandidate["source"] {
  return value === "yahoo" ? "yahoo" : "eastmoney";
}

function templateStatus(value: unknown) {
  return value === "pending" || value === "running" || value === "completed" || value === "failed_retryable" || value === "failed" ? value : "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function ensureColumn(db: D1Database, table: string, column: string, definition: string) {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch {
    // D1/SQLite throws when the column already exists; migrations also create these columns.
  }
}
