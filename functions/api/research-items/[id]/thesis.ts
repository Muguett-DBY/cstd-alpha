import { requireAdminSession, type AssistantEnv } from "../../../_shared/assistant-db";
import { json } from "../../../_shared/user-research-db";
import {
  createResearchThesisVersion,
  listResearchThesisVersions,
  readCurrentResearchThesis,
  readResearchItemById,
} from "../../../_shared/research-workbench-db";
import { loadResearchThesisEvidence } from "../../../_shared/research-thesis-evidence";
import { requestResearchThesis } from "../../../_shared/research-thesis";

type Env = AssistantEnv;

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const itemId = String(params.id || "");
  const item = await readResearchItemById(env.REPORT_LIBRARY_DB, session.userId, itemId);
  if (!item) return json({ error: "Research item not found." }, 404);
  const [current, versions] = await Promise.all([
    readCurrentResearchThesis(env.REPORT_LIBRARY_DB, session.userId, itemId),
    listResearchThesisVersions(env.REPORT_LIBRARY_DB, session.userId, itemId, 12),
  ]);
  const visibleVersions = current && !versions.some((version) => version.id === current.id) ? [current, ...versions] : versions;
  return json({ current, versions: visibleVersions });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const itemId = String(params.id || "");
  const item = await readResearchItemById(env.REPORT_LIBRARY_DB, session.userId, itemId);
  if (!item) return json({ error: "Research item not found." }, 404);
  try {
    const evidence = await loadResearchThesisEvidence(env, session.userId, item, request.signal);
    const draft = await requestResearchThesis(env, { item, evidence }, request.signal);
    const thesis = await createResearchThesisVersion(env.REPORT_LIBRARY_DB, {
      userKey: session.userId,
      itemId,
      thesisMarkdown: draft.thesisMarkdown,
      coreCitations: draft.coreCitations,
      counterEvidence: draft.counterEvidence,
      evidenceHash: evidence.evidenceHash,
      createdBy: "ai",
    });
    const updatedItem = await readResearchItemById(env.REPORT_LIBRARY_DB, session.userId, itemId);
    return json({ thesis, item: updatedItem });
  } catch (error) {
    console.warn("research_thesis_generation_failed", {
      itemId,
      message: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    });
    return json({ error: "论点生成失败，已保留当前版本，请稍后重试。" }, 502);
  }
};
