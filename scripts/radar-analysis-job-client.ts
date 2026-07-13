import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

type ClientOptions = {
  endpoint: string;
  token: string;
  jobId: string;
  runToken: string;
};

type CallbackResult = { stale: boolean; message?: string };

export async function startRadarAnalysisJob(options: ClientOptions): Promise<CallbackResult> {
  return requestCallback({ action: "start", jobId: options.jobId, runToken: options.runToken }, options);
}

export async function completeRadarAnalysisJob(
  payload: { radarCache: unknown; job: unknown },
  options: ClientOptions,
): Promise<CallbackResult> {
  return requestCallback({ action: "complete", jobId: options.jobId, runToken: options.runToken, ...payload }, options);
}

export async function failRadarAnalysisJob(options: ClientOptions): Promise<CallbackResult> {
  return requestCallback({ action: "fail", jobId: options.jobId, runToken: options.runToken }, options);
}

async function requestCallback(body: Record<string, unknown>, options: ClientOptions): Promise<CallbackResult> {
  const response = await fetch(options.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = (await response.text()).slice(0, 1000);
  if (response.status === 409) return { stale: true, message: text };
  if (!response.ok) throw new Error(`Radar analysis job callback failed: ${response.status} ${text}`);
  return { stale: false };
}

async function main() {
  const action = process.argv[2];
  const options = clientOptions();
  if (action === "start") {
    const result = await startRadarAnalysisJob(options);
    await writeGithubOutput("current", !result.stale);
    if (result.stale) console.log(`Radar job ${options.jobId} was superseded before start.`);
    return;
  }
  if (action === "complete") {
    const radarPath = argumentValue("--radar");
    const jobPath = argumentValue("--job");
    if (!radarPath || !jobPath) throw new Error("complete requires --radar and --job JSON paths");
    const [radarCache, job] = await Promise.all([readJson(radarPath), readJson(jobPath)]);
    const result = await completeRadarAnalysisJob({ radarCache, job }, options);
    await writeGithubOutput("published", !result.stale);
    if (result.stale) console.log(`Radar job ${options.jobId} completed after it was superseded; result skipped.`);
    return;
  }
  if (action === "fail") {
    const result = await failRadarAnalysisJob(options);
    if (result.stale) console.log(`Radar job ${options.jobId} failure was superseded; status skipped.`);
    return;
  }
  throw new Error("Use start, complete, or fail.");
}

function clientOptions(): ClientOptions {
  const endpoint = process.env.RADAR_ANALYSIS_WORKER_URL?.trim() || "https://alpha.custard.top/api/radar-analysis-job";
  const token = process.env.RADAR_ANALYSIS_WORKER_TOKEN?.trim() || process.env.TEMPLATE_ANALYSIS_WORKER_TOKEN?.trim();
  const jobId = process.env.RADAR_JOB_ID?.trim();
  const runToken = process.env.RADAR_ANALYSIS_RUN_TOKEN?.trim();
  if (!token) throw new Error("RADAR_ANALYSIS_WORKER_TOKEN or TEMPLATE_ANALYSIS_WORKER_TOKEN is required.");
  if (!jobId) throw new Error("RADAR_JOB_ID is required.");
  if (!runToken) throw new Error("RADAR_ANALYSIS_RUN_TOKEN is required.");
  return { endpoint, token, jobId, runToken };
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function argumentValue(name: string) {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function writeGithubOutput(name: string, value: boolean) {
  const path = process.env.GITHUB_OUTPUT;
  if (path) await appendFile(path, `${name}=${value}\n`, "utf8");
}

function isCliEntry() {
  return Boolean(process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url);
}

if (isCliEntry()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
