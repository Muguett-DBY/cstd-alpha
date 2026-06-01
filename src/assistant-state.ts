import type { AssistantDeepResearchJob, AssistantUsage } from "./shared/assistant";

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

export function mergeAssistantDeepResearchJobs(
  current: Record<string, AssistantDeepResearchJob>,
  incoming: Iterable<AssistantDeepResearchJob | null | undefined>,
) {
  const next = { ...current };
  for (const job of incoming) {
    if (!job) continue;
    next[job.id] = pickAssistantDeepResearchJob(next[job.id], job);
  }
  return next;
}

function pickAssistantDeepResearchJob(current: AssistantDeepResearchJob | undefined, incoming: AssistantDeepResearchJob) {
  if (!current) return incoming;
  const currentRank = assistantDeepResearchStatusRank(current.status);
  const incomingRank = assistantDeepResearchStatusRank(incoming.status);
  if (incomingRank > currentRank) return incoming;
  if (incomingRank < currentRank) return current;
  return Date.parse(incoming.updatedAt || "") >= Date.parse(current.updatedAt || "") ? incoming : current;
}

function assistantDeepResearchStatusRank(status: AssistantDeepResearchJob["status"]) {
  if (status === "queued") return 1;
  if (status === "running") return 2;
  if (status === "stopping") return 3;
  return 4;
}

function isLegacyInternalFallbackOnly(text: string) {
  return (
    /当前应输出低置信判断/.test(text) &&
    /可用证据只够形成方向性判断/.test(text) &&
    /补公司公告、财务指标、行业价格\/销量\/库存\/订单/.test(text)
  );
}
