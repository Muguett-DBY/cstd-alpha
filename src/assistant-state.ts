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
  const withoutAppendix = markerIndex >= 0 ? text.slice(0, markerIndex) : text;
  if (isLegacyInternalFallbackOnly(withoutAppendix)) return "";
  return withoutAppendix
    .replace(/\n-{3,}\s*$/m, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isLegacyInternalFallbackOnly(text: string) {
  return (
    /当前应输出低置信判断/.test(text) &&
    /可用证据只够形成方向性判断/.test(text) &&
    /补公司公告、财务指标、行业价格\/销量\/库存\/订单/.test(text)
  );
}
