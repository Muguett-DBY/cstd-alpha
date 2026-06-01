export const OPENCODE_ZEN_CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/v1/chat/completions" as const;
export const OPENCODE_ZEN_FREE_DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash-free" as const;
export const OPENCODE_GO_CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/go/v1/chat/completions" as const;
export const OPENCODE_GO_DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash" as const;
export const OPENCODE_GO_DEEPSEEK_REASONING_EFFORT = "max" as const;

export type DeepSeekFallbackModel = typeof OPENCODE_ZEN_FREE_DEEPSEEK_FLASH_MODEL | typeof OPENCODE_GO_DEEPSEEK_FLASH_MODEL;
export type DeepSeekFallbackProvider = "opencode-zen-free" | "opencode-go";
export type DeepSeekFallbackRoute = {
  model: DeepSeekFallbackModel;
  url: string;
  apiKey?: string;
  isFree: boolean;
  provider: DeepSeekFallbackProvider;
};

export type DeepSeekFallbackEnv = {
  OPENCODE_ZEN_API_KEY?: string;
  OPENCODE_GO_API_KEY?: string;
  OPENCODE_API_KEY?: string;
};

export type OpenCodeGoEnv = Pick<DeepSeekFallbackEnv, "OPENCODE_API_KEY" | "OPENCODE_GO_API_KEY">;

export function buildDeepSeekFallbackRoutes(env: DeepSeekFallbackEnv): DeepSeekFallbackRoute[] {
  const zenKey = cleanKey(env.OPENCODE_ZEN_API_KEY);
  const goKey = cleanKey(env.OPENCODE_GO_API_KEY) || cleanKey(env.OPENCODE_API_KEY);
  return [
    ...(goKey
      ? [
          {
            model: OPENCODE_GO_DEEPSEEK_FLASH_MODEL,
            url: OPENCODE_GO_CHAT_COMPLETIONS_URL,
            apiKey: goKey,
            isFree: false,
            provider: "opencode-go" as const,
          },
        ]
      : []),
    {
      model: OPENCODE_ZEN_FREE_DEEPSEEK_FLASH_MODEL,
      url: OPENCODE_ZEN_CHAT_COMPLETIONS_URL,
      apiKey: zenKey,
      isFree: true,
      provider: "opencode-zen-free",
    },
  ];
}

export function requireDeepSeekFallbackRoutes(env: DeepSeekFallbackEnv, featureName: string) {
  const routes = buildDeepSeekFallbackRoutes(env);
  if (!routes.length) throw new Error(`No DeepSeek-compatible route is configured for ${featureName}.`);
  return routes;
}

export function requireOpenCodeGoApiKey(env: OpenCodeGoEnv, featureName: string) {
  const apiKey = cleanKey(env.OPENCODE_GO_API_KEY) || cleanKey(env.OPENCODE_API_KEY);
  if (!apiKey) throw new Error(`OPENCODE_API_KEY is not configured for ${featureName}.`);
  return apiKey;
}

function cleanKey(value: string | undefined) {
  return value?.trim() || undefined;
}
