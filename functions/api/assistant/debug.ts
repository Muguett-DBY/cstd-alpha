import type { AssistantEnv } from "./assistant-db";
import { buildDeepSeekFallbackRoutes } from "../../_shared/opencode-go";

export const onRequestGet: PagesFunction<AssistantEnv> = async ({ env }) => {
  const routes = buildDeepSeekFallbackRoutes(env);
  return new Response(JSON.stringify({
    routes: routes.map((r) => ({ provider: r.provider, model: r.model, isFree: r.isFree, hasKey: !!r.apiKey })),
    envKeys: Object.keys(env).filter((k) => k.includes("OPENCODE") || k.includes("DEEPSEEK")),
    openCodeGoKeyLen: env.OPENCODE_GO_API_KEY?.length ?? 0,
    openCodeApiKeyLen: env.OPENCODE_API_KEY?.length ?? 0,
    openCodeZenKeyLen: env.OPENCODE_ZEN_API_KEY?.length ?? 0,
    deepseekKeyLen: env.DEEPSEEK_API_KEY?.length ?? 0,
  }), { headers: { "content-type": "application/json" } });
};
