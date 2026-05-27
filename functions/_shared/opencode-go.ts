export const OPENCODE_GO_CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/v1/chat/completions";
export const OPENCODE_GO_DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
export const OPENCODE_GO_DEEPSEEK_REASONING_EFFORT = "max";

export type OpenCodeGoEnv = {
  OPENCODE_API_KEY?: string;
};

export function requireOpenCodeGoApiKey(env: OpenCodeGoEnv, featureName: string) {
  const apiKey = env.OPENCODE_API_KEY?.trim();
  if (!apiKey) throw new Error(`OPENCODE_API_KEY is not configured for ${featureName}.`);
  return apiKey;
}
