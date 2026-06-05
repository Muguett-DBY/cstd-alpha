import { requireAdminSession, type AssistantEnv } from "../../_shared/assistant-db";
import { json } from "../../_shared/user-research-db";
import { readValuationRun, valuationRunToSummary } from "../../_shared/research-workbench-db";

type Env = AssistantEnv & {
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  const run = await readValuationRun(env.REPORT_LIBRARY_DB, session.userId, String(params.id || ""));
  return run ? json({ run: valuationRunToSummary(run) }) : json({ error: "Valuation run not found." }, 404);
};
