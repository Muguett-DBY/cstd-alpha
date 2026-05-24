import type { AssistantUsage } from "./shared/assistant";

export function mergeAssistantDelta(current: string, delta: string) {
  return `${current}${delta}`;
}

export function assistantCacheHitRate(usage: AssistantUsage | undefined | null) {
  const hit = usage?.promptCacheHitTokens;
  const miss = usage?.promptCacheMissTokens;
  if (typeof hit !== "number" || typeof miss !== "number") return null;
  const total = hit + miss;
  if (total <= 0) return null;
  return Math.round((hit / total) * 100);
}
