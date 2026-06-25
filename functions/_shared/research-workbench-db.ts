import type { ResearchCatalyst, ResearchCatalystDraft, ResearchCatalystStatus, ResearchEntityType, ResearchStage, ResearchThesisVersion, ResearchWorkbenchItem } from "../../src/shared/research-workbench";
import { RESEARCH_CATALYST_STATUSES, RESEARCH_STAGES } from "../../src/shared/research-workbench";
import type { CompanyArchetype, ValuationMethod, ValuationResult, ValuationRunStatus } from "../../src/shared/valuation";
import type { QuantitativeDraft } from "../../src/shared/quantitative-valuation";
import type { CompanyEvidencePackage } from "./company-evidence";
import { buildActualReviews } from "./quantitative-valuation-review";

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

type QuantitativeVersionRow = {
  id: string;
  user_key: string;
  valuation_run_id: string;
  source_snapshot_id: string;
  version: number;
  status: string;
  parent_version_id: string | null;
  archetype: CompanyArchetype;
  method: ValuationMethod;
  horizon_years: number;
  draft_json: string;
  created_by: string;
  decision_note: string | null;
  created_at: string;
};

type QuantitativeSnapshotRow = {
  id: string;
  user_key: string;
  research_item_id: string;
  market: string;
  as_of: string;
  payload_json: string;
  evidence_hash: string | null;
  content_hash: string;
  created_at: string;
};

type QuantitativeDraftWithAssumptions = QuantitativeDraft & { assumptions?: Array<Record<string, unknown>> };

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
    db.prepare(`CREATE TABLE IF NOT EXISTS research_activity_events (
      id TEXT PRIMARY KEY, user_key TEXT NOT NULL, item_id TEXT NOT NULL, event_type TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_research_activity_events_item ON research_activity_events (item_id, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_research_activity_events_user ON research_activity_events (user_key, created_at DESC)`),
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
  if (item.createdAt === now) {
    await recordActivityEvent(db, input.userKey, {
      itemId: id,
      eventType: "created",
      title: "研究项创建",
      description: `来源: ${input.source ?? "manual"}`,
      metadata: { source: input.source ?? "manual", entityType: input.entityType },
    }).catch(() => {});
  }
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
  const old = await db.prepare(`SELECT stage FROM research_items WHERE user_key = ?1 AND id = ?2`).bind(userKey, id).first<{ stage: string }>();
  if (typeof sortOrder === "number") {
    await db.prepare(`UPDATE research_items SET stage = ?3, sort_order = ?4, updated_at = ?5 WHERE user_key = ?1 AND id = ?2`).bind(userKey, id, normalized, sortOrder, now).run();
  } else {
    await db.prepare(`UPDATE research_items SET stage = ?3, updated_at = ?4 WHERE user_key = ?1 AND id = ?2`).bind(userKey, id, normalized, now).run();
  }
  if (old && old.stage !== normalized) {
    await recordActivityEvent(db, userKey, {
      itemId: id,
      eventType: "stage_change",
      title: `阶段变更`,
      description: `从「${old.stage}」移动到「${normalized}」`,
      metadata: { from: old.stage, to: normalized },
    }).catch(() => {});
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
  if (ids.length > 100) throw new Error("too many ids to delete");
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
  const runSubquery = `SELECT id FROM valuation_runs WHERE user_key = ?1 AND research_item_id IN (${placeholders})`;
  const versionSubquery = `SELECT id FROM valuation_forecast_versions WHERE user_key = ?1 AND valuation_run_id IN (${runSubquery})`;
  const statements = [
    db.prepare(`DELETE FROM valuation_model_results WHERE version_id IN (${versionSubquery})`).bind(userKey, ...ids),
    db.prepare(`DELETE FROM valuation_assumption_values WHERE version_id IN (${versionSubquery})`).bind(userKey, ...ids),
    db.prepare(`DELETE FROM valuation_actual_reviews WHERE version_id IN (${versionSubquery})`).bind(userKey, ...ids),
    db.prepare(`DELETE FROM valuation_forecast_versions WHERE user_key = ?1 AND valuation_run_id IN (${runSubquery})`).bind(userKey, ...ids),
    db.prepare(`DELETE FROM valuation_source_snapshots WHERE user_key = ?1 AND research_item_id IN (${placeholders})`).bind(userKey, ...ids),
    db.prepare(`DELETE FROM valuation_runs WHERE user_key = ?1 AND research_item_id IN (${placeholders})`).bind(userKey, ...ids),
    db.prepare(`DELETE FROM research_activity_events WHERE user_key = ?1 AND item_id IN (${placeholders})`).bind(userKey, ...ids),
    db.prepare(`DELETE FROM research_catalysts WHERE user_key = ?1 AND item_id IN (${placeholders})`).bind(userKey, ...ids),
    db.prepare(`DELETE FROM research_thesis_versions WHERE user_key = ?1 AND item_id IN (${placeholders})`).bind(userKey, ...ids),
    db.prepare(`DELETE FROM research_stage_suggestions WHERE user_key = ?1 AND item_id IN (${placeholders})`).bind(userKey, ...ids),
    db.prepare(`DELETE FROM research_notifications WHERE user_key = ?1 AND item_id IN (${placeholders})`).bind(userKey, ...ids),
    db.prepare(`DELETE FROM research_items WHERE user_key = ?1 AND id IN (${placeholders})`).bind(userKey, ...ids),
  ];
  await db.batch(statements);
}

export type ActivityEvent = {
  id: string;
  itemId: string;
  eventType: string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export async function recordActivityEvent(db: D1Database, userKey: string, input: {
  itemId: string;
  eventType: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}) {
  await ensureResearchWorkbenchSchema(db);
  const id = `evt_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO research_activity_events (id, user_key, item_id, event_type, title, description, metadata_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(id, userKey, input.itemId, input.eventType, input.title, input.description ?? null, JSON.stringify(input.metadata ?? {}), now).run();
}

export async function listActivityEvents(db: D1Database, userKey: string, itemId: string, limit = 20) {
  await ensureResearchWorkbenchSchema(db);
  const result = await db.prepare(
    `SELECT id, item_id, event_type, title, description, metadata_json, created_at
     FROM research_activity_events WHERE user_key = ?1 AND item_id = ?2 ORDER BY created_at DESC LIMIT ?3`,
  ).bind(userKey, itemId, limit).all<{ id: string; item_id: string; event_type: string; title: string; description: string | null; metadata_json: string; created_at: string }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    itemId: row.item_id,
    eventType: row.event_type,
    title: row.title,
    description: row.description,
    metadata: JSON.parse(row.metadata_json || "{}") as Record<string, unknown>,
    createdAt: row.created_at,
  }));
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
  await recordActivityEvent(db, input.userKey, {
    itemId: input.itemId,
    eventType: "thesis_generated",
    title: "论点已生成",
    description: `版本 ${row.version}，由 ${input.createdBy ?? "ai"} 生成`,
    metadata: { version: row.version, createdBy: input.createdBy ?? "ai", thesisId: id },
  }).catch(() => {});
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

export async function createOrReadValuationSourceSnapshot(db: D1Database, input: {
  userKey: string;
  researchItemId: string;
  market: string;
  asOf: string;
  payload: unknown;
  evidenceHash?: string;
  contentHash: string;
}) {
  const now = new Date().toISOString();
  const id = await sha256(`${input.userKey}:${input.researchItemId}:${input.contentHash}`);
  await db.prepare(
    `INSERT OR IGNORE INTO valuation_source_snapshots (
       id, user_key, research_item_id, market, as_of, payload_json, evidence_hash, content_hash, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(id, input.userKey, input.researchItemId, input.market, input.asOf, JSON.stringify(input.payload), input.evidenceHash ?? null, input.contentHash, now).run();
  const row = await db.prepare(
    `SELECT id, user_key, research_item_id, market, as_of, payload_json, evidence_hash, content_hash, created_at
     FROM valuation_source_snapshots
     WHERE user_key = ?1 AND research_item_id = ?2 AND content_hash = ?3`,
  ).bind(input.userKey, input.researchItemId, input.contentHash).first<QuantitativeSnapshotRow>();
  if (!row) throw new Error("valuation source snapshot create failed");
  return quantitativeSnapshotRowToSummary(row);
}

export async function createQuantitativeVersion(db: D1Database, input: {
  userKey: string;
  runId: string;
  snapshotId: string;
  draft: QuantitativeDraftWithAssumptions;
  result: ValuationResult;
  parentVersionId?: string;
  createdBy: "baseline" | "user" | "system";
  decisionNote?: string;
}) {
  const next = await db.prepare(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM valuation_forecast_versions WHERE user_key = ?1 AND valuation_run_id = ?2`,
  ).bind(input.userKey, input.runId).first<{ next_version: number }>();
  const version = Number(next?.next_version ?? 1);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const decisionNote = normalizeDecisionNote(input.decisionNote);
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO valuation_forecast_versions (
         id, user_key, valuation_run_id, source_snapshot_id, version, status, parent_version_id,
         archetype, method, horizon_years, draft_json, created_by, decision_note, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'saved', ?6, ?7, ?8, 5, ?9, ?10, ?11, ?12)`,
    ).bind(id, input.userKey, input.runId, input.snapshotId, version, input.parentVersionId ?? null, input.draft.archetype, input.draft.method, JSON.stringify(input.draft), input.createdBy, decisionNote ?? null, now),
  ];
  for (const assumption of normalizeQuantitativeAssumptions(input.draft.assumptions ?? [])) {
    statements.push(db.prepare(
      `INSERT INTO valuation_assumption_values (
         id, version_id, key, scenario, forecast_year, value, unit, origin, locked,
         confidence, evidence_refs_json, explanation, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    ).bind(crypto.randomUUID(), id, assumption.key, assumption.scenario, assumption.forecastYear ?? null, assumption.value, assumption.unit, assumption.origin, assumption.locked ? 1 : 0, assumption.confidence ?? null, JSON.stringify(assumption.evidenceRefs), assumption.explanation ?? null, now));
  }
  const modelPayloads = input.result.modelResults?.length
    ? input.result.modelResults.map((model) => ({ modelKey: model.modelKey, weight: model.weight, payload: model }))
    : [{ modelKey: input.result.method, weight: 1, payload: input.result }];
  for (const model of modelPayloads) {
    const payloadJson = JSON.stringify(model.payload);
    statements.push(db.prepare(
      `INSERT INTO valuation_model_results (
         id, version_id, model_key, weight, payload_json, calculation_hash, warnings_json, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(crypto.randomUUID(), id, model.modelKey, model.weight ?? null, payloadJson, await sha256(payloadJson), JSON.stringify(input.result.warnings ?? []), now));
  }
  await db.batch(statements);
  return {
    id,
    runId: input.runId,
    sourceSnapshotId: input.snapshotId,
    version,
    status: "saved",
    parentVersionId: input.parentVersionId,
    archetype: input.draft.archetype,
    method: input.draft.method,
    horizonYears: 5,
    draft: input.draft,
    result: input.result,
    decisionNote,
    createdBy: input.createdBy,
    createdAt: now,
  };
}

export async function listQuantitativeVersions(db: D1Database, userKey: string, runId: string) {
  const result = await db.prepare(
    `SELECT id, user_key, valuation_run_id, source_snapshot_id, version, status, parent_version_id,
            archetype, method, horizon_years, draft_json, created_by, decision_note, created_at
     FROM valuation_forecast_versions
     WHERE user_key = ?1 AND valuation_run_id = ?2
     ORDER BY version DESC`,
  ).bind(userKey, runId).all<QuantitativeVersionRow>();
  return (result.results ?? []).map(quantitativeVersionRowToSummary);
}

export async function readQuantitativeWorkspace(db: D1Database, userKey: string, runId: string) {
  const run = await readValuationRun(db, userKey, runId);
  if (!run) return null;
  const versions = await listQuantitativeVersions(db, userKey, runId);
  const latest = versions[0];
  const snapshot = latest ? await db.prepare(
    `SELECT id, user_key, research_item_id, market, as_of, payload_json, evidence_hash, content_hash, created_at
     FROM valuation_source_snapshots WHERE user_key = ?1 AND id = ?2`,
  ).bind(userKey, latest.sourceSnapshotId).first<QuantitativeSnapshotRow>() : null;
  const reviews = latest ? await db.prepare(
    `SELECT metric_key, forecast_year, forecast_value, actual_value, absolute_error, percentage_error, reviewed_at
     FROM valuation_actual_reviews WHERE version_id = ?1 ORDER BY forecast_year, metric_key`,
  ).bind(latest.id).all<{
    metric_key: string; forecast_year: number; forecast_value: number; actual_value: number;
    absolute_error: number; percentage_error: number | null; reviewed_at: string;
  }>() : { results: [] };
  return {
    run: valuationRunToSummary(run),
    snapshot: snapshot ? quantitativeSnapshotRowToSummary(snapshot) : undefined,
    versions,
    actualReviews: (reviews.results ?? []).map((row) => ({
      metricKey: row.metric_key,
      forecastYear: row.forecast_year,
      forecastValue: row.forecast_value,
      actualValue: row.actual_value,
      absoluteError: row.absolute_error,
      percentageError: row.percentage_error ?? undefined,
      reviewedAt: row.reviewed_at,
    })),
  };
}

export async function writeActualReviews(db: D1Database, versionId: string, reviews: NonNullable<ValuationResult["actualReviews"]>) {
  const now = new Date().toISOString();
  if (!reviews.length) return;
  await db.batch(reviews.map((review) => db.prepare(
    `INSERT INTO valuation_actual_reviews (
       id, version_id, metric_key, forecast_year, forecast_value, actual_value, absolute_error, percentage_error, reviewed_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(version_id, metric_key, forecast_year) DO UPDATE SET
       actual_value = excluded.actual_value, absolute_error = excluded.absolute_error,
       percentage_error = excluded.percentage_error, reviewed_at = excluded.reviewed_at`,
  ).bind(crypto.randomUUID(), versionId, review.metricKey, review.forecastYear, review.forecastValue, review.actualValue, review.absoluteError, review.percentageError ?? null, now)));
}

export async function writeActualReviewsForWatchlist(db: D1Database, userKey: string, watchlistId: string, evidence: CompanyEvidencePackage) {
  const rows = await db.prepare(
    `SELECT v.id AS version_id, v.draft_json, mr.payload_json
     FROM valuation_forecast_versions v
     JOIN valuation_runs vr ON vr.id = v.valuation_run_id AND vr.user_key = v.user_key
     JOIN valuation_model_results mr ON mr.version_id = v.id AND mr.model_key = v.method
     WHERE v.user_key = ?1 AND vr.entity_id = ?2
     ORDER BY v.version DESC`,
  ).bind(userKey, watchlistId).all<{ version_id: string; draft_json: string; payload_json: string }>();
  let reviewCount = 0;
  for (const row of rows.results ?? []) {
    const draft = parseJson<QuantitativeDraft>(row.draft_json);
    const result = parseJson<ValuationResult>(row.payload_json);
    if (!draft || !result) continue;
    const reviews = buildActualReviews(draft, result, evidence);
    await writeActualReviews(db, row.version_id, reviews);
    reviewCount += reviews.length;
  }
  return reviewCount;
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

function quantitativeSnapshotRowToSummary(row: QuantitativeSnapshotRow) {
  return {
    id: row.id,
    userKey: row.user_key,
    researchItemId: row.research_item_id,
    market: row.market,
    asOf: row.as_of,
    payload: parseJson<unknown>(row.payload_json),
    evidenceHash: row.evidence_hash ?? undefined,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

function quantitativeVersionRowToSummary(row: QuantitativeVersionRow) {
  return {
    id: row.id,
    runId: row.valuation_run_id,
    sourceSnapshotId: row.source_snapshot_id,
    version: row.version,
    status: row.status,
    parentVersionId: row.parent_version_id ?? undefined,
    archetype: row.archetype,
    method: row.method,
    horizonYears: row.horizon_years,
    draft: parseJson<QuantitativeDraftWithAssumptions>(row.draft_json),
    decisionNote: row.decision_note ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function normalizeDecisionNote(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, 240);
  return normalized || undefined;
}

function normalizeQuantitativeAssumptions(assumptions: Array<Record<string, unknown>>) {
  return assumptions.flatMap((assumption) => {
    const shared = {
      key: String(assumption.key ?? ""),
      unit: String(assumption.unit ?? ""),
      origin: normalizeAssumptionOrigin(assumption.origin),
      locked: assumption.locked === true,
      confidence: finiteNumber(assumption.confidence),
      evidenceRefs: Array.isArray(assumption.evidenceRefs) ? assumption.evidenceRefs.filter((item): item is string => typeof item === "string") : [],
      explanation: typeof assumption.explanation === "string" ? assumption.explanation : undefined,
      forecastYear: finiteNumber(assumption.forecastYear),
    };
    const scenarios = (["bear", "base", "bull"] as const)
      .map((scenario) => ({ scenario, value: finiteNumber(assumption[scenario]) }))
      .filter((item): item is { scenario: "bear" | "base" | "bull"; value: number } => item.value !== undefined);
    if (scenarios.length) return scenarios.map((item) => ({ ...shared, ...item }));
    const value = finiteNumber(assumption.value) ?? finiteNumber(assumption.base);
    return value === undefined ? [] : [{ ...shared, scenario: "base" as const, value }];
  }).filter((item) => item.key);
}

function normalizeAssumptionOrigin(value: unknown): "provider" | "formula" | "ai" | "user" {
  return value === "provider" || value === "formula" || value === "ai" || value === "user" ? value : "formula";
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
