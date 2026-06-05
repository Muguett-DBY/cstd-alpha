import { requireAdminSession, type AssistantEnv } from "../_shared/assistant-db";
import { ASSISTANT_DEEP_RESEARCH_QUEUE_NAME, type AssistantDeepResearchQueueMessage } from "../_shared/assistant-deep-research";
import { json } from "../_shared/user-research-db";
import { createValuationRun, listValuationRuns, valuationRunToSummary } from "../_shared/research-workbench-db";
import { routeValuationMethod } from "../_shared/valuation-engine";
import type { ResearchEntityType } from "../../src/shared/research-workbench";

type Env = AssistantEnv & {
  REPORT_LIBRARY_DB?: D1Database;
  ASSISTANT_DEEP_RESEARCH_QUEUE?: Queue<AssistantDeepResearchQueueMessage>;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const runs = await listValuationRuns(env.REPORT_LIBRARY_DB, session.userId, 40);
  return json({ runs: runs.map(valuationRunToSummary) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  if (!env.ASSISTANT_DEEP_RESEARCH_QUEUE) return json({ error: `${ASSISTANT_DEEP_RESEARCH_QUEUE_NAME} is not configured.` }, 500);
  const body = (await request.json().catch(() => null)) as {
    researchItemId?: string;
    entityType?: ResearchEntityType;
    entityId?: string;
    title?: string;
    industry?: string;
    sector?: string;
    mainBusiness?: string;
    currency?: string;
    evidenceHash?: string;
  } | null;
  if (body?.entityType !== "company" && body?.entityType !== "industry") return json({ error: "entityType must be company or industry." }, 400);
  if (!body.entityId?.trim() || !body.title?.trim()) return json({ error: "缺少估值对象。" }, 400);
  const route = routeValuationMethod({ companyName: body.title, industry: body.industry, sector: body.sector, mainBusiness: body.mainBusiness });
  const run = await createValuationRun(env.REPORT_LIBRARY_DB, {
    userKey: session.userId,
    researchItemId: body.researchItemId?.trim(),
    entityType: body.entityType,
    entityId: body.entityId.trim(),
    title: body.title.trim(),
    archetype: route.archetype,
    method: route.method,
    currency: body.currency?.trim() || "CNY",
    evidenceHash: body.evidenceHash?.trim(),
  });
  await env.ASSISTANT_DEEP_RESEARCH_QUEUE.send({ kind: "valuation", valuationRunId: run.id });
  return json({ run: valuationRunToSummary(run) }, 202);
};
