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

if (!token) throw new Error("WATCHLIST_RANKING_WORKER_TOKEN or TEMPLATE_ANALYSIS_WORKER_TOKEN is required.");
if (!jobId) throw new Error("WATCHLIST_RANKING_JOB_ID or --job-id is required.");

const payload = await readJob(jobId);
try {
  const generated = await requestWatchlistRankingScore({ DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }, payload.watchlist, payload.evidence);
  await completeJob({ jobId, generated, evidenceHash: payload.evidenceHash });
} catch (error) {
  await completeJob({ jobId, error: error instanceof Error ? error.message : "自选排行评分失败。", evidenceHash: payload.evidenceHash });
  throw error;
}

async function readJob(id: string): Promise<JobPayload> {
  const response = await fetch(`${endpoint}?jobId=${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Watchlist ranking job read failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
  return (await response.json()) as JobPayload;
}

async function completeJob(body: Record<string, unknown>) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Watchlist ranking completion failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
}
