import type { ResearchCatalyst, ResearchCatalystDraft, ResearchCatalystStatus, ResearchEntityType, ResearchStage, ResearchThesisVersion, ResearchWorkbenchItem } from "../../src/shared/research-workbench";
import { RESEARCH_CATALYST_STATUSES, RESEARCH_STAGES } from "../../src/shared/research-workbench";
import type { CompanyArchetype, ValuationMethod, ValuationResult, ValuationRunStatus } from "../../src/shared/valuation";

export type ResearchNotification = {
  id: string;
  itemId?: string;
  type: string;
  title: string;
  body: string;
  severity: string;
  status: string;
  createdAt: string;
};

export type ValuationRunRow = {
  id: string;
  user_key: string;
  research_item_id: string | null;
  entity_type: string;
  entity_id: string;
  title: string;
  status: ValuationRunStatus;
  archetype: CompanyArchetype;
  method: ValuationMethod;
  currency: string;
  input_hash: string | null;
  evidence_hash: string | null;
  assumptions_json: string;
  result_json: string | null;
  object_key: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type ResearchItemRow = {
  id: string;
  user_key: string;
  entity_type: string;
  entity_id: string;
  title: string;
  subtitle: string | null;
  stage: string;
  status: string;
  source: string;
  evidence_hash: string | null;
  current_thesis_version_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type ResearchNotificationRow = {
  id: string;
  item_id: string | null;
  type: string;
  title: string;
  body: string;
  severity: string;
  status: string;
  created_at: string;
};

type ResearchThesisRow = {
  id: string;
  user_key: string;
  item_id: string;
  version: number;
  thesis_markdown: string;
  core_citations_json: string;
  counter_evidence_json: string;
  evidence_hash: string | null;
  created_by: string;
  created_at: string;
};

type ResearchCatalystRow = {
  id: string;
  item_id: string;
  title: string;
  description: string | null;
  due_at: string | null;
  status: string;
  evidence_refs_json: string;
  created_at: string;
  updated_at: string;
};

export async function ensureResearchWorkbenchSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS research_items (
      id TEXT PRIMARY KEY, user_key TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT,
      stage TEXT NOT NULL DEFAULT 'screening', status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'manual',
      evidence_hash TEXT, current_thesis_version_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_key, entity_type, entity_id)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_research_items_user_stage ON research_items (user_key, stage, updated_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_research_items_entity ON research_items (entity_type, entity_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_research_items_user_stage_order ON research_items (user_key, stage, sort_order ASC, updated_at DESC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS research_thesis_versions (
      id TEXT PRIMARY KEY, user_key TEXT NOT NULL, item_id TEXT NOT NULL, version INTEGER NOT NULL, thesis_markdown TEXT NOT NULL,
      core_citations_json TEXT NOT NULL DEFAULT '[]', counter_evidence_json TEXT NOT NULL DEFAULT '[]', evidence_hash TEXT, created_by TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_research_thesis_item_version ON research_thesis_versions (item_id, version)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS research_catalysts (
      id TEXT PRIMARY KEY, user_key TEXT NOT NULL, item_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, due_at TEXT,
      status TEXT NOT NULL DEFAULT 'open', evidence_refs_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_research_catalysts_item ON research_catalysts (item_id, status, due_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS research_stage_suggestions (
      id TEXT PRIMARY KEY, user_key TEXT NOT NULL, item_id TEXT NOT NULL, from_stage TEXT NOT NULL, to_stage TEXT NOT NULL, reason TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, resolved_at TEXT
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_research_stage_suggestions_pending ON research_stage_suggestions (user_key, status, created_at DESC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS research_notifications (
      id TEXT PRIMARY KEY, user_key TEXT NOT NULL, item_id TEXT, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info', status TEXT NOT NULL DEFAULT 'unread', evidence_refs_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, read_at TEXT
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_research_notifications_user ON research_notifications (user_key, status, created_at DESC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS valuation_runs (
      id TEXT PRIMARY KEY, user_key TEXT NOT NULL, research_item_id TEXT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', archetype TEXT NOT NULL, method TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'CNY',
      input_hash TEXT, evidence_hash TEXT, assumptions_json TEXT NOT NULL DEFAULT '[]', result_json TEXT, object_key TEXT, error_message TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_valuation_runs_user ON valuation_runs (user_key, updated_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_valuation_runs_entity ON valuation_runs (entity_type, entity_id, updated_at DESC)`),
  ]);
}

export async function upsertResearchItem(db: D1Database, input: {
  userKey: string;
  entityType: ResearchEntityType;
  entityId: string;
  title: string;
  subtitle?: string;
  source?: string;
  evidenceHash?: string;
  stage?: ResearchStage;
}) {
  await ensureResearchWorkbenchSchema(db);
  const now = new Date().toISOString();
  const id = await sha256(`${input.userKey}:${input.entityType}:${input.entityId}`);
  const stage = normalizeResearchStage(input.stage) ?? "screening";
  await db.prepare(
    `INSERT INTO research_items (
       id, user_key, entity_type, entity_id, title, subtitle, stage, source, evidence_hash, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
     ON CONFLICT(user_key, entity_type, entity_id) DO UPDATE SET
       title = excluded.title,
       subtitle = excluded.subtitle,
       source = excluded.source,
       evidence_hash = COALESCE(excluded.evidence_hash, research_items.evidence_hash),
       updated_at = excluded.updated_at`,
  ).bind(id, input.userKey, input.entityType, input.entityId, input.title, input.subtitle ?? null, stage, input.source ?? "manual", input.evidenceHash ?? null, now).run();
  const item = await readResearchItemById(db, input.userKey, id);
  if (!item) throw new Error("research item upsert failed");
  return item;
}

export async function listResearchItems(db: D1Database, userKey: string) {
  await ensureResearchWorkbenchSchema(db);
  const result = await db.prepare(
    `SELECT id, user_key, entity_type, entity_id, title, subtitle, stage, status, source, evidence_hash, current_thesis_version_id, created_at, updated_at, archived_at
     FROM research_items WHERE user_key = ?1 ORDER BY sort_order ASC, updated_at DESC`,
  ).bind(userKey).all<ResearchItemRow>();
  return (result.results ?? []).map(researchItemRowToItem);
}

export async function readResearchItemById(db: D1Database, userKey: string, id: string) {
  await ensureResearchWorkbenchSchema(db);
  const row = await db.prepare(
    `SELECT id, user_key, entity_type, entity_id, title, subtitle, stage, status, source, evidence_hash, current_thesis_version_id, created_at, updated_at, archived_at
     FROM research_items WHERE user_key = ?1 AND id = ?2`,
  ).bind(userKey, id).first<ResearchItemRow>();
  return row ? researchItemRowToItem(row) : null;
}

export async function confirmResearchStage(db: D1Database, userKey: string, id: string, stage: ResearchStage, sortOrder?: number) {
  await ensureResearchWorkbenchSchema(db);
  const normalized = normalizeResearchStage(stage);
  if (!normalized) throw new Error("invalid research stage");
  const now = new Date().toISOString();
  if (typeof sortOrder === "number") {
    await db.prepare(`UPDATE research_items SET stage = ?3, sort_order = ?4, updated_at = ?5 WHERE user_key = ?1 AND id = ?2`).bind(userKey, id, normalized, sortOrder, now).run();
  } else {
    await db.prepare(`UPDATE research_items SET stage = ?3, updated_at = ?4 WHERE user_key = ?1 AND id = ?2`).bind(userKey, id, normalized, now).run();
  }
  return readResearchItemById(db, userKey, id);
}

export async function reorderResearchItems(db: D1Database, userKey: string, updates: Array<{ id: string; stage: string; sortOrder: number }>) {
  await ensureResearchWorkbenchSchema(db);
  const now = new Date().toISOString();
  const statements = updates.map((u) =>
    db.prepare(`UPDATE research_items SET stage = ?3, sort_order = ?4, updated_at = ?5 WHERE user_key = ?1 AND id = ?2`).bind(userKey, u.id, u.stage, u.sortOrder, now),
  );
  await db.batch(statements);
}

export async function deleteResearchItems(db: D1Database, userKey: string, ids: string[]) {
  await ensureResearchWorkbenchSchema(db);
  if (!ids.length) return;
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
  await db.prepare(`DELETE FROM research_items WHERE user_key = ?1 AND id IN (${placeholders})`).bind(userKey, ...ids).run();
}

export async function listResearchThesisVersions(db: D1Database, userKey: string, itemId: string, limit = 20) {
  await ensureResearchWorkbenchSchema(db);
  const result = await db.prepare(
    `SELECT id, user_key, item_id, version, thesis_markdown, core_citations_json, counter_evidence_json, evidence_hash, created_by, created_at
     FROM research_thesis_versions WHERE user_key = ?1 AND item_id = ?2 ORDER BY version DESC LIMIT ?3`,
  ).bind(userKey, itemId, limit).all<ResearchThesisRow>();
  return (result.results ?? []).map(researchThesisRowToVersion);
}

export async function readCurrentResearchThesis(db: D1Database, userKey: string, itemId: string) {
  await ensureResearchWorkbenchSchema(db);
  const row = await db.prepare(
    `SELECT tv.id, tv.user_key, tv.item_id, tv.version, tv.thesis_markdown, tv.core_citations_json, tv.counter_evidence_json,
            tv.evidence_hash, tv.created_by, tv.created_at
     FROM research_items ri
     JOIN research_thesis_versions tv ON tv.id = ri.current_thesis_version_id
     WHERE ri.user_key = ?1 AND ri.id = ?2`,
  ).bind(userKey, itemId).first<ResearchThesisRow>();
  return row ? researchThesisRowToVersion(row) : null;
}

export async function createResearchThesisVersion(db: D1Database, input: {
  userKey: string;
  itemId: string;
  thesisMarkdown: string;
  coreCitations: string[];
  counterEvidence: string[];
  evidenceHash?: string;
  createdBy?: string;
}) {
  await ensureResearchWorkbenchSchema(db);
  const now = new Date().toISOString();
  let id = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    id = crypto.randomUUID();
    try {
      await db.batch([
        db.prepare(
          `INSERT INTO research_thesis_versions (
            id, user_key, item_id, version, thesis_markdown, core_citations_json, counter_evidence_json, evidence_hash, created_by, created_at
          )
          SELECT ?1, ?2, ?3, COALESCE(MAX(version), 0) + 1, ?4, ?5, ?6, ?7, ?8, ?9
          FROM research_thesis_versions WHERE item_id = ?3`,
        ).bind(
          id,
          input.userKey,
          input.itemId,
          input.thesisMarkdown,
          JSON.stringify(input.coreCitations),
          JSON.stringify(input.counterEvidence),
          input.evidenceHash ?? null,
          input.createdBy ?? "ai",
          now,
        ),
        db.prepare(
          `UPDATE research_items SET current_thesis_version_id = ?3, evidence_hash = COALESCE(?4, evidence_hash), updated_at = ?5
           WHERE user_key = ?1 AND id = ?2`,
        ).bind(input.userKey, input.itemId, id, input.evidenceHash ?? null, now),
      ]);
      break;
    } catch (error) {
      if (attempt === 2 || !isThesisVersionConflict(error)) throw error;
    }
  }
  const row = await db.prepare(
    `SELECT id, user_key, item_id, version, thesis_markdown, core_citations_json, counter_evidence_json, evidence_hash, created_by, created_at
     FROM research_thesis_versions WHERE user_key = ?1 AND id = ?2`,
  ).bind(input.userKey, id).first<ResearchThesisRow>();
  if (!row) throw new Error("research thesis create failed");
  return researchThesisRowToVersion(row);
}

export async function listResearchNotifications(db: D1Database, userKey: string, limit = 20) {
  await ensureResearchWorkbenchSchema(db);
  const result = await db.prepare(
    `SELECT id, item_id, type, title, body, severity, status, created_at
     FROM research_notifications WHERE user_key = ?1 ORDER BY created_at DESC LIMIT ?2`,
  ).bind(userKey, limit).all<ResearchNotificationRow>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    itemId: row.item_id ?? undefined,
    type: row.type,
    title: row.title,
    body: row.body,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export async function listResearchCatalysts(db: D1Database, userKey: string, itemId: string) {
  await ensureResearchWorkbenchSchema(db);
  const result = await db.prepare(
    `SELECT id, item_id, title, description, due_at, status, evidence_refs_json, created_at, updated_at
     FROM research_catalysts
     WHERE user_key = ?1 AND item_id = ?2
     ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'watching' THEN 1 ELSE 2 END, COALESCE(due_at, '9999-12-31'), updated_at DESC`,
  ).bind(userKey, itemId).all<ResearchCatalystRow>();
  return (result.results ?? []).map(researchCatalystRowToCatalyst);
}

export async function upsertResearchCatalystDrafts(db: D1Database, input: {
  userKey: string;
  itemId: string;
  drafts: ResearchCatalystDraft[];
}) {
  await ensureResearchWorkbenchSchema(db);
  const now = new Date().toISOString();
  const uniqueDrafts = dedupeCatalystDrafts(input.drafts).slice(0, 12);
  if (!uniqueDrafts.length) return listResearchCatalysts(db, input.userKey, input.itemId);
  const statements = await Promise.all(uniqueDrafts.map(async (draft) => {
    const id = await sha256(`${input.userKey}:${input.itemId}:${draft.title}`);
    return db.prepare(
      `INSERT INTO research_catalysts (
        id, user_key, item_id, title, description, status, evidence_refs_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7, ?7)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        evidence_refs_json = excluded.evidence_refs_json,
        updated_at = excluded.updated_at`,
    ).bind(id, input.userKey, input.itemId, draft.title, draft.description ?? null, JSON.stringify(draft.evidenceRefs), now);
  }));
  await db.batch(statements);
  return listResearchCatalysts(db, input.userKey, input.itemId);
}

export async function updateResearchCatalystStatus(db: D1Database, input: {
  userKey: string;
  itemId: string;
  catalystId: string;
  status: string;
}) {
  const status = normalizeResearchCatalystStatus(input.status);
  if (!status) throw new Error("invalid research catalyst status");
  await ensureResearchWorkbenchSchema(db);
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE research_catalysts
     SET status = ?4, updated_at = ?5
     WHERE user_key = ?1 AND item_id = ?2 AND id = ?3`,
  ).bind(input.userKey, input.itemId, input.catalystId, status, now).run();
  const row = await db.prepare(
    `SELECT id, item_id, title, description, due_at, status, evidence_refs_json, created_at, updated_at
     FROM research_catalysts
     WHERE user_key = ?1 AND item_id = ?2 AND id = ?3`,
  ).bind(input.userKey, input.itemId, input.catalystId).first<ResearchCatalystRow>();
  return row ? researchCatalystRowToCatalyst(row) : null;
}

export async function createValuationRun(db: D1Database, input: {
  userKey: string;
  researchItemId?: string;
  entityType: ResearchEntityType;
  entityId: string;
  title: string;
  archetype: CompanyArchetype;
  method: ValuationMethod;
  currency?: string;
  inputHash?: string;
  evidenceHash?: string;
}) {
  await ensureResearchWorkbenchSchema(db);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO valuation_runs (
      id, user_key, research_item_id, entity_type, entity_id, title, status, archetype, method, currency, input_hash, evidence_hash, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
  ).bind(id, input.userKey, input.researchItemId ?? null, input.entityType, input.entityId, input.title, input.archetype, input.method, input.currency ?? "CNY", input.inputHash ?? null, input.evidenceHash ?? null, now).run();
  const run = await readValuationRun(db, input.userKey, id);
  if (!run) throw new Error("valuation run create failed");
  return run;
}

export async function readValuationRun(db: D1Database, userKey: string, id: string) {
  await ensureResearchWorkbenchSchema(db);
  return db.prepare(
    `SELECT id, user_key, research_item_id, entity_type, entity_id, title, status, archetype, method, currency, input_hash, evidence_hash, assumptions_json,
            result_json, object_key, error_message, created_at, updated_at, started_at, completed_at
     FROM valuation_runs WHERE user_key = ?1 AND id = ?2`,
  ).bind(userKey, id).first<ValuationRunRow>();
}

export async function readValuationRunForWorker(db: D1Database, id: string) {
  await ensureResearchWorkbenchSchema(db);
  return db.prepare(
    `SELECT id, user_key, research_item_id, entity_type, entity_id, title, status, archetype, method, currency, input_hash, evidence_hash, assumptions_json,
            result_json, object_key, error_message, created_at, updated_at, started_at, completed_at
     FROM valuation_runs WHERE id = ?1`,
  ).bind(id).first<ValuationRunRow>();
}

export async function listValuationRuns(db: D1Database, userKey: string, limit = 20) {
  await ensureResearchWorkbenchSchema(db);
  const result = await db.prepare(
    `SELECT id, user_key, research_item_id, entity_type, entity_id, title, status, archetype, method, currency, input_hash, evidence_hash, assumptions_json,
            result_json, object_key, error_message, created_at, updated_at, started_at, completed_at
     FROM valuation_runs WHERE user_key = ?1 ORDER BY updated_at DESC LIMIT ?2`,
  ).bind(userKey, limit).all<ValuationRunRow>();
  return result.results ?? [];
}

export async function claimValuationRun(db: D1Database, id: string) {
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE valuation_runs
     SET status = 'running', started_at = COALESCE(started_at, ?2), updated_at = ?2
     WHERE id = ?1 AND status IN ('queued', 'failed')`,
  ).bind(id, now).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function completeValuationRun(db: D1Database, input: { id: string; result: ValuationResult; objectKey?: string }) {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE valuation_runs SET status = 'completed', result_json = ?2, assumptions_json = ?3, object_key = ?4, updated_at = ?5, completed_at = ?5 WHERE id = ?1`,
  ).bind(input.id, JSON.stringify(input.result), JSON.stringify(input.result.assumptions), input.objectKey ?? null, now).run();
}

export async function failValuationRun(db: D1Database, id: string, error: unknown) {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE valuation_runs SET status = 'failed', error_message = ?2, updated_at = ?3, completed_at = ?3 WHERE id = ?1`).bind(id, safeError(error), now).run();
}

export function valuationRunToSummary(row: ValuationRunRow) {
  return {
    id: row.id,
    researchItemId: row.research_item_id ?? undefined,
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title,
    status: row.status,
    method: row.method,
    archetype: row.archetype,
    currency: row.currency,
    result: parseJson<ValuationResult>(row.result_json),
    objectKey: row.object_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function researchItemRowToItem(row: ResearchItemRow): ResearchWorkbenchItem {
  return {
    id: row.id,
    userKey: row.user_key,
    entityType: row.entity_type === "industry" ? "industry" : "company",
    entityId: row.entity_id,
    title: row.title,
    subtitle: row.subtitle ?? undefined,
    stage: normalizeResearchStage(row.stage) ?? "screening",
    status: row.status,
    source: row.source,
    evidenceHash: row.evidence_hash ?? undefined,
    currentThesisVersionId: row.current_thesis_version_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function researchThesisRowToVersion(row: ResearchThesisRow): ResearchThesisVersion {
  return {
    id: row.id,
    itemId: row.item_id,
    version: row.version,
    thesisMarkdown: row.thesis_markdown,
    coreCitations: parseJson<string[]>(row.core_citations_json) ?? [],
    counterEvidence: parseJson<string[]>(row.counter_evidence_json) ?? [],
    evidenceHash: row.evidence_hash ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function researchCatalystRowToCatalyst(row: ResearchCatalystRow): ResearchCatalyst {
  return {
    id: row.id,
    itemId: row.item_id,
    title: row.title,
    description: row.description ?? undefined,
    dueAt: row.due_at ?? undefined,
    status: normalizeResearchCatalystStatus(row.status) ?? "open",
    evidenceRefs: parseJson<string[]>(row.evidence_refs_json) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dedupeCatalystDrafts(drafts: ResearchCatalystDraft[]) {
  const seen = new Set<string>();
  const result: ResearchCatalystDraft[] = [];
  for (const draft of drafts) {
    const title = draft.title.trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    result.push({
      title,
      description: draft.description?.trim(),
      evidenceRefs: Array.from(new Set(draft.evidenceRefs.map((ref) => ref.trim()).filter(Boolean))),
    });
  }
  return result;
}

function normalizeResearchStage(value: unknown): ResearchStage | null {
  return RESEARCH_STAGES.includes(value as ResearchStage) ? value as ResearchStage : null;
}

function normalizeResearchCatalystStatus(value: unknown): ResearchCatalystStatus | null {
  return RESEARCH_CATALYST_STATUSES.includes(value as ResearchCatalystStatus) ? value as ResearchCatalystStatus : null;
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function isThesisVersionConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /UNIQUE constraint failed.*research_thesis_versions.*(?:item_id|version)/i.test(message);
}
