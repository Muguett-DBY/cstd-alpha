import type { RadarAnalysisJob, RadarAnalysisJobStatus, RadarDiagnostics, RadarEvidenceFreshness } from "../../src/shared/radar";

export type RadarJobEnv = {
  GITHUB_RADAR_DISPATCH_TOKEN?: string;
  GITHUB_RADAR_REPOSITORY?: string;
  GITHUB_RADAR_WORKFLOW?: string;
  REPORT_CACHE?: KVNamespace;
};

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

export function updateRadarJob(job: RadarAnalysisJob, status: RadarAnalysisJobStatus, message?: string): RadarAnalysisJob {
  return {
    ...job,
    status,
    updatedAt: new Date().toISOString(),
    ...(message ? { message } : {}),
  };
}

export async function readLatestRadarJob(env: RadarJobEnv, latestJobKey: string): Promise<RadarAnalysisJob | null> {
  const value = await env.REPORT_CACHE?.get<RadarAnalysisJob>(latestJobKey, "json").catch(() => null);
  return normalizeRadarJob(value);
}

export async function readActiveRadarJob(env: RadarJobEnv, latestJobKey: string): Promise<RadarAnalysisJob | null> {
  const job = await readLatestRadarJob(env, latestJobKey);
  if (!job || (job.status !== "queued" && job.status !== "running")) return null;
  const updatedAt = Date.parse(job.updatedAt);
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt > 20 * 60 * 1000) return null;
  return job;
}

export async function writeRadarJob(env: RadarJobEnv, job: RadarAnalysisJob, jobPrefix: string, latestJobKey: string) {
  const payload = JSON.stringify(job);
  await Promise.all([
    env.REPORT_CACHE?.put(`${jobPrefix}${job.id}`, payload, { expirationTtl: 24 * 60 * 60 }),
    env.REPORT_CACHE?.put(latestJobKey, payload, { expirationTtl: 24 * 60 * 60 }),
  ]);
}

export async function readRadarEvidenceHash(env: RadarJobEnv, snapshotKey: string): Promise<string | undefined> {
  const value = await env.REPORT_CACHE?.get<RadarEvidenceSnapshotForFreshness>(snapshotKey, "json").catch(() => null);
  return stringValue(value?.evidenceHash) || undefined;
}

export async function readRadarEvidenceFreshness(env: RadarJobEnv, snapshotKey: string, expectedVersion: string): Promise<RadarEvidenceFreshness | null> {
  const value = await env.REPORT_CACHE?.get<RadarEvidenceSnapshotForFreshness>(snapshotKey, "json").catch(() => null);
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
  defaults: { repository: string; workflow: string },
) {
  const token = env.GITHUB_RADAR_DISPATCH_TOKEN?.trim();
  if (!token) throw new Error("missing GitHub radar dispatch token");
  const repository = env.GITHUB_RADAR_REPOSITORY?.trim() || defaults.repository;
  const workflow = env.GITHUB_RADAR_WORKFLOW?.trim() || defaults.workflow;
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
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
      inputs: { job_id: jobId },
    }),
  });
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
  };
}

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
