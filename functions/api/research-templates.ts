import {
  ensureUserResearchSchema,
  json,
  readUserResearchTemplates,
  requireUserSession,
  resetTemplatesToDefault,
  saveCurrentTemplatesAsDefault,
  saveUserResearchTemplates,
} from "../_shared/user-research-db";
import { isResearchTemplate } from "../../src/shared/user-research";

type Env = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);
  return json({ templates: await readUserResearchTemplates(env.REPORT_LIBRARY_DB, session.userId) });
};

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);
  const body = (await request.json().catch(() => null)) as { templates?: unknown } | null;
  if (!Array.isArray(body?.templates)) return json({ error: "缺少模板列表。" }, 400);
  if (!body.templates.every(isResearchTemplate)) return json({ error: "模板列表包含无效模板。" }, 400);
  return json({ templates: await saveUserResearchTemplates(env.REPORT_LIBRARY_DB, session.userId, body.templates) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureUserResearchSchema(env.REPORT_LIBRARY_DB);
  const body = (await request.json().catch(() => null)) as { action?: string } | null;
  if (body?.action === "save-defaults") return json({ templates: await saveCurrentTemplatesAsDefault(env.REPORT_LIBRARY_DB, session.userId) });
  if (body?.action === "reset-defaults") return json({ templates: await resetTemplatesToDefault(env.REPORT_LIBRARY_DB, session.userId) });
  return json({ error: "未知模板操作。" }, 400);
};
