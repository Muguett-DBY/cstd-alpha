import type { AssistantEnv } from "./assistant-db";
import { buildDeepSeekFallbackRoutes } from "../../_shared/opencode-go";

export const onRequestGet: PagesFunction<AssistantEnv> = async ({ env }) => {
  const routes = buildDeepSeekFallbackRoutes(env);
  const results = [];
  for (const route of routes) {
    try {
      const body = { model: route.model, messages: [{ role: "user", content: "hi" }], max_tokens: 10, ...(route.isFree ? { thinking: { type: "enabled" } } : { reasoning_effort: "max" }) };
      const res = await fetch(route.url, { method: "POST", headers: { "content-type": "application/json", ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) }, body: JSON.stringify(body) });
      const text = await res.text();
      results.push({ provider: route.provider, status: res.status, ok: res.ok, body: text.slice(0, 200) });
    } catch (e) {
      results.push({ provider: route.provider, error: String(e).slice(0, 200) });
    }
  }
  return new Response(JSON.stringify({ goKeyLen: env.OPENCODE_GO_API_KEY?.length ?? 0, apiKeyLen: env.OPENCODE_API_KEY?.length ?? 0, results }), { headers: { "content-type": "application/json" } });
};
