import type { AssistantDeepResearchJob, AssistantDeepResearchKind, AssistantDeepResearchStatus, AssistantMode } from "../../src/shared/assistant";
import type { AssistantSearchToolCall } from "./assistant-tools";

export const ASSISTANT_DEEP_RESEARCH_QUEUE_BINDING = "ASSISTANT_DEEP_RESEARCH_QUEUE";
export const ASSISTANT_DEEP_RESEARCH_QUEUE_NAME = "cstd-alpha-assistant-deep-research";
export const ASSISTANT_DEEP_RESEARCH_PROGRESS_TTL_SECONDS = 60 * 60;
export const ASSISTANT_DEEP_RESEARCH_MAX_MS = 15 * 60 * 1_000;
export const ASSISTANT_DEEP_RESEARCH_STALE_MS = ASSISTANT_DEEP_RESEARCH_MAX_MS + 60 * 1_000;

export type AssistantDeepResearchQueueMessage = {
  jobId: string;
};

type DeepResearchRow = {
  id: string;
  thread_id: string;
  query: string;
  mode: AssistantMode;
  research_kind: AssistantDeepResearchKind;
  status: AssistantDeepResearchStatus;
  progress_title: string;
  progress_stage: string;
  progress_current: number;
  progress_total: number;
  stop_requested: number;
  result_message_id: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
};

export type AssistantDeepResearchWorkerJob = AssistantDeepResearchJob & {
  userKey: string;
  userMessageId: string;
  assistantMessageId: string;
};

export function classifyAssistantDeepResearch(message: string, mode: AssistantMode): AssistantDeepResearchKind | null {
  const text = message.trim();
  if (!text) return null;
  if (/(对比|比较|区别|谁更|哪家更|vs\b|VS\b)/i.test(text)) return "comparison";
  if (/(选股|推荐|最值得买|买哪|三家|排行|排序|优先级|梭哈|标的)/.test(text)) return "selection";
  if (/(预估|预测|目标价|明年股价|未来.*利润|业绩.*多少|估值.*多少|空间|情景测算)/.test(text)) return "forecast";
  if (/(反驳|是不是稳赚|一定涨|必涨|无风险|高股息.*稳赚|泡沫|过度乐观|过度悲观)/.test(text)) return "contrarian";
  if (/(拐点|周期|出清|衰退|景气|行业|产业|板块|赛道|供应链|产业链)/.test(text) || mode === "industry") return "industry";
  if (/(能买吗|买不买|该不该买|卖不卖|持有|回避|风险|排雷|投资价值)/.test(text) || mode === "target") return "risk";
  return null;
}

export function shouldStartAssistantDeepResearch(message: string, mode: AssistantMode) {
  return classifyAssistantDeepResearch(message, mode) !== null;
}

export function isAssistantDeepResearchJobStale(
  job: Pick<AssistantDeepResearchJob, "status" | "createdAt" | "startedAt" | "updatedAt">,
  nowMs = Date.now(),
) {
  if (job.status === "completed" || job.status === "failed") return false;
  const lastUpdateMs = Date.parse(job.updatedAt || job.startedAt || job.createdAt || "");
  return Number.isFinite(lastUpdateMs) && nowMs - lastUpdateMs > ASSISTANT_DEEP_RESEARCH_STALE_MS;
}

export function buildAssistantDeepResearchToolCalls(kind: AssistantDeepResearchKind, message: string): AssistantSearchToolCall[] {
  const subject = message.trim().slice(0, 180);
  const calls: AssistantSearchToolCall[] = [];
  const add = (name: AssistantSearchToolCall["name"], query: string, reason: string) => calls.push({ id: `deep:${calls.length + 1}:${name}`, name, query, reason });
  if (kind === "forecast" || kind === "risk" || kind === "comparison") {
    add("read_company_evidence", subject, "读取站内公司证据包");
    add("read_tencent_quote", subject, "核验最新行情和估值");
    add("read_financial_statements", subject, "核验财报和现金流");
    add("read_filings_news", subject, "核验公告和最新事件");
  }
  if (kind === "selection" || kind === "industry") {
    add("read_radar_result", subject, "读取全行业雷达和主题线索");
    add("read_market_data", "industry", "核验行业强弱排序");
    add("search_tavily", `${subject} 行业 代表公司 财报 订单 估值 风险 最新`, "补充行业和候选公司外部线索");
    add("search_brave", `${subject} 行业 代表公司 财报 订单 估值 风险 最新`, "交叉验证行业和候选公司");
  }
  if (kind === "contrarian") {
    add("search_tavily", `${subject} 数据 案例 风险 反证 最新`, "检索支持和反方证据");
    add("search_brave", `${subject} 数据 案例 风险 反证 最新`, "交叉验证反方证据");
    add("read_radar_result", subject, "读取相关行业雷达");
  }
  add("search_exa", `${subject} latest financial evidence risks counter evidence`, "补充全球高质量来源");
  return dedupeToolCalls(calls);
}

export function hasRequiredDeepResearchAnswerSections(text: string, kind: AssistantDeepResearchKind) {
  const hasVerdict = /(主判断|结论)[：:]\s*(?:\*{1,2})?\s*(看好|中性观察|谨慎回避|反对)/.test(text);
  const hasScenarios = /(保守|中性|乐观).*(情景|场景)/s.test(text);
  const hasEvidenceTable = /\|[^\n]+\|/.test(text) && /(证据|来源|依据)/.test(text);
  const hasCounterEvidence = /(反证|我可能错在哪里|证伪)/.test(text);
  const hasTracking = /(下一步跟踪|跟踪指标|后续跟踪)/.test(text);
  const hasRequiredDecision = kind === "selection" || kind === "comparison" ? /(排序|优先级|第一|第1|更优)/.test(text) : true;
  const hasRequiredRange = kind === "forecast" ? /(区间|保守|中性|乐观)/.test(text) : true;
  return hasVerdict && hasScenarios && hasEvidenceTable && hasCounterEvidence && hasTracking && hasRequiredDecision && hasRequiredRange;
}

export async function ensureAssistantDeepResearchSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS assistant_deep_research_jobs (
      id TEXT PRIMARY KEY, user_key TEXT NOT NULL, thread_id TEXT NOT NULL, user_message_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL,
      query TEXT NOT NULL, mode TEXT NOT NULL, research_kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      progress_title TEXT NOT NULL DEFAULT '正在排队...', progress_stage TEXT NOT NULL DEFAULT 'queued',
      progress_current INTEGER NOT NULL DEFAULT 0, progress_total INTEGER NOT NULL DEFAULT 4, stop_requested INTEGER NOT NULL DEFAULT 0,
      evidence_object_key TEXT, result_message_id TEXT, error_message TEXT, created_at TEXT NOT NULL, started_at TEXT, updated_at TEXT NOT NULL, completed_at TEXT
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_assistant_deep_research_user ON assistant_deep_research_jobs (user_key, updated_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_assistant_deep_research_thread ON assistant_deep_research_jobs (thread_id, updated_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_assistant_deep_research_status ON assistant_deep_research_jobs (status, updated_at ASC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS assistant_deep_research_steps (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, round INTEGER NOT NULL, stage TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      tool_name TEXT, summary TEXT, evidence_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_assistant_deep_research_steps_job ON assistant_deep_research_steps (job_id, created_at ASC)`),
  ]);
}

export async function createAssistantDeepResearchJob(db: D1Database, input: {
  userKey: string;
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  query: string;
  mode: AssistantMode;
  researchKind: AssistantDeepResearchKind;
  now?: string;
}) {
  await ensureAssistantDeepResearchSchema(db);
  const now = input.now ?? new Date().toISOString();
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO assistant_deep_research_jobs (
       id, user_key, thread_id, user_message_id, assistant_message_id, query, mode, research_kind, status,
       progress_title, progress_stage, progress_current, progress_total, stop_requested, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', '正在排队...', 'queued', 0, 4, 0, ?9, ?9)`,
  ).bind(id, input.userKey, input.threadId, input.userMessageId, input.assistantMessageId, input.query, input.mode, input.researchKind, now).run();
  return {
    id,
    threadId: input.threadId,
    query: input.query,
    mode: input.mode,
    researchKind: input.researchKind,
    status: "queued",
    progressTitle: "正在排队...",
    progressStage: "queued",
    progressCurrent: 0,
    progressTotal: 4,
    stopRequested: false,
    createdAt: now,
    updatedAt: now,
  } satisfies AssistantDeepResearchJob;
}

export async function readAssistantDeepResearchJob(db: D1Database, userKey: string, id: string) {
  await ensureAssistantDeepResearchSchema(db);
  const row = await db.prepare(
    `SELECT id, thread_id, query, mode, research_kind, status, progress_title, progress_stage, progress_current, progress_total,
            stop_requested, result_message_id, error_message, created_at, started_at, updated_at, completed_at
     FROM assistant_deep_research_jobs WHERE id = ?1 AND user_key = ?2`,
  ).bind(id, userKey).first<DeepResearchRow>();
  if (!row) return null;
  const job = rowToAssistantDeepResearchJob(row);
  return isAssistantDeepResearchJobStale(job) ? expireStaleAssistantDeepResearchJob(db, row) : job;
}

export async function readAssistantDeepResearchJobForWorker(db: D1Database, id: string) {
  await ensureAssistantDeepResearchSchema(db);
  const row = await db.prepare(
    `SELECT id, user_key, thread_id, user_message_id, assistant_message_id, query, mode, research_kind, status, progress_title, progress_stage,
            progress_current, progress_total, stop_requested, result_message_id, error_message, created_at, started_at, updated_at, completed_at
     FROM assistant_deep_research_jobs WHERE id = ?1`,
  ).bind(id).first<DeepResearchRow & { user_key: string; user_message_id: string; assistant_message_id: string }>();
  if (!row) return null;
  return {
    ...rowToAssistantDeepResearchJob(row),
    userKey: row.user_key,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
  } satisfies AssistantDeepResearchWorkerJob;
}

export async function requestAssistantDeepResearchStop(db: D1Database, userKey: string, id: string, now = new Date().toISOString()) {
  await ensureAssistantDeepResearchSchema(db);
  await db.prepare(
    `UPDATE assistant_deep_research_jobs
     SET stop_requested = 1, status = CASE WHEN status IN ('queued', 'running') THEN 'stopping' ELSE status END,
         progress_title = CASE WHEN status IN ('queued', 'running') THEN '正在整理阶段性总结...' ELSE progress_title END,
         updated_at = ?1
     WHERE id = ?2 AND user_key = ?3`,
  ).bind(now, id, userKey).run();
  return readAssistantDeepResearchJob(db, userKey, id);
}

export async function writeAssistantDeepResearchProgress(db: D1Database, cache: KVNamespace | undefined, input: {
  id: string;
  status: AssistantDeepResearchStatus;
  title: string;
  stage: string;
  current: number;
  total?: number;
  errorMessage?: string;
  evidenceObjectKey?: string;
  resultMessageId?: string;
  now?: string;
}) {
  await ensureAssistantDeepResearchSchema(db);
  const now = input.now ?? new Date().toISOString();
  const completedAt = input.status === "completed" || input.status === "failed" ? now : null;
  await db.prepare(
    `UPDATE assistant_deep_research_jobs
     SET status = ?1, progress_title = ?2, progress_stage = ?3, progress_current = ?4, progress_total = COALESCE(?5, progress_total),
         error_message = COALESCE(?6, error_message), evidence_object_key = COALESCE(?7, evidence_object_key),
         result_message_id = COALESCE(?8, result_message_id), started_at = CASE WHEN ?1 = 'running' THEN COALESCE(started_at, ?9) ELSE started_at END,
         completed_at = COALESCE(?10, completed_at), updated_at = ?9
     WHERE id = ?11`,
  ).bind(input.status, input.title, input.stage, input.current, input.total ?? null, input.errorMessage ?? null, input.evidenceObjectKey ?? null, input.resultMessageId ?? null, now, completedAt, input.id).run();
  if (cache) {
    await cache.put(`assistant:deep-research:${input.id}`, JSON.stringify({ ...input, updatedAt: now }), { expirationTtl: ASSISTANT_DEEP_RESEARCH_PROGRESS_TTL_SECONDS });
  }
}

export async function isAssistantDeepResearchStopRequested(db: D1Database, id: string) {
  const row = await db.prepare(`SELECT stop_requested FROM assistant_deep_research_jobs WHERE id = ?1`).bind(id).first<{ stop_requested: number }>();
  return Boolean(row?.stop_requested);
}

export async function writeAssistantDeepResearchStep(db: D1Database, input: {
  jobId: string;
  round: number;
  stage: string;
  title: string;
  status: "running" | "completed" | "failed";
  toolName?: string;
  summary?: string;
  evidenceCount?: number;
  now?: string;
}) {
  await ensureAssistantDeepResearchSchema(db);
  await db.prepare(
    `INSERT INTO assistant_deep_research_steps (id, job_id, round, stage, title, status, tool_name, summary, evidence_count, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).bind(
    crypto.randomUUID(),
    input.jobId,
    input.round,
    input.stage,
    input.title,
    input.status,
    input.toolName ?? null,
    input.summary ?? null,
    input.evidenceCount ?? 0,
    input.now ?? new Date().toISOString(),
  ).run();
}

async function expireStaleAssistantDeepResearchJob(db: D1Database, row: DeepResearchRow) {
  const now = new Date().toISOString();
  const errorMessage = "后台研究超时或 Worker 中断，已停止等待。";
  await db.prepare(
    `UPDATE assistant_deep_research_jobs
     SET status = 'failed', progress_title = '后台研究超时，请重新发起。', progress_stage = 'failed',
         progress_current = progress_total, error_message = COALESCE(error_message, ?1),
         completed_at = ?2, updated_at = ?2
     WHERE id = ?3 AND status IN ('queued', 'running', 'stopping')`,
  ).bind(errorMessage, now, row.id).run();
  return {
    ...rowToAssistantDeepResearchJob(row),
    status: "failed",
    progressTitle: "后台研究超时，请重新发起。",
    progressStage: "failed",
    progressCurrent: row.progress_total,
    errorMessage: row.error_message ?? errorMessage,
    updatedAt: now,
    completedAt: now,
  } satisfies AssistantDeepResearchJob;
}

function rowToAssistantDeepResearchJob(row: DeepResearchRow): AssistantDeepResearchJob {
  return {
    id: row.id,
    threadId: row.thread_id,
    query: row.query,
    mode: row.mode,
    researchKind: row.research_kind,
    status: row.status,
    progressTitle: row.progress_title,
    progressStage: row.progress_stage,
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    stopRequested: Boolean(row.stop_requested),
    ...(row.result_message_id ? { resultMessageId: row.result_message_id } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function dedupeToolCalls(calls: AssistantSearchToolCall[]) {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.name}:${call.query ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
