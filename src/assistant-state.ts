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

export function stripInternalAssistantCompletion(text: string) {
  const marker = "系统补全：";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return text;
  const beforeMarker = text.slice(0, markerIndex);
  return beforeMarker
    .replace(/\n-{3,}\s*$/m, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
