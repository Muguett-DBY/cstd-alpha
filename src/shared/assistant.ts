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
  blocks?: AssistantBlock[];
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

export type AssistantTextBlock = {
  id: string;
  type: "text";
  title?: string;
  text: string;
};

export type AssistantTableBlock = {
  id: string;
  type: "table";
  title?: string;
  columns: string[];
  rows: string[][];
};

export type AssistantChartBlock = {
  id: string;
  type: "chart";
  title?: string;
  chartType: "bar" | "line" | "scatter";
  labels: string[];
  series: Array<{ name: string; data: number[] }>;
};

export type AssistantBlock = AssistantTextBlock | AssistantTableBlock | AssistantChartBlock;

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

export type AssistantChoiceOption = {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
  requiresCustom?: boolean;
};

export type AssistantChoiceRequest = {
  id: string;
  title: string;
  question: string;
  reason: string;
  customPlaceholder: string;
  options: AssistantChoiceOption[];
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

export type AssistantMode = "chat" | "target" | "industry";

export type AssistantChatRequest = {
  message: string;
  threadId?: string;
  mode?: AssistantMode;
};

export type AssistantChatStreamEvent =
  | { type: "start"; threadId: string; messageId: string }
  | { type: "delta"; text: string }
  | { type: "block"; block: AssistantBlock }
  | { type: "choice_request"; request: AssistantChoiceRequest }
  | { type: "memory_candidate"; candidate: AssistantMemoryCandidate }
  | { type: "usage"; usage: AssistantUsage }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; error: string };
