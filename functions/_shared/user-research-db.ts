import { readSessionCookie } from "./auth";
import type { CompanyCandidate } from "../../src/shared/report";
import type { TemplateAnalysisResult, WatchlistItem } from "../../src/shared/user-research";

export type UserResearchEnv = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
};

export async function requireUserSession(request: Request, env: UserResearchEnv) {
  const session = await readSessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
  if (!session) return null;
  return session;
}

export async function ensureUserResearchSchema(db: D1Database) {
  await db.batch([
    db
      .prepare(
        `CREATE TABLE IF NOT EXISTS user_watchlist (
          id TEXT PRIMARY KEY,
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
          user_key TEXT NOT NULL,
          watchlist_id TEXT NOT NULL,
          template_id TEXT NOT NULL,
          template_title TEXT NOT NULL,
          company_name TEXT NOT NULL,
          ticker TEXT NOT NULL,
          market TEXT NOT NULL,
          model TEXT NOT NULL,
          title TEXT NOT NULL,
          score REAL,
          verdict TEXT NOT NULL,
          summary TEXT NOT NULL,
          content_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(user_key, watchlist_id, template_id)
        )`,
      ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_template_analysis_user ON template_analysis (user_key, updated_at DESC)`),
  ]);
}

export function watchlistRowToItem(row: WatchlistRow): WatchlistItem {
  return {
    id: row.id,
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
  return {
    id: row.id,
    watchlistId: row.watchlist_id,
    templateId: row.template_id,
    templateTitle: row.template_title,
    companyName: row.company_name,
    ticker: row.ticker,
    market: row.market,
    model: row.model,
    title: row.title,
    score: row.score ?? undefined,
    verdict: row.verdict,
    summary: row.summary,
    keyPoints: content.keyPoints,
    riskFlags: content.riskFlags,
    followUps: content.followUps,
    sections: content.sections,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  user_key: string;
  watchlist_id: string;
  template_id: string;
  template_title: string;
  company_name: string;
  ticker: string;
  market: string;
  model: string;
  title: string;
  score: number | null;
  verdict: string;
  summary: string;
  content_json: string;
  created_at: string;
  updated_at: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
