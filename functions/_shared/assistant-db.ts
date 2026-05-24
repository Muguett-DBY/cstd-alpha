import { buildDeepSeekRequestBody, cacheStableUserContent, withCacheProtocol, type DeepSeekMessage } from "./deepseek-cache";
import { readSessionCookie, type UserSession } from "./auth";
import type { AssistantMemory, AssistantMemoryCandidate, AssistantMessage, AssistantMode, AssistantUsage } from "../../src/shared/assistant";

export type AssistantEnv = {
  AUTH_SECRET: string;
  DEEPSEEK_API_KEY?: string;
  ANYSEARCH_API_KEY?: string;
  SEARXNG_ENDPOINTS?: string;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
  REPORT_CACHE?: KVNamespace;
};

type MemoryRow = {
  id: string;
  content: string;
  category: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type MemoryCandidateRow = {
  id: string;
  content: string;
  category: string;
  reason: string;
  status: string;
  created_at: string;
};

type MessageRow = {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  metadata_json: string | null;
  created_at: string;
};

export const ASSISTANT_DEFAULT_THREAD_ID = "default-investment-thread";
export const ASSISTANT_MODEL = "deepseek-v4-flash";
export const ASSISTANT_REASONING_EFFORT = "high";
export const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const ASSISTANT_CACHE_ANCHOR_SENTENCE =
  "CSTD Alpha assistant cache anchor: Chinese investment assistant, evidence first, conclusion evidence counter-evidence follow-up, conservative scoring, no hallucinated facts, admin private memory, read-only tools. ";
const ASSISTANT_CACHE_ANCHOR_REPEAT = 180;

export async function requireAdminSession(request: Request, env: AssistantEnv) {
  const session = await readSessionCookie(request.headers.get("cookie"), env);
  if (!session) return { response: json({ error: "Unauthorized." }, 401), session: null };
  if (session.role !== "admin") return { response: json({ error: "Forbidden." }, 403), session: null };
  return { response: null, session };
}

export async function ensureAssistantSchema(db: D1Database) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS assistant_threads (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        summary_object_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_assistant_threads_user ON assistant_threads (user_key, updated_at DESC)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS assistant_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_assistant_messages_thread ON assistant_messages (thread_id, created_at ASC)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS assistant_memories (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_assistant_memories_user ON assistant_memories (user_key, status, updated_at DESC)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS assistant_memory_candidates (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        message_id TEXT,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_assistant_memory_candidates_user ON assistant_memory_candidates (user_key, status, created_at DESC)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS assistant_tool_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        input_json TEXT,
        output_json TEXT,
        created_at TEXT NOT NULL
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_assistant_tool_runs_thread ON assistant_tool_runs (thread_id, created_at DESC)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS assistant_usage_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        message_id TEXT,
        user_key TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        prompt_cache_hit_tokens INTEGER,
        prompt_cache_miss_tokens INTEGER,
        elapsed_ms INTEGER,
        created_at TEXT NOT NULL
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_assistant_usage_thread ON assistant_usage_events (thread_id, created_at DESC)`),
  ]);
}

export async function getOrCreateDefaultThread(db: D1Database, userKey: string, now = new Date().toISOString()) {
  await ensureAssistantSchema(db);
  const id = `${userKey}:${ASSISTANT_DEFAULT_THREAD_ID}`;
  const existing = await db.prepare(`SELECT id, title, summary, updated_at FROM assistant_threads WHERE id = ?1 AND user_key = ?2`).bind(id, userKey).first<{
    id: string;
    title: string;
    summary: string;
    updated_at: string;
  }>();
  if (existing) return existing;
  await db
    .prepare(`INSERT INTO assistant_threads (id, user_key, title, summary, created_at, updated_at) VALUES (?1, ?2, ?3, '', ?4, ?4)`)
    .bind(id, userKey, "长期投研助手", now)
    .run();
  return { id, title: "长期投研助手", summary: "", updated_at: now };
}

export async function readActiveMemories(db: D1Database, userKey: string): Promise<AssistantMemory[]> {
  await ensureAssistantSchema(db);
  const result = await db
    .prepare(`SELECT id, content, category, status, created_at, updated_at FROM assistant_memories WHERE user_key = ?1 AND status = 'active' ORDER BY updated_at DESC LIMIT 80`)
    .bind(userKey)
    .all<MemoryRow>();
  return (result.results ?? []).map(memoryRowToMemory);
}

export async function readAllMemories(db: D1Database, userKey: string): Promise<AssistantMemory[]> {
  await ensureAssistantSchema(db);
  const result = await db
    .prepare(`SELECT id, content, category, status, created_at, updated_at FROM assistant_memories WHERE user_key = ?1 ORDER BY updated_at DESC LIMIT 120`)
    .bind(userKey)
    .all<MemoryRow>();
  return (result.results ?? []).map(memoryRowToMemory);
}

export async function readPendingMemoryCandidates(db: D1Database, userKey: string): Promise<AssistantMemoryCandidate[]> {
  await ensureAssistantSchema(db);
  const result = await db
    .prepare(`SELECT id, content, category, reason, status, created_at FROM assistant_memory_candidates WHERE user_key = ?1 AND status = 'pending' ORDER BY created_at DESC LIMIT 30`)
    .bind(userKey)
    .all<MemoryCandidateRow>();
  return (result.results ?? []).map(candidateRowToCandidate);
}

export async function readLatestUsage(db: D1Database, userKey: string, threadId: string): Promise<AssistantUsage | undefined> {
  await ensureAssistantSchema(db);
  const row = await db
    .prepare(
      `SELECT model, reasoning_effort, prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens, elapsed_ms
       FROM assistant_usage_events
       WHERE user_key = ?1 AND thread_id = ?2
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(userKey, threadId)
    .first<{
      model: string;
      reasoning_effort: string;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
      prompt_cache_hit_tokens: number | null;
      prompt_cache_miss_tokens: number | null;
      elapsed_ms: number | null;
    }>();
  if (!row) return undefined;
  return {
    model: row.model,
    reasoningEffort: row.reasoning_effort === "max" ? "max" : "high",
    promptTokens: row.prompt_tokens ?? undefined,
    completionTokens: row.completion_tokens ?? undefined,
    totalTokens: row.total_tokens ?? undefined,
    promptCacheHitTokens: row.prompt_cache_hit_tokens ?? undefined,
    promptCacheMissTokens: row.prompt_cache_miss_tokens ?? undefined,
    elapsedMs: row.elapsed_ms ?? undefined,
  };
}

export async function readRecentMessages(db: D1Database, userKey: string, threadId: string, limit = 24): Promise<AssistantMessage[]> {
  await ensureAssistantSchema(db);
  const result = await db
    .prepare(
      `SELECT id, thread_id, role, content, metadata_json, created_at
       FROM assistant_messages
       WHERE user_key = ?1 AND thread_id = ?2
       ORDER BY created_at DESC
       LIMIT ?3`,
    )
    .bind(userKey, threadId, limit)
    .all<MessageRow>();
  return (result.results ?? []).reverse().map(messageRowToMessage);
}

export async function writeAssistantMessage(db: D1Database, input: { id?: string; userKey: string; threadId: string; role: "user" | "assistant"; content: string; metadata?: unknown; now?: string }) {
  await ensureAssistantSchema(db);
  const now = input.now ?? new Date().toISOString();
  const id = input.id ?? crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO assistant_messages (id, thread_id, user_key, role, content, metadata_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(id, input.threadId, input.userKey, input.role, input.content, input.metadata ? JSON.stringify(input.metadata) : null, now)
    .run();
  await db.prepare(`UPDATE assistant_threads SET updated_at = ?1 WHERE id = ?2 AND user_key = ?3`).bind(now, input.threadId, input.userKey).run();
  return { id, threadId: input.threadId, role: input.role, content: input.content, createdAt: now, metadata: input.metadata } as AssistantMessage;
}

export async function updateThreadSummaryIfLarge(
  db: D1Database,
  input: {
    userKey: string;
    threadId: string;
    previousSummary: string;
    recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
    latestUserMessage: string;
    latestAssistantMessage: string;
    now?: string;
    thresholdChars?: number;
  },
) {
  const combined = [
    input.previousSummary,
    ...input.recentMessages.map((message) => `${message.role}: ${message.content}`),
    `user: ${input.latestUserMessage}`,
    `assistant: ${input.latestAssistantMessage}`,
  ].join("\n");
  if (combined.length < (input.thresholdChars ?? 180_000)) return null;
  const now = input.now ?? new Date().toISOString();
  const summary = buildDeterministicThreadSummary(combined);
  await db
    .prepare(`UPDATE assistant_threads SET summary = ?1, updated_at = ?2 WHERE id = ?3 AND user_key = ?4`)
    .bind(summary, now, input.threadId, input.userKey)
    .run();
  return summary;
}

export function detectMemoryCandidate(message: string): Omit<AssistantMemoryCandidate, "id" | "createdAt"> | null {
  const normalized = message.trim();
  if (!/(记住|以后|我的偏好|我的规则|投资框架|不要再|别再|纠正一下|这条规则)/.test(normalized)) return null;
  const content = normalized.replace(/^记住[:：]?\s*/, "").slice(0, 500);
  return {
    content,
    category: /不要再|别再|纠正/.test(normalized) ? "correction" : "preference",
    reason: "用户语句包含明确的长期偏好、规则或纠错信号。",
    status: "pending",
  };
}

export async function writeMemoryCandidate(db: D1Database, input: { userKey: string; messageId: string; candidate: Omit<AssistantMemoryCandidate, "id" | "createdAt">; now?: string }) {
  await ensureAssistantSchema(db);
  const now = input.now ?? new Date().toISOString();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO assistant_memory_candidates (id, user_key, message_id, content, category, reason, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7)`,
    )
    .bind(id, input.userKey, input.messageId, input.candidate.content, input.candidate.category, input.candidate.reason, now)
    .run();
  return { ...input.candidate, id, createdAt: now } satisfies AssistantMemoryCandidate;
}

export async function confirmMemoryCandidate(db: D1Database, userKey: string, id: string) {
  await ensureAssistantSchema(db);
  const row = await db
    .prepare(`SELECT id, content, category, reason, status, created_at FROM assistant_memory_candidates WHERE user_key = ?1 AND id = ?2`)
    .bind(userKey, id)
    .first<MemoryCandidateRow>();
  if (!row || row.status !== "pending") return null;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE assistant_memory_candidates SET status = 'confirmed', updated_at = ?1 WHERE user_key = ?2 AND id = ?3`).bind(now, userKey, id),
    db
      .prepare(`INSERT INTO assistant_memories (id, user_key, content, category, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)`)
      .bind(`mem:${id}`, userKey, row.content, row.category, now),
  ]);
  return { id: `mem:${id}`, content: row.content, category: row.category, status: "active" as const, createdAt: now, updatedAt: now };
}

export async function rejectMemoryCandidate(db: D1Database, userKey: string, id: string) {
  await ensureAssistantSchema(db);
  const now = new Date().toISOString();
  await db.prepare(`UPDATE assistant_memory_candidates SET status = 'rejected', updated_at = ?1 WHERE user_key = ?2 AND id = ?3 AND status = 'pending'`).bind(now, userKey, id).run();
}

export async function setMemoryStatus(db: D1Database, userKey: string, id: string, status: "active" | "disabled" | "deleted") {
  await ensureAssistantSchema(db);
  const now = new Date().toISOString();
  if (status === "deleted") {
    await db.prepare(`DELETE FROM assistant_memories WHERE user_key = ?1 AND id = ?2`).bind(userKey, id).run();
    return;
  }
  await db.prepare(`UPDATE assistant_memories SET status = ?1, updated_at = ?2 WHERE user_key = ?3 AND id = ?4`).bind(status, now, userKey, id).run();
}

export async function writeUsageEvent(db: D1Database, input: { userKey: string; threadId: string; messageId?: string; usage: AssistantUsage; now?: string }) {
  await ensureAssistantSchema(db);
  const now = input.now ?? new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO assistant_usage_events (
         id, thread_id, message_id, user_key, model, reasoning_effort, prompt_tokens, completion_tokens, total_tokens,
         prompt_cache_hit_tokens, prompt_cache_miss_tokens, elapsed_ms, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(
      crypto.randomUUID(),
      input.threadId,
      input.messageId ?? null,
      input.userKey,
      input.usage.model,
      input.usage.reasoningEffort,
      input.usage.promptTokens ?? null,
      input.usage.completionTokens ?? null,
      input.usage.totalTokens ?? null,
      input.usage.promptCacheHitTokens ?? null,
      input.usage.promptCacheMissTokens ?? null,
      input.usage.elapsedMs ?? null,
      now,
    )
    .run();
}

export async function writeToolRun(db: D1Database, input: { userKey: string; threadId: string; toolName: string; status: "completed" | "failed" | "skipped"; summary: string; input?: unknown; output?: unknown; now?: string }) {
  await ensureAssistantSchema(db);
  const now = input.now ?? new Date().toISOString();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO assistant_tool_runs (id, thread_id, user_key, tool_name, status, summary, input_json, output_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(id, input.threadId, input.userKey, input.toolName, input.status, input.summary, input.input ? JSON.stringify(input.input) : null, input.output ? JSON.stringify(input.output) : null, now)
    .run();
  return { id, toolName: input.toolName, status: input.status, summary: input.summary, createdAt: now };
}

export async function buildSiteEvidenceSummary(db: D1Database, userKey: string) {
  const lines: string[] = [];
  const watchlist = await db
    .prepare(`SELECT company_name, ticker, market FROM user_watchlist WHERE user_key = ?1 ORDER BY added_at DESC LIMIT 12`)
    .bind(userKey)
    .all<{ company_name: string; ticker: string; market: string }>()
    .catch(() => ({ results: [] }));
  if (watchlist.results?.length) lines.push(`自选股：${watchlist.results.map((item) => `${item.company_name}(${item.ticker}/${item.market})`).join("、")}`);

  const analyses = await db
    .prepare(`SELECT company_name, template_title, score, verdict, summary FROM template_analysis WHERE user_key = ?1 AND status = 'completed' ORDER BY updated_at DESC LIMIT 8`)
    .bind(userKey)
    .all<{ company_name: string; template_title: string; score: number | null; verdict: string; summary: string }>()
    .catch(() => ({ results: [] }));
  if (analyses.results?.length) {
    lines.push(
      `最近模板报告：${analyses.results
        .map((item) => `${item.company_name}/${item.template_title}/评分${item.score ?? "NA"}/${item.verdict}：${item.summary.slice(0, 80)}`)
        .join("；")}`,
    );
  }
  return lines.join("\n") || "暂无站内投研证据。";
}

export function buildAssistantPromptMessages(input: {
  memories: AssistantMemory[];
  threadSummary: string;
  evidenceSummary: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>;
  userMessage: string;
  mode?: AssistantMode;
}): DeepSeekMessage[] {
  const mode = input.mode ?? "chat";
  const modeLabel = mode === "target" ? "标的研究" : mode === "industry" ? "行业研究" : "普通聊天";
  const system = withCacheProtocol(
    [
      ASSISTANT_CACHE_ANCHOR_SENTENCE.repeat(ASSISTANT_CACHE_ANCHOR_REPEAT),
      "你是 CSTD Alpha 的私人投研助手，只服务 admin。",
      "你不是普通聊天机器人。回答投资问题时默认结构必须是：结论、证据、反证/我可能错在哪里、后续跟踪。",
      "研究模式：标的研究或行业研究时，必须绝对理性，结论必须是支持、反对、观察、回避之一，禁止模棱两可和迎合用户。",
      "研究模式输出结构固定为：结论、证据等级、核心理由、反驳用户观点、我可能错在哪里、下一步跟踪。",
      "所有公司和行业判断优先使用站内证据；证据不足必须明说，不能编造财报、价格、订单、政策或来源。",
      "Memory 只用于理解用户长期偏好和表达方式，不能替代事实证据。",
      "如果问题涉及投资动作，必须保持审慎，区分事实、推断和不确定性。",
      "理性约束：禁止迎合用户预设结论；禁止用单一新闻、单家公司极端同比、短期股价涨跌直接推出投资结论。",
      "理性约束：每个强判断都必须说明证据等级、反证条件和仍需验证的数据；证据不足时优先降级为观察。",
    ].join("\n"),
    "assistant-chat",
  );
  const stableContext = cacheStableUserContent({
    kind: "assistant-chat-context",
    stable: {
      outputRules: ["先结论后证据", "必须给反证条件", "证据不足时明确标注", "不修改站内业务数据"],
      assistantMode: modeLabel,
      confirmedMemories: input.memories.map((memory) => ({ category: memory.category, content: memory.content })),
      threadSummary: input.threadSummary || "暂无长期摘要。",
      siteEvidenceSummary: input.evidenceSummary,
    },
    volatile: { currentTurnPolicy: "最近聊天作为后续 messages append-only 追加，不写入稳定上下文。" },
  });
  return [
    { role: "system", content: system },
    { role: "user", content: `已确认长期记忆、线程摘要和站内证据如下：\n${stableContext}` },
    ...input.recentMessages.map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: input.userMessage },
  ];
}

export function buildAssistantDeepSeekBody(messages: DeepSeekMessage[]) {
  return {
    ...buildDeepSeekRequestBody({
    model: ASSISTANT_MODEL,
    messages,
    maxTokens: 3200,
    reasoningEffort: ASSISTANT_REASONING_EFFORT,
    temperature: 0.12,
    stream: true,
    responseFormat: null,
    thinking: { type: "enabled" },
    }),
    stream_options: { include_usage: true },
  };
}

export function parseDeepSeekUsage(usage: unknown): Omit<AssistantUsage, "model" | "reasoningEffort" | "elapsedMs"> {
  if (!usage || typeof usage !== "object") return {};
  const row = usage as Record<string, unknown>;
  return {
    promptTokens: numberOrUndefined(row.prompt_tokens),
    completionTokens: numberOrUndefined(row.completion_tokens),
    totalTokens: numberOrUndefined(row.total_tokens),
    promptCacheHitTokens: numberOrUndefined(row.prompt_cache_hit_tokens),
    promptCacheMissTokens: numberOrUndefined(row.prompt_cache_miss_tokens),
  };
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function publicSessionUser(session: UserSession) {
  return { userId: session.userId, username: session.username, displayName: session.displayName, role: session.role };
}

function memoryRowToMemory(row: MemoryRow): AssistantMemory {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function candidateRowToCandidate(row: MemoryCandidateRow): AssistantMemoryCandidate {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    reason: row.reason,
    status: row.status === "confirmed" || row.status === "rejected" ? row.status : "pending",
    createdAt: row.created_at,
  };
}

function buildDeterministicThreadSummary(content: string) {
  const compact = content
    .replace(/\s+/g, " ")
    .replace(/api[_-]?key|authorization|password|secret/gi, "[redacted]")
    .trim();
  const head = compact.slice(0, 1800);
  const tail = compact.slice(-3200);
  return [
    "自动压缩摘要（非模型生成）：长期线程已超过上下文安全阈值。",
    "保留原则：用户长期规则、明确纠错、投资框架、待跟踪事项优先；事实结论仍需回到证据包复核。",
    `早期上下文摘录：${head}`,
    `近期上下文摘录：${tail}`,
  ].join("\n");
}

function messageRowToMessage(row: MessageRow): AssistantMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role === "assistant" || row.role === "system" ? row.role : "user",
    content: row.content,
    createdAt: row.created_at,
    metadata: parseJson(row.metadata_json),
  };
}

function parseJson(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
