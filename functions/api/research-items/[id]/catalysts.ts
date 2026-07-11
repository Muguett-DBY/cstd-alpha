import { requireAdminSession, type AssistantEnv } from "../../../_shared/assistant-db";
import { json } from "../../../_shared/user-research-db";
import {
  listResearchCatalysts,
  readCurrentResearchThesis,
  readResearchItemById,
  updateResearchCatalystStatus,
  upsertResearchCatalystDrafts,
} from "../../../_shared/research-workbench-db";
import { extractCatalystDraftsFromThesis, RESEARCH_CATALYST_STATUSES, type ResearchCatalystStatus } from "../../../../src/shared/research-workbench";

type Env = AssistantEnv;

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const itemId = String(params.id || "");
  const item = await readResearchItemById(env.REPORT_LIBRARY_DB, session.userId, itemId);
  if (!item) return json({ error: "Research item not found." }, 404);
  const catalysts = await listResearchCatalysts(env.REPORT_LIBRARY_DB, session.userId, itemId);
  return json({ catalysts });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const itemId = String(params.id || "");
  const item = await readResearchItemById(env.REPORT_LIBRARY_DB, session.userId, itemId);
  if (!item) return json({ error: "Research item not found." }, 404);
  const thesis = await readCurrentResearchThesis(env.REPORT_LIBRARY_DB, session.userId, itemId);
  if (!thesis) return json({ error: "请先生成研究论点，再同步跟踪项。" }, 400);
  const drafts = extractCatalystDraftsFromThesis(thesis.thesisMarkdown, thesis.coreCitations);
  if (!drafts.length) return json({ error: "当前论点没有可同步的催化剂、反证或跟踪清单。" }, 400);
  const catalysts = await upsertResearchCatalystDrafts(env.REPORT_LIBRARY_DB, {
    userKey: session.userId,
    itemId,
    drafts,
  });
  return json({ catalysts, created: drafts.length });
};

export const onRequestPatch: PagesFunction<Env> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const itemId = String(params.id || "");
  const item = await readResearchItemById(env.REPORT_LIBRARY_DB, session.userId, itemId);
  if (!item) return json({ error: "Research item not found." }, 404);
  const body = await request.json().catch(() => null) as { catalystId?: unknown; status?: unknown } | null;
  const catalystId = typeof body?.catalystId === "string" ? body.catalystId.trim() : "";
  const status = normalizeCatalystStatus(body?.status);
  if (!catalystId || !status) return json({ error: "跟踪项状态数据无效。" }, 400);
  try {
    const catalyst = await updateResearchCatalystStatus(env.REPORT_LIBRARY_DB, {
      userKey: session.userId,
      itemId,
      catalystId,
      status,
    });
    if (!catalyst) return json({ error: "Research catalyst not found." }, 404);
    return json({ catalyst });
  } catch (error) {
    const message = error instanceof Error ? error.message : "研究跟踪项状态更新失败。";
    return json({ error: message === "invalid research catalyst status" ? "不支持的跟踪项状态。" : message }, 400);
  }
};

function normalizeCatalystStatus(value: unknown): ResearchCatalystStatus | null {
  return RESEARCH_CATALYST_STATUSES.includes(value as ResearchCatalystStatus) ? value as ResearchCatalystStatus : null;
}
