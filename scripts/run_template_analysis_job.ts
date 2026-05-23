import { FULL_ANALYSIS_TEMPLATE_ID, type ResearchTemplate, type TemplateAnalysisResult } from "../src/shared/user-research";
import type { EvidenceBundle } from "../functions/_shared/providers";
import type { WatchlistRow } from "../functions/_shared/user-research-db";
import { requestTemplateReport } from "../functions/api/template-analysis";

type JobPayload = {
  job: { id: string; templateId: string };
  watchlist: WatchlistRow;
  template: ResearchTemplate;
  activeTemplates?: ResearchTemplate[];
  evidenceHash?: string;
  evidence: EvidenceBundle;
  childAnalyses?: TemplateAnalysisResult[];
};

type GeneratedResult = Awaited<ReturnType<typeof requestTemplateReport>>;

const endpoint = process.env.TEMPLATE_ANALYSIS_WORKER_URL || "https://alpha.custard.top/api/template-analysis-job";
const token = process.env.TEMPLATE_ANALYSIS_WORKER_TOKEN;
const jobId = process.env.TEMPLATE_ANALYSIS_JOB_ID || process.argv.find((arg) => arg.startsWith("--job-id="))?.slice("--job-id=".length);

if (!token) throw new Error("TEMPLATE_ANALYSIS_WORKER_TOKEN is required.");
if (!jobId) throw new Error("TEMPLATE_ANALYSIS_JOB_ID or --job-id is required.");

const payload = await readJob(jobId);
try {
  const childResults: Array<{ templateId: string; generated: GeneratedResult; markdown: string; evidenceHash?: string }> = [];
  let children = Array.isArray(payload.childAnalyses) ? payload.childAnalyses : [];

  if (payload.template.id === FULL_ANALYSIS_TEMPLATE_ID) {
    const activeTemplates = Array.isArray(payload.activeTemplates) ? payload.activeTemplates.filter((template) => template.enabled !== false) : [];
    const completedIds = new Set(children.filter((analysis) => analysis.status === "completed").map((analysis) => analysis.templateId));
    for (const childTemplate of activeTemplates) {
      if (completedIds.has(childTemplate.id)) continue;
      const generated = await requestTemplateReport(modelEnv(), payload.watchlist, payload.evidence, childTemplate, []);
      childResults.push({ templateId: childTemplate.id, generated, markdown: generated.markdown, evidenceHash: payload.evidenceHash });
      children = [
        ...children,
        {
          id: `${payload.job.id}:${childTemplate.id}`,
          userId: payload.watchlist.user_key,
          watchlistId: payload.watchlist.id,
          templateId: childTemplate.id,
          templateTitle: childTemplate.title,
          companyName: payload.watchlist.company_name,
          ticker: payload.watchlist.ticker,
          market: payload.watchlist.market,
          model: generated.modelUsed || "deepseek-v4-flash",
          status: "completed",
          title: generated.title,
          score: generated.score,
          verdict: generated.verdict,
          summary: generated.summary,
          markdown: generated.markdown,
          keyPoints: generated.keyPoints,
          riskFlags: generated.riskFlags,
          followUps: generated.followUps,
          sections: generated.sections,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } satisfies TemplateAnalysisResult,
      ];
    }
  }

  const generated = await requestTemplateReport(modelEnv(), payload.watchlist, payload.evidence, payload.template, children);
  await completeJob({ jobId, generated, markdown: generated.markdown, evidenceHash: payload.evidenceHash, childResults });
} catch (error) {
  await completeJob({ jobId, error: error instanceof Error ? error.message : "模板后台分析失败。", evidenceHash: payload.evidenceHash });
  throw error;
}

async function readJob(id: string): Promise<JobPayload> {
  const response = await fetch(`${endpoint}?jobId=${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Template job read failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
  return (await response.json()) as JobPayload;
}

async function completeJob(body: Record<string, unknown>) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Template job completion failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
}

function modelEnv() {
  return {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    ANYSEARCH_API_KEY: process.env.ANYSEARCH_API_KEY,
    SEARXNG_ENDPOINTS: process.env.SEARXNG_ENDPOINTS,
  } as never;
}
