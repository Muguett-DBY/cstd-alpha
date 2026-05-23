import { readSessionCookie } from "./auth";
import type { CompanyCandidate } from "../../src/shared/report";
import { RESEARCH_TEMPLATES, type ResearchTemplate, type TemplateAnalysisResult, type WatchlistItem } from "../../src/shared/user-research";

const STALE_RUNNING_MS = 20 * 60 * 1000;

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
    db
      .prepare(
        `CREATE TABLE IF NOT EXISTS user_research_templates (
          id TEXT NOT NULL,
          user_id TEXT,
          user_key TEXT NOT NULL,
          title TEXT NOT NULL,
          short_title TEXT NOT NULL,
          focus TEXT NOT NULL,
          prompt TEXT NOT NULL,
          full_prompt TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_system INTEGER NOT NULL DEFAULT 0,
          deleted_at TEXT,
          default_title TEXT NOT NULL,
          default_short_title TEXT NOT NULL,
          default_focus TEXT NOT NULL,
          default_prompt TEXT NOT NULL,
          default_full_prompt TEXT NOT NULL,
          default_enabled INTEGER NOT NULL DEFAULT 1,
          default_sort_order INTEGER NOT NULL DEFAULT 0,
          default_is_system INTEGER NOT NULL DEFAULT 0,
          default_deleted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_key, id)
        )`,
      ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_research_templates_user ON user_research_templates (user_key, sort_order ASC)`),
  ]);
  await Promise.all([
    ensureColumn(db, "user_watchlist", "user_id", "TEXT"),
    ensureColumn(db, "template_analysis", "user_id", "TEXT"),
    ensureColumn(db, "template_analysis", "status", "TEXT NOT NULL DEFAULT 'completed'"),
    ensureColumn(db, "template_analysis", "object_key", "TEXT"),
    ensureColumn(db, "template_analysis", "started_at", "TEXT"),
    ensureColumn(db, "template_analysis", "completed_at", "TEXT"),
    ensureColumn(db, "template_analysis", "error_message", "TEXT"),
    ensureColumn(db, "template_analysis", "template_hash", "TEXT"),
    ensureColumn(db, "template_analysis", "evidence_hash", "TEXT"),
    ensureColumn(db, "template_analysis", "template_snapshot_json", "TEXT"),
  ]);
}

export async function readUserResearchTemplates(db: D1Database, userId: string, includeDeleted = false) {
  await ensureDefaultResearchTemplates(db, userId);
  const result = await db
    .prepare(
      `SELECT id, user_id, user_key, title, short_title, focus, prompt, full_prompt, enabled, sort_order, is_system, deleted_at, created_at, updated_at
       FROM user_research_templates
       WHERE user_key = ?1 ${includeDeleted ? "" : "AND deleted_at IS NULL"}
       ORDER BY sort_order ASC, title ASC`,
    )
    .bind(userId)
    .all<ResearchTemplateRow>();
  return (result.results ?? []).map(templateRowToTemplate);
}

export async function saveUserResearchTemplates(db: D1Database, userId: string, templates: ResearchTemplate[]) {
  await ensureDefaultResearchTemplates(db, userId);
  const normalized = normalizeTemplateInputs(templates);
  const now = new Date().toISOString();
  for (const [index, template] of normalized.entries()) {
    const existing = await readTemplateRow(db, userId, template.id);
    const sortOrder = template.sortOrder ?? index + 1;
    await db
      .prepare(
        `INSERT INTO user_research_templates (
          id, user_id, user_key, title, short_title, focus, prompt, full_prompt, enabled, sort_order, is_system, deleted_at,
          default_title, default_short_title, default_focus, default_prompt, default_full_prompt, default_enabled, default_sort_order, default_is_system, default_deleted_at,
          created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
        ON CONFLICT(user_key, id) DO UPDATE SET
          user_id = excluded.user_id,
          title = excluded.title,
          short_title = excluded.short_title,
          focus = excluded.focus,
          prompt = excluded.prompt,
          full_prompt = excluded.full_prompt,
          enabled = excluded.enabled,
          sort_order = excluded.sort_order,
          is_system = excluded.is_system,
          deleted_at = NULL,
          updated_at = excluded.updated_at`,
      )
      .bind(
        template.id,
        userId,
        userId,
        template.title,
        template.shortTitle,
        template.focus,
        template.prompt,
        template.fullPrompt,
        template.enabled === false ? 0 : 1,
        sortOrder,
        template.isSystem ? 1 : 0,
        existing?.default_title ?? template.title,
        existing?.default_short_title ?? template.shortTitle,
        existing?.default_focus ?? template.focus,
        existing?.default_prompt ?? template.prompt,
        existing?.default_full_prompt ?? template.fullPrompt,
        existing?.default_enabled ?? (template.enabled === false ? 0 : 1),
        existing?.default_sort_order ?? sortOrder,
        existing?.default_is_system ?? (template.isSystem ? 1 : 0),
        existing?.default_deleted_at ?? null,
        existing?.created_at ?? now,
        now,
      )
      .run();
  }
  const keepIds = new Set(normalized.map((template) => template.id));
  const existing = await readAllTemplateRows(db, userId);
  await Promise.all(
    existing
      .filter((row) => !keepIds.has(row.id) && !row.deleted_at)
      .map((row) => db.prepare(`UPDATE user_research_templates SET deleted_at = ?1, updated_at = ?2 WHERE user_key = ?3 AND id = ?4`).bind(now, now, userId, row.id).run()),
  );
  return readUserResearchTemplates(db, userId);
}

export async function saveCurrentTemplatesAsDefault(db: D1Database, userId: string) {
  await ensureDefaultResearchTemplates(db, userId);
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE user_research_templates
       SET default_title = title,
           default_short_title = short_title,
           default_focus = focus,
           default_prompt = prompt,
           default_full_prompt = full_prompt,
           default_enabled = enabled,
           default_sort_order = sort_order,
           default_is_system = is_system,
           default_deleted_at = deleted_at,
           updated_at = ?1
       WHERE user_key = ?2`,
    )
    .bind(now, userId)
    .run();
  return readUserResearchTemplates(db, userId);
}

export async function resetTemplatesToDefault(db: D1Database, userId: string) {
  await ensureDefaultResearchTemplates(db, userId);
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE user_research_templates
       SET title = default_title,
           short_title = default_short_title,
           focus = default_focus,
           prompt = default_prompt,
           full_prompt = default_full_prompt,
           enabled = default_enabled,
           sort_order = default_sort_order,
           is_system = default_is_system,
           deleted_at = default_deleted_at,
           updated_at = ?1
       WHERE user_key = ?2`,
    )
    .bind(now, userId)
    .run();
  return readUserResearchTemplates(db, userId);
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
    templateHash: row.template_hash || undefined,
    evidenceHash: row.evidence_hash || undefined,
    templateSnapshot: parseTemplateSnapshot(row.template_snapshot_json),
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
  template_hash?: string | null;
  evidence_hash?: string | null;
  template_snapshot_json?: string | null;
};

export type ResearchTemplateRow = {
  id: string;
  user_id?: string | null;
  user_key: string;
  title: string;
  short_title: string;
  focus: string;
  prompt: string;
  full_prompt: string;
  enabled: number;
  sort_order: number;
  is_system: number;
  deleted_at?: string | null;
  default_title?: string | null;
  default_short_title?: string | null;
  default_focus?: string | null;
  default_prompt?: string | null;
  default_full_prompt?: string | null;
  default_enabled?: number | null;
  default_sort_order?: number | null;
  default_is_system?: number | null;
  default_deleted_at?: string | null;
  created_at: string;
  updated_at: string;
};

async function ensureDefaultResearchTemplates(db: D1Database, userId: string) {
  const existing = await readAllTemplateRows(db, userId);
  const existingIds = new Set(existing.map((row) => row.id));
  const now = new Date().toISOString();
  for (const [index, template] of RESEARCH_TEMPLATES.entries()) {
    if (existingIds.has(template.id)) continue;
    const sortOrder = index + 1;
    await db
      .prepare(
        `INSERT INTO user_research_templates (
          id, user_id, user_key, title, short_title, focus, prompt, full_prompt, enabled, sort_order, is_system, deleted_at,
          default_title, default_short_title, default_focus, default_prompt, default_full_prompt, default_enabled, default_sort_order, default_is_system, default_deleted_at,
          created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, 1, NULL, ?10, ?11, ?12, ?13, ?14, 1, ?15, 1, NULL, ?16, ?17)`,
      )
      .bind(
        template.id,
        userId,
        userId,
        template.title,
        template.shortTitle,
        template.focus,
        template.prompt,
        template.fullPrompt,
        sortOrder,
        template.title,
        template.shortTitle,
        template.focus,
        template.prompt,
        template.fullPrompt,
        sortOrder,
        now,
        now,
      )
      .run();
  }
}

async function readTemplateRow(db: D1Database, userId: string, id: string) {
  return db
    .prepare(
      `SELECT id, user_id, user_key, title, short_title, focus, prompt, full_prompt, enabled, sort_order, is_system, deleted_at,
              default_title, default_short_title, default_focus, default_prompt, default_full_prompt, default_enabled, default_sort_order, default_is_system, default_deleted_at,
              created_at, updated_at
       FROM user_research_templates
       WHERE user_key = ?1 AND id = ?2`,
    )
    .bind(userId, id)
    .first<ResearchTemplateRow>();
}

async function readAllTemplateRows(db: D1Database, userId: string) {
  const result = await db
    .prepare(
      `SELECT id, user_id, user_key, title, short_title, focus, prompt, full_prompt, enabled, sort_order, is_system, deleted_at,
              default_title, default_short_title, default_focus, default_prompt, default_full_prompt, default_enabled, default_sort_order, default_is_system, default_deleted_at,
              created_at, updated_at
       FROM user_research_templates
       WHERE user_key = ?1`,
    )
    .bind(userId)
    .all<ResearchTemplateRow>();
  return result.results ?? [];
}

function templateRowToTemplate(row: ResearchTemplateRow): ResearchTemplate {
  return {
    id: row.id,
    title: row.title,
    shortTitle: row.short_title,
    focus: row.focus,
    prompt: row.prompt,
    fullPrompt: row.full_prompt,
    enabled: row.enabled !== 0,
    sortOrder: row.sort_order,
    isSystem: row.is_system === 1,
    updatedAt: row.updated_at,
  };
}

function normalizeTemplateInputs(templates: ResearchTemplate[]) {
  return templates.map((template, index) => normalizeTemplateInput(template, index)).filter((template): template is ResearchTemplate => Boolean(template));
}

function normalizeTemplateInput(template: ResearchTemplate, index: number): ResearchTemplate | null {
  if (!isRecord(template)) return null;
  const id = normalizeTemplateId(template.id) || `custom-${Date.now()}-${index + 1}`;
  const title = stringValue(template.title);
  const shortTitle = stringValue(template.shortTitle);
  const focus = stringValue(template.focus);
  const prompt = stringValue(template.prompt);
  const fullPrompt = stringValue(template.fullPrompt);
  if (!title || !shortTitle || !focus || !prompt || !fullPrompt) return null;
  return {
    id,
    title: title.slice(0, 120),
    shortTitle: shortTitle.slice(0, 32),
    focus: focus.slice(0, 500),
    prompt: prompt.slice(0, 2000),
    fullPrompt: fullPrompt.slice(0, 60_000),
    enabled: template.enabled !== false,
    sortOrder: Number.isFinite(template.sortOrder) ? Math.max(0, Math.floor(Number(template.sortOrder))) : index + 1,
    isSystem: template.isSystem === true || RESEARCH_TEMPLATES.some((item) => item.id === id),
  };
}

function normalizeTemplateId(value: unknown) {
  const id = stringValue(value).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,100}$/.test(id) ? id : "";
}

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

function parseTemplateSnapshot(raw: string | null | undefined) {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ResearchTemplate;
    return normalizeTemplateInput(parsed, parsed.sortOrder ?? 0) ?? undefined;
  } catch {
    return undefined;
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
