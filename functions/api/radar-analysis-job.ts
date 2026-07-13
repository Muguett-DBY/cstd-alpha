import type { RadarAnalysisJob, RadarTokenUsage } from "../../src/shared/radar";
import {
  RADAR_ANALYSIS_JOB_LATEST_KEY,
  RADAR_ANALYSIS_JOB_PREFIX,
  RADAR_RESULT_CACHE_KEY,
  abortRadarAnalysisJobRun,
  claimRadarAnalysisJobFailure,
  claimRadarAnalysisJobPublication,
  completeRadarAnalysisJobRun,
  finishRadarAnalysisJobFailure,
  normalizeRadarTokenUsage,
  startRadarAnalysisJobRun,
  writeRadarJob,
} from "../_shared/radar-jobs";
import { json } from "../_shared/user-research-db";

type Env = {
  RADAR_ANALYSIS_WORKER_TOKEN?: string;
  TEMPLATE_ANALYSIS_WORKER_TOKEN?: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_CACHE?: KVNamespace;
};

type CallbackBody = {
  action?: unknown;
  jobId?: unknown;
  runToken?: unknown;
  radarCache?: unknown;
  job?: unknown;
  error?: unknown;
};

type RadarCacheInput = {
  version: "v2";
  cachedAt: string;
  radar: Record<string, unknown> & { id: string; generatedAt: string };
};

const FAILED_MESSAGE = "本次刷新失败，已保留上次扫描。";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireWorkerAuth(request, env);
  if (auth) return auth;
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_CACHE) return json({ error: "REPORT_LIBRARY_DB/REPORT_CACHE is not configured." }, 500);
  const runtimeEnv = { REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB, REPORT_CACHE: env.REPORT_CACHE };

  const body = ((await request.json().catch(() => null)) as CallbackBody | null) ?? {};
  const action = stringValue(body.action);
  const jobId = stringValue(body.jobId);
  const runToken = stringValue(body.runToken);
  if (!isValidJobId(jobId) || !isValidRunToken(runToken)) return json({ error: "雷达任务标识无效。" }, 400);

  if (action === "start") return startJob(runtimeEnv, jobId, runToken);
  if (action === "complete") return completeJob(runtimeEnv, jobId, runToken, body);
  if (action === "fail") return failJob(runtimeEnv, jobId, runToken);
  return json({ error: "雷达任务操作无效。" }, 400);
};

async function startJob(env: Required<Pick<Env, "REPORT_LIBRARY_DB" | "REPORT_CACHE">>, jobId: string, runToken: string) {
  const run = await startRadarAnalysisJobRun(env.REPORT_LIBRARY_DB, jobId, runToken);
  if (!run) return staleRunResponse();
  try {
    await writeRadarJob(env, run.job, RADAR_ANALYSIS_JOB_PREFIX, RADAR_ANALYSIS_JOB_LATEST_KEY);
    return json({ job: run.job });
  } catch {
    await abortRadarAnalysisJobRun(env.REPORT_LIBRARY_DB, jobId, runToken, FAILED_MESSAGE);
    return json({ error: "雷达任务状态发布失败。" }, 500);
  }
}

async function completeJob(
  env: Required<Pick<Env, "REPORT_LIBRARY_DB" | "REPORT_CACHE">>,
  jobId: string,
  runToken: string,
  body: CallbackBody,
) {
  const radarCache = parseRadarCache(body.radarCache);
  const completedInput = parseCompletedJob(body.job, jobId, radarCache?.radar.generatedAt);
  if (!radarCache || !completedInput) return json({ error: "雷达分析结果无效。" }, 422);

  const run = await claimRadarAnalysisJobPublication(env.REPORT_LIBRARY_DB, jobId, runToken);
  if (!run) return staleRunResponse();
  const completedAt = new Date().toISOString();
  const completedJob: RadarAnalysisJob = {
    ...run.job,
    status: "completed",
    updatedAt: completedAt,
    message: "后台深度分析完成。",
    radarGeneratedAt: radarCache.radar.generatedAt,
    ...(completedInput.tokenUsage ? { tokenUsage: completedInput.tokenUsage } : {}),
  };

  try {
    const writes = await Promise.allSettled([
      env.REPORT_CACHE.put(RADAR_RESULT_CACHE_KEY, JSON.stringify(radarCache)),
      writeRadarJob(env, completedJob, RADAR_ANALYSIS_JOB_PREFIX, RADAR_ANALYSIS_JOB_LATEST_KEY),
    ]);
    const writeFailure = writes.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (writeFailure) throw writeFailure.reason;
    const completed = await completeRadarAnalysisJobRun(env.REPORT_LIBRARY_DB, jobId, runToken, {
      radarGeneratedAt: radarCache.radar.generatedAt,
      tokenUsage: completedInput.tokenUsage,
    });
    if (!completed) return staleRunResponse();
    return json({ job: completedJob });
  } catch {
    await abortRadarAnalysisJobRun(env.REPORT_LIBRARY_DB, jobId, runToken, FAILED_MESSAGE);
    return json({ error: "雷达分析结果发布失败。" }, 500);
  }
}

async function failJob(env: Required<Pick<Env, "REPORT_LIBRARY_DB" | "REPORT_CACHE">>, jobId: string, runToken: string) {
  const run = await claimRadarAnalysisJobFailure(env.REPORT_LIBRARY_DB, jobId, runToken);
  if (!run) return staleRunResponse();
  const failedAt = new Date().toISOString();
  const failedJob: RadarAnalysisJob = {
    ...run.job,
    status: "failed",
    updatedAt: failedAt,
    message: FAILED_MESSAGE,
  };
  try {
    await writeRadarJob(env, failedJob, RADAR_ANALYSIS_JOB_PREFIX, RADAR_ANALYSIS_JOB_LATEST_KEY);
    const finished = await finishRadarAnalysisJobFailure(env.REPORT_LIBRARY_DB, jobId, runToken, FAILED_MESSAGE);
    return finished ? json({ job: failedJob }) : staleRunResponse();
  } catch {
    await abortRadarAnalysisJobRun(env.REPORT_LIBRARY_DB, jobId, runToken, FAILED_MESSAGE);
    return json({ error: "雷达任务失败状态发布失败。" }, 500);
  }
}

function parseRadarCache(value: unknown): RadarCacheInput | null {
  if (!isPlainRecord(value) || value.version !== "v2" || !isIsoDate(value.cachedAt) || !isPlainRecord(value.radar)) return null;
  const id = stringValue(value.radar.id);
  const generatedAt = stringValue(value.radar.generatedAt);
  if (!id || !isIsoDate(generatedAt)) return null;
  return { version: "v2", cachedAt: value.cachedAt as string, radar: { ...value.radar, id, generatedAt } };
}

function parseCompletedJob(value: unknown, jobId: string, radarGeneratedAt?: string) {
  if (!isPlainRecord(value) || stringValue(value.id) !== jobId || value.status !== "completed") return null;
  if (!radarGeneratedAt || stringValue(value.radarGeneratedAt) !== radarGeneratedAt) return null;
  const tokenUsage = value.tokenUsage === undefined ? undefined : normalizeRadarTokenUsage(value.tokenUsage);
  if (value.tokenUsage !== undefined && !tokenUsage) return null;
  return { tokenUsage } satisfies { tokenUsage?: RadarTokenUsage };
}

function requireWorkerAuth(request: Request, env: Env) {
  const expected = env.RADAR_ANALYSIS_WORKER_TOKEN?.trim() || env.TEMPLATE_ANALYSIS_WORKER_TOKEN?.trim();
  if (!expected) return json({ error: "RADAR_ANALYSIS_WORKER_TOKEN is not configured." }, 500);
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return actual && actual === expected ? null : json({ error: "Unauthorized." }, 401);
}

function staleRunResponse() {
  return json({ error: "雷达任务运行已更新，本次回调已忽略。" }, 409);
}

function isValidJobId(value: string) {
  return /^radar-\d{10,16}-[0-9a-f]{8}$/i.test(value);
}

function isValidRunToken(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
