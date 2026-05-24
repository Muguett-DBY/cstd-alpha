export type AssistantRole = "user" | "assistant" | "system";

export type AssistantMessage = {
  id: string;
  threadId: string;
  role: AssistantRole;
  content: string;
  createdAt: string;
  metadata?: AssistantMessageMetadata;
};

export type AssistantMessageMetadata = {
  evidenceRefs?: AssistantEvidenceRef[];
  usage?: AssistantUsage;
  toolRuns?: AssistantToolRun[];
};

export type AssistantEvidenceRef = {
  id: string;
  title: string;
  sourceType: string;
  url?: string;
  excerpt?: string;
};

export type AssistantToolRun = {
  id: string;
  toolName: string;
  status: "completed" | "failed" | "skipped";
  summary: string;
  createdAt: string;
};

export type AssistantUsage = {
  model: string;
  reasoningEffort: "high" | "max";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  elapsedMs?: number;
};

export type AssistantMemory = {
  id: string;
  content: string;
  category: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

export type AssistantMemoryCandidate = {
  id: string;
  content: string;
  category: string;
  reason: string;
  status: "pending" | "confirmed" | "rejected";
  createdAt: string;
};

export type AssistantThread = {
  id: string;
  title: string;
  summary: string;
  updatedAt: string;
  messages: AssistantMessage[];
  memories: AssistantMemory[];
  memoryCandidates: AssistantMemoryCandidate[];
  latestUsage?: AssistantUsage;
};

export type AssistantChatRequest = {
  message: string;
  threadId?: string;
};

export type AssistantChatStreamEvent =
  | { type: "start"; threadId: string; messageId: string }
  | { type: "delta"; text: string }
  | { type: "memory_candidate"; candidate: AssistantMemoryCandidate }
  | { type: "usage"; usage: AssistantUsage }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; error: string };
