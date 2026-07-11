import { requireAdminSession, type AssistantEnv } from "../_shared/assistant-db";
import { ASSISTANT_DEEP_RESEARCH_QUEUE_NAME, type AssistantDeepResearchQueueMessage } from "../_shared/assistant-deep-research";
import { json } from "../_shared/user-research-db";
import { createValuationRun, listValuationRuns, readResearchItemById, valuationRunToSummary } from "../_shared/research-workbench-db";
import { routeValuationMethod } from "../_shared/valuation-engine";
import { isAshareResearchItem } from "./valuation-workspace";

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
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const researchItemId = normalizeRequiredText(body?.researchItemId);
  const entityType = body?.entityType === "company" ? "company" : null;
  const entityId = normalizeRequiredText(body?.entityId);
  const title = normalizeRequiredText(body?.title);
  const industry = normalizeOptionalText(body?.industry);
  const sector = normalizeOptionalText(body?.sector);
  const mainBusiness = normalizeOptionalText(body?.mainBusiness);
  const currency = normalizeOptionalText(body?.currency);
  const evidenceHash = normalizeOptionalText(body?.evidenceHash);
  if (!entityType) return json({ error: "仅支持已加入研究队列的 A 股公司。" }, 400);
  if (!entityId || !title) return json({ error: "缺少估值对象。" }, 400);
  if (!researchItemId) return json({ error: "仅支持已加入研究队列的 A 股公司。" }, 400);
  if (industry === null || sector === null || mainBusiness === null || currency === null || evidenceHash === null) {
    return json({ error: "估值对象数据无效。" }, 400);
  }
  const researchItem = await readResearchItemById(env.REPORT_LIBRARY_DB, session.userId, researchItemId);
  if (!researchItem || researchItem.entityId !== entityId || !isAshareResearchItem(researchItem)) {
    return json({ error: "仅支持已加入研究队列的 A 股公司。" }, 400);
  }
  const route = routeValuationMethod({ companyName: title, industry, sector, mainBusiness });
  const run = await createValuationRun(env.REPORT_LIBRARY_DB, {
    userKey: session.userId,
    researchItemId,
    entityType,
    entityId,
    title,
    archetype: route.archetype,
    method: route.method,
    currency: currency || "CNY",
    evidenceHash,
  });
  await env.ASSISTANT_DEEP_RESEARCH_QUEUE.send({ kind: "valuation", valuationRunId: run.id });
  return json({ run: valuationRunToSummary(run) }, 202);
};

function normalizeRequiredText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalText(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  return value.trim() || undefined;
}
