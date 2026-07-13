import type { RadarAnalysisJob, RadarAnalysisJobStatus, RadarDiagnostics, RadarEvidenceFreshness, RadarTokenUsage } from "../../src/shared/radar";

export type RadarJobEnv = {
  GITHUB_RADAR_DISPATCH_TOKEN?: string;
  GITHUB_RADAR_REPOSITORY?: string;
  GITHUB_RADAR_WORKFLOW?: string;
  REPORT_CACHE?: KVNamespace;
  REPORT_LIBRARY_DB?: D1Database;
};

export type RadarAnalysisRunState = RadarAnalysisJobStatus | "publishing" | "failing";

export type RadarAnalysisJobRun = {
  job: RadarAnalysisJob;
  runToken: string;
  state: RadarAnalysisRunState;
};

export type QueueRadarAnalysisJobResult =
  | { created: true; job: RadarAnalysisJob; runToken: string }
  | { created: false; job: RadarAnalysisJob };

type RadarEvidenceSnapshotForFreshness = {
  version?: string;
  generatedAt?: unknown;
  asOfDate?: unknown;
  evidenceHash?: unknown;
  sources?: unknown;
};

type RadarCacheForDiagnostics = {
  version?: string;
  radar: {
    generatedAt?: string;
    sourceCount?: number;
  };
};

const GITHUB_DISPATCH_TIMEOUT_MS = 15_000;
const RADAR_JOB_STALE_MS = 20 * 60 * 1000;
export const RADAR_RESULT_CACHE_KEY = "radar-scan:v2:latest";
export const RADAR_ANALYSIS_JOB_PREFIX = "radar-analysis:job:";
export const RADAR_ANALYSIS_JOB_LATEST_KEY = `${RADAR_ANALYSIS_JOB_PREFIX}latest`;

export async function ensureRadarAnalysisJobSchema(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS radar_analysis_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        job_id TEXT NOT NULL,
        run_token TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'publishing', 'failing', 'completed', 'failed')),
        evidence_hash TEXT,
        message TEXT,
        radar_generated_at TEXT,
        token_usage_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )`,
    )
    .run();
}

export function createRadarAnalysisJob(evidenceHash?: string): RadarAnalysisJob {
  const now = new Date().toISOString();
  return {
    id: `radar-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    evidenceHash,
    message: "后台分析已排队，页面会继续显示上次稳定结果。",
  };
}

export async function queueRadarAnalysisJob(db: D1Database, evidenceHash?: string): Promise<QueueRadarAnalysisJobResult> {
  await ensureRadarAnalysisJobSchema(db);
  const job = createRadarAnalysisJob(evidenceHash);
  const runToken = crypto.randomUUID();
  const staleBefore = new Date(Date.now() - RADAR_JOB_STALE_MS).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO radar_analysis_state (
         singleton_id, job_id, run_token, status, evidence_hash, message, radar_generated_at, token_usage_json, created_at, updated_at, completed_at
       ) VALUES (1, ?1, ?2, 'queued', ?3, ?4, NULL, NULL, ?5, ?5, NULL)
       ON CONFLICT(singleton_id) DO UPDATE SET
         job_id = excluded.job_id,
         run_token = excluded.run_token,
         status = excluded.status,
         evidence_hash = excluded.evidence_hash,
         message = excluded.message,
         radar_generated_at = NULL,
         token_usage_json = NULL,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         completed_at = NULL
       WHERE radar_analysis_state.status IN ('completed', 'failed')
          OR radar_analysis_state.updated_at < ?6`,
    )
    .bind(job.id, runToken, evidenceHash ?? null, job.message ?? null, job.createdAt, staleBefore)
    .run();
  if ((result.meta?.changes ?? 0) > 0) return { created: true, job, runToken };
  const current = await readCurrentRadarAnalysisJobUnchecked(db);
  if (!current) throw new Error("雷达任务状态暂时不可用，请稍后重试。");
  return { created: false, job: current.job };
}

export async function readLatestRadarJob(env: RadarJobEnv, latestJobKey: string): Promise<RadarAnalysisJob | null> {
  if (env.REPORT_LIBRARY_DB) {
    const current = await readCurrentRadarAnalysisJobUnchecked(env.REPORT_LIBRARY_DB).catch(() => null);
    if (current) return current.job;
  }
  const cache = env.REPORT_CACHE;
  if (!cache) return null;
  const value = await cache.get<RadarAnalysisJob>(latestJobKey, "json").catch(() => null);
  return normalizeRadarJob(value);
}

export async function readCurrentRadarAnalysisJob(db: D1Database): Promise<RadarAnalysisJobRun | null> {
  await ensureRadarAnalysisJobSchema(db);
  return readCurrentRadarAnalysisJobUnchecked(db);
}

async function readCurrentRadarAnalysisJobUnchecked(db: D1Database): Promise<RadarAnalysisJobRun | null> {
  const row = await db
    .prepare(
      `SELECT job_id, run_token, status, evidence_hash, message, radar_generated_at, token_usage_json, created_at, updated_at, completed_at
       FROM radar_analysis_state
       WHERE singleton_id = 1`,
    )
    .first<RadarAnalysisStateRow>();
  return rowToRadarAnalysisJobRun(row);
}

export async function startRadarAnalysisJobRun(db: D1Database, jobId: string, runToken: string) {
  await ensureRadarAnalysisJobSchema(db);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE radar_analysis_state
       SET status = 'running', message = ?1, updated_at = ?2
       WHERE singleton_id = 1 AND job_id = ?3 AND run_token = ?4 AND status = 'queued'`,
    )
    .bind("后台深度分析运行中。", now, jobId, runToken)
    .run();
  return (result.meta?.changes ?? 0) > 0 ? readMatchingRadarAnalysisJob(db, jobId, runToken, "running") : null;
}

export async function claimRadarAnalysisJobPublication(db: D1Database, jobId: string, runToken: string) {
  return claimRadarAnalysisJobState(db, jobId, runToken, "running", "publishing");
}

export async function claimRadarAnalysisJobFailure(db: D1Database, jobId: string, runToken: string) {
  await ensureRadarAnalysisJobSchema(db);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE radar_analysis_state
       SET status = 'failing', updated_at = ?1
       WHERE singleton_id = 1 AND job_id = ?2 AND run_token = ?3 AND status IN ('queued', 'running')`,
    )
    .bind(now, jobId, runToken)
    .run();
  if ((result.meta?.changes ?? 0) > 0) return readMatchingRadarAnalysisJob(db, jobId, runToken, "failing");
  return readMatchingRadarAnalysisJob(db, jobId, runToken, "failing");
}

export async function completeRadarAnalysisJobRun(
  db: D1Database,
  jobId: string,
  runToken: string,
  completion: { radarGeneratedAt: string; tokenUsage?: RadarTokenUsage },
) {
  await ensureRadarAnalysisJobSchema(db);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE radar_analysis_state
       SET status = 'completed', message = ?1, radar_generated_at = ?2, token_usage_json = ?3, updated_at = ?4, completed_at = ?4
       WHERE singleton_id = 1 AND job_id = ?5 AND run_token = ?6 AND status = 'publishing'`,
    )
    .bind(
      "后台深度分析完成。",
      completion.radarGeneratedAt,
      completion.tokenUsage ? JSON.stringify(completion.tokenUsage) : null,
      now,
      jobId,
      runToken,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function finishRadarAnalysisJobFailure(db: D1Database, jobId: string, runToken: string, message: string) {
  await ensureRadarAnalysisJobSchema(db);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE radar_analysis_state
       SET status = 'failed', message = ?1, updated_at = ?2, completed_at = ?2
       WHERE singleton_id = 1 AND job_id = ?3 AND run_token = ?4 AND status = 'failing'`,
    )
    .bind(message, now, jobId, runToken)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function abortRadarAnalysisJobRun(db: D1Database, jobId: string, runToken: string, message: string) {
  await ensureRadarAnalysisJobSchema(db);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE radar_analysis_state
       SET status = 'failed', message = ?1, updated_at = ?2, completed_at = ?2
       WHERE singleton_id = 1 AND job_id = ?3 AND run_token = ?4
         AND status IN ('queued', 'running', 'publishing', 'failing')`,
    )
    .bind(message, now, jobId, runToken)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function writeRadarJob(env: RadarJobEnv, job: RadarAnalysisJob, jobPrefix: string, latestJobKey: string) {
  const cache = env.REPORT_CACHE;
  if (!cache) return;
  const payload = JSON.stringify(job);
  const writes = await Promise.allSettled([
    cache.put(`${jobPrefix}${job.id}`, payload, { expirationTtl: 24 * 60 * 60 }),
    cache.put(latestJobKey, payload, { expirationTtl: 24 * 60 * 60 }),
  ]);
  const failure = writes.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

export async function readRadarEvidenceHash(env: RadarJobEnv, snapshotKey: string): Promise<string | undefined> {
  const cache = env.REPORT_CACHE;
  if (!cache) return undefined;
  const value = await cache.get<RadarEvidenceSnapshotForFreshness>(snapshotKey, "json").catch(() => null);
  return stringValue(value?.evidenceHash) || undefined;
}

export async function readRadarEvidenceFreshness(env: RadarJobEnv, snapshotKey: string, expectedVersion: string): Promise<RadarEvidenceFreshness | null> {
  const cache = env.REPORT_CACHE;
  if (!cache) return null;
  const value = await cache.get<RadarEvidenceSnapshotForFreshness>(snapshotKey, "json").catch(() => null);
  if (!value || value.version !== expectedVersion) return null;
  const generatedAt = stringValue(value.generatedAt) || undefined;
  const ageHours = generatedAt ? Math.max(0, Math.round(((Date.now() - Date.parse(generatedAt)) / 3_600_000) * 10) / 10) : undefined;
  return {
    generatedAt,
    asOfDate: stringValue(value.asOfDate) || undefined,
    ageHours,
    stale: typeof ageHours === "number" ? ageHours > 30 : true,
    sourceCount: Array.isArray(value.sources) ? value.sources.length : undefined,
    evidenceHash: stringValue(value.evidenceHash) || undefined,
  };
}

export async function dispatchRadarAnalysisWorkflow(
  env: RadarJobEnv,
  jobId: string,
  runToken: string,
  defaults: { repository: string; workflow: string },
) {
  const token = env.GITHUB_RADAR_DISPATCH_TOKEN?.trim();
  if (!token) throw new Error("missing GitHub radar dispatch token");
  const repository = env.GITHUB_RADAR_REPOSITORY?.trim() || defaults.repository;
  const workflow = env.GITHUB_RADAR_WORKFLOW?.trim() || defaults.workflow;
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "CSTDAlphaRadar/1.0",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { job_id: jobId, run_token: runToken },
      }),
    },
    GITHUB_DISPATCH_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`GitHub radar dispatch failed: ${response.status}`);
}

export function radarDiagnostics(
  cache: RadarCacheForDiagnostics | null,
  job: RadarAnalysisJob | null,
  freshness: RadarEvidenceFreshness | null,
): RadarDiagnostics {
  return {
    jobStatus: job?.status,
    jobMessage: sanitizeDiagnostic(job?.message),
    evidenceGeneratedAt: freshness?.generatedAt,
    evidenceHash: freshness?.evidenceHash,
    evidenceAgeHours: freshness?.ageHours,
    latestRadarGeneratedAt: cache?.radar.generatedAt,
    sourceCount: freshness?.sourceCount ?? cache?.radar.sourceCount,
    cacheVersion: cache?.version,
    tokenUsage: job?.tokenUsage,
  };
}

function normalizeRadarJob(value: unknown): RadarAnalysisJob | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const status = stringValue(value.status) as RadarAnalysisJobStatus;
  const createdAt = stringValue(value.createdAt);
  const updatedAt = stringValue(value.updatedAt);
  if (!id || !["queued", "running", "completed", "failed"].includes(status) || !createdAt || !updatedAt) return null;
  return {
    id,
    status,
    createdAt,
    updatedAt,
    evidenceHash: stringValue(value.evidenceHash) || undefined,
    message: stringValue(value.message) || undefined,
    radarGeneratedAt: stringValue(value.radarGeneratedAt) || undefined,
    tokenUsage: normalizeRadarTokenUsage(value.tokenUsage),
  };
}

export function normalizeRadarTokenUsage(value: unknown): RadarTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const promptTokens = nonNegativeNumber(value.promptTokens);
  const promptCacheHitTokens = nonNegativeNumber(value.promptCacheHitTokens);
  const promptCacheMissTokens = nonNegativeNumber(value.promptCacheMissTokens);
  const completionTokens = nonNegativeNumber(value.completionTokens);
  const totalTokens = nonNegativeNumber(value.totalTokens);
  if ([promptTokens, promptCacheHitTokens, promptCacheMissTokens, completionTokens, totalTokens].some((item) => item === undefined)) return undefined;
  const model = stringValue(value.model) || undefined;
  const calls = nonNegativeNumber(value.calls);
  const cacheHitRate = nonNegativeNumber(value.cacheHitRate);
  return {
    ...(model ? { model } : {}),
    ...(calls === undefined ? {} : { calls }),
    promptTokens: promptTokens!,
    promptCacheHitTokens: promptCacheHitTokens!,
    promptCacheMissTokens: promptCacheMissTokens!,
    completionTokens: completionTokens!,
    totalTokens: totalTokens!,
    ...(cacheHitRate === undefined ? {} : { cacheHitRate: Math.min(1, cacheHitRate) }),
  };
}

async function claimRadarAnalysisJobState(
  db: D1Database,
  jobId: string,
  runToken: string,
  from: RadarAnalysisRunState,
  to: RadarAnalysisRunState,
) {
  await ensureRadarAnalysisJobSchema(db);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE radar_analysis_state
       SET status = ?1, updated_at = ?2
       WHERE singleton_id = 1 AND job_id = ?3 AND run_token = ?4 AND status = ?5`,
    )
    .bind(to, now, jobId, runToken, from)
    .run();
  return (result.meta?.changes ?? 0) > 0 ? readMatchingRadarAnalysisJob(db, jobId, runToken, to) : null;
}

async function readMatchingRadarAnalysisJob(db: D1Database, jobId: string, runToken: string, state: RadarAnalysisRunState) {
  const current = await readCurrentRadarAnalysisJobUnchecked(db);
  return current?.job.id === jobId && current.runToken === runToken && current.state === state ? current : null;
}

function rowToRadarAnalysisJobRun(row: RadarAnalysisStateRow | null): RadarAnalysisJobRun | null {
  if (!row) return null;
  const state = row.status as RadarAnalysisRunState;
  if (!isRadarAnalysisRunState(state)) return null;
  const publicStatus: RadarAnalysisJobStatus = state === "publishing" || state === "failing" ? "running" : state;
  const job = normalizeRadarJob({
    id: row.job_id,
    status: publicStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    evidenceHash: row.evidence_hash,
    message: row.message,
    radarGeneratedAt: row.radar_generated_at,
    tokenUsage: parseTokenUsage(row.token_usage_json),
  });
  return job ? { job, runToken: row.run_token, state } : null;
}

function parseTokenUsage(value: string | null) {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRadarAnalysisRunState(value: string): value is RadarAnalysisRunState {
  return ["queued", "running", "publishing", "failing", "completed", "failed"].includes(value);
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

type RadarAnalysisStateRow = {
  job_id: string;
  run_token: string;
  status: string;
  evidence_hash: string | null;
  message: string | null;
  radar_generated_at: string | null;
  token_usage_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function sanitizeDiagnostic(value: string | undefined) {
  if (!value) return undefined;
  return value.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]").replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
