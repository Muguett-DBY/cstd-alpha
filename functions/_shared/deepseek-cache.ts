export type DeepSeekMessage = { role: "system" | "user"; content: string };

export type DeepSeekRequestOptions = {
  model: string;
  messages: DeepSeekMessage[];
  maxTokens: number;
  reasoningEffort?: "high" | "max";
  temperature?: number;
  responseFormat?: { type: "json_object" };
  stream?: boolean;
  thinking?: { type: "enabled"; budget_tokens?: number };
};

export const DEEPSEEK_CACHE_PROTOCOL = "CSTD_ALPHA_DEEPSEEK_CACHE_PROTOCOL_V1";

export function cacheStableUserContent({
  kind,
  stable,
  volatile,
}: {
  kind: string;
  stable: unknown;
  volatile?: unknown;
}) {
  return JSON.stringify({
    cacheProtocol: DEEPSEEK_CACHE_PROTOCOL,
    cacheKind: kind,
    ...(isPlainRecord(stable) ? stableTopLevelRecord(stable) : { stableContext: stableJsonValue(stable) }),
    ...(isPlainRecord(volatile) ? stableTopLevelRecord(volatile) : { volatileContext: stableJsonValue(volatile ?? {}) }),
  });
}

export function withCacheProtocol(systemPrompt: string, kind: string) {
  return [
    systemPrompt.trim(),
    "",
    "## Cache-stability protocol",
    `${DEEPSEEK_CACHE_PROTOCOL}; task=${kind}.`,
    "Stable rules and output schemas are kept before volatile company, market, evidence, and timestamp data.",
  ].join("\n");
}

export function stableJsonStringify(value: unknown) {
  return JSON.stringify(stableJsonValue(value));
}

export function buildDeepSeekRequestBody({
  model,
  messages,
  maxTokens,
  reasoningEffort,
  temperature = 0.1,
  responseFormat = { type: "json_object" as const },
  stream = false,
  thinking,
}: DeepSeekRequestOptions) {
  return {
    model,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(thinking ? { thinking } : {}),
    response_format: responseFormat,
    stream,
    temperature,
    max_tokens: maxTokens,
    messages,
  };
}

export function buildDeepSeekRequestInit({
  apiKey,
  signal,
  ...bodyOptions
}: DeepSeekRequestOptions & {
  apiKey?: string;
  signal?: AbortSignal;
}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal,
    body: JSON.stringify(buildDeepSeekRequestBody(bodyOptions)),
  };
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isPlainRecord(value)) return value;
  return stableJsonRecord(value);
}

function stableJsonRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
}

function stableTopLevelRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(value).map((key) => [key, stableJsonValue(value[key])]));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
