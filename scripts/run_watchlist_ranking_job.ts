import type { EvidenceBundle } from "../functions/_shared/providers";
import type { WatchlistRow } from "../functions/_shared/user-research-db";
import { requestWatchlistRankingScore } from "../functions/_shared/watchlist-ranking";

type JobPayload = {
  job: { id: string };
  watchlist: WatchlistRow;
  evidenceHash?: string;
  evidence: EvidenceBundle;
};

const endpoint = process.env.WATCHLIST_RANKING_WORKER_URL || "https://alpha.custard.top/api/watchlist-ranking-job";
const token = process.env.WATCHLIST_RANKING_WORKER_TOKEN || process.env.TEMPLATE_ANALYSIS_WORKER_TOKEN;
const jobId = process.env.WATCHLIST_RANKING_JOB_ID || process.argv.find((arg) => arg.startsWith("--job-id="))?.slice("--job-id=".length);

if (isCliEntry()) await runWatchlistRankingJob({ endpoint, token, jobId });

export async function runWatchlistRankingJob(input: { endpoint: string; token?: string; jobId?: string }) {
  if (!input.token) throw new Error("WATCHLIST_RANKING_WORKER_TOKEN or TEMPLATE_ANALYSIS_WORKER_TOKEN is required.");
  if (!input.jobId) throw new Error("WATCHLIST_RANKING_JOB_ID or --job-id is required.");
  let payload: JobPayload;
  try {
    payload = await readJob(input.jobId, input);
  } catch (error) {
    if (error instanceof StaleWatchlistRankingJobError) {
      console.warn(error.message);
      return;
    }
    throw error;
  }
  try {
    const generated = await requestWatchlistRankingScore(
      {
        OPENCODE_ZEN_API_KEY: process.env.OPENCODE_ZEN_API_KEY,
        OPENCODE_GO_API_KEY: process.env.OPENCODE_GO_API_KEY,
      },
      payload.watchlist,
      payload.evidence,
    );
    const completed = await completeJob({ jobId: input.jobId, generated, evidenceHash: payload.evidenceHash }, input);
    if (completed.stale) console.warn(`Watchlist ranking job skipped: ${completed.message}`);
  } catch (error) {
    const completed = await completeJob({ jobId: input.jobId, error: error instanceof Error ? error.message : "自选排行评分失败。", evidenceHash: payload.evidenceHash }, input);
    if (completed.stale) {
      console.warn(`Watchlist ranking job skipped: ${completed.message}`);
      return;
    }
    throw error;
  }
}

export async function readJob(id: string, options: { endpoint: string; token?: string }): Promise<JobPayload> {
  const response = await fetch(`${options.endpoint}?jobId=${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${options.token}` },
  });
  if (response.status === 404) throw new StaleWatchlistRankingJobError((await response.text()).slice(0, 500));
  if (!response.ok) throw new Error(`Watchlist ranking job read failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
  return (await response.json()) as JobPayload;
}

export async function completeJob(body: Record<string, unknown>, options: { endpoint: string; token?: string }): Promise<{ stale: boolean; message?: string }> {
  const response = await fetch(options.endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 404) {
    const text = (await response.text()).slice(0, 500);
    if (text.includes("自选股不存在") || text.includes("not found")) return { stale: true, message: text };
    throw new Error(`Watchlist ranking completion failed: ${response.status} ${text}`);
  }
  if (!response.ok) throw new Error(`Watchlist ranking completion failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
  return { stale: false };
}

export class StaleWatchlistRankingJobError extends Error {
  constructor(message: string) {
    super(`Watchlist ranking job is stale: ${message}`);
    this.name = "StaleWatchlistRankingJobError";
  }
}

function isCliEntry() {
  const entry = process.argv[1]?.replace(/\\/g, "/");
  return Boolean(entry && import.meta.url.endsWith(entry.split("/").pop() ?? ""));
}
