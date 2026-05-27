import type { AssistantEnv } from "./assistant-db";
import { buildDeepSeekFallbackRoutes } from "../../_shared/opencode-go";

export const onRequestGet: PagesFunction<AssistantEnv> = async ({ env }) => {
  const routes = buildDeepSeekFallbackRoutes(env);
  return new Response(JSON.stringify({
    routes: routes.map((r) => ({ provider: r.provider, model: r.model, isFree: r.isFree, hasKey: !!r.apiKey })),
    envKeys: Object.keys(env).filter((k) => k.includes("OPENCODE") || k.includes("DEEPSEEK")),
  }), { headers: { "content-type": "application/json" } });
};
