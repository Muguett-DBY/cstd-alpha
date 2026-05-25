import { buildDeepSeekRequestBody, cacheStableUserContent, withCacheProtocol, type DeepSeekMessage } from "./deepseek-cache";
import { readSessionCookie, type UserSession } from "./auth";
import type { AssistantMemory, AssistantMemoryCandidate, AssistantMessage, AssistantMode, AssistantUsage } from "../../src/shared/assistant";

export type AssistantEnv = {
  AUTH_SECRET: string;
  DEEPSEEK_API_KEY?: string;
  ANYSEARCH_API_KEY?: string;
  SEARXNG_ENDPOINTS?: string;
  EXA_API_KEY?: string;
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
export const ASSISTANT_REASONING_EFFORT = "max";
export const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
export const ASSISTANT_CONTEXT_COMPACT_TOKEN_LIMIT = 100_000;
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
    thresholdTokens?: number;
  },
) {
  const combined = [
    input.previousSummary,
    ...input.recentMessages.map((message) => `${message.role}: ${message.content}`),
    `user: ${input.latestUserMessage}`,
    `assistant: ${input.latestAssistantMessage}`,
  ].join("\n");
  const compactByTokens = shouldCompactAssistantContext(combined, input.thresholdTokens ?? ASSISTANT_CONTEXT_COMPACT_TOKEN_LIMIT);
  const compactByLegacyChars = typeof input.thresholdChars === "number" && combined.length >= input.thresholdChars;
  if (!compactByTokens && !compactByLegacyChars) return null;
  const now = input.now ?? new Date().toISOString();
  const summary = buildDeterministicThreadSummary(combined);
  await db
    .prepare(`UPDATE assistant_threads SET summary = ?1, updated_at = ?2 WHERE id = ?3 AND user_key = ?4`)
    .bind(summary, now, input.threadId, input.userKey)
    .run();
  return summary;
}

export function shouldCompactAssistantContext(content: string, thresholdTokens = ASSISTANT_CONTEXT_COMPACT_TOKEN_LIMIT) {
  return estimateAssistantContextTokens(content) >= thresholdTokens;
}

export function estimateAssistantContextTokens(content: string) {
  if (!content.trim()) return 0;
  const cjkChars = content.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const asciiWords = content.match(/[A-Za-z0-9_.$%+-]+/g)?.length ?? 0;
  const otherNonWhitespace = content.replace(/[\u3400-\u9fff\uf900-\ufaffA-Za-z0-9_.$%+\-\s]/g, "").length;
  const whitespaceAdjustedChars = Math.max(0, content.replace(/\s+/g, "").length - cjkChars - otherNonWhitespace);
  return Math.ceil(cjkChars + asciiWords * 1.15 + otherNonWhitespace * 0.5 + whitespaceAdjustedChars / 4);
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

  const ranking = await db
    .prepare(
      `SELECT company_name, ticker, market, company_quality_score, investment_attractiveness_score, overall_score, verdict, summary
       FROM watchlist_ranking_score
       WHERE user_key = ?1 AND status = 'completed'
       ORDER BY overall_score DESC, company_quality_score DESC, updated_at DESC
       LIMIT 24`,
    )
    .bind(userKey)
    .all<{
      company_name: string;
      ticker: string;
      market: string;
      company_quality_score: number | null;
      investment_attractiveness_score: number | null;
      overall_score: number | null;
      verdict: string;
      summary: string;
    }>()
    .catch(() => ({ results: [] }));
  if (ranking.results?.length) {
    const rows = ranking.results;
    const high = rows
      .slice(0, 8)
      .map(
        (item) =>
          `${item.company_name}(${item.ticker}/${item.market}) 综合${item.overall_score ?? "NA"} 质量${item.company_quality_score ?? "NA"} 吸引力${item.investment_attractiveness_score ?? "NA"}：${item.verdict}`,
      );
    const low = [...rows]
      .sort((a, b) => (a.overall_score ?? 0) - (b.overall_score ?? 0))
      .slice(0, 6)
      .map(
        (item) =>
          `${item.company_name}(${item.ticker}/${item.market}) 综合${item.overall_score ?? "NA"} 质量${item.company_quality_score ?? "NA"} 吸引力${item.investment_attractiveness_score ?? "NA"}：${item.verdict}`,
      );
    lines.push(`自选股排行（DeepSeek基于公司证据包重评分，不等同模板评分）：高分=${high.join("；")}；低分/优先排雷=${low.join("；")}`);
  }

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
  externalEvidenceSummary?: string;
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
      "格式硬约束：除纯寒暄和记忆确认外，第一行必须以“结论：”开头，不能先写背景段落、口径说明或没有标签的判断句。",
      "研究模式：标的研究或行业研究时，必须绝对理性，结论必须是支持、反对、观察、回避之一，禁止模棱两可和迎合用户。",
      "研究模式输出结构固定为：结论、证据等级、核心理由、反驳用户观点、我可能错在哪里、下一步跟踪。",
      "篇幅约束：除用户明确要求长报告外，默认回答控制在 600-1200 个中文字符；复杂问题最多 1500 字；表格最多 8 行。宁可信息密度高，也不要堆长篇空话。",
      "篇幅约束：每个小节只写有增量的信息；不要重复同一句证据不足，也不要输出多张重复表格。",
      "所有公司和行业判断优先使用站内证据；证据不足必须明说，不能编造财报、价格、订单、政策或来源。",
      "但禁止把“证据不足/无法回答”作为最终答案的唯一内容。站内证据薄时，必须先使用已触发的外部搜索线索；仍然不足时，也要给低置信情景测算、可审计假设、区间或判断框架、反证条件和下一步验证。",
      "用户问业绩预估、技术优势、行业判断、买卖持有时，不得只回答“无法判断”。你必须在不编造事实的前提下给出有用结论：低置信区间、最可能解释、关键变量、反证和跟踪清单。",
      "同一问题多轮重复时，必须保持口径稳定：若修正上一轮数字或结论，明确说明新证据或新假设是什么；不要无解释地从一个区间跳到另一个区间。",
      "只回答当前用户问题；除非用户明确要求延续旧话题，不要主动引入最近聊天里的无关公司、行业或技术细节。",
      "最近聊天只用于理解用户追问的对象和口径；历史助手回答不是事实证据，不能把历史回答里的数字、券商预测或结论当成新一轮证据。",
      "来源约束：只有外部证据条目明确标记为 Exa 时，才可以说“通过 Exa 检索到”；Exa 是检索服务，不是原始信息发布方，不能写成“全部来自 Exa”。如果 Exa 未返回可用结果，必须说 Exa 没有可用结果，不能把 AnySearch/SearXNG 说成 Exa。",
      "来源约束：AnySearch、SearXNG、Exa 都是外部搜索线索，不是财报库、交易所、统计局或公司公告；除非证据摘要里明确写出来源和数值，否则禁止补写出货量、订单量、内部记录、市场份额或官方统计。",
      "来源约束：引用外部搜索时只能复述标题和摘要中明确出现的信息；不确定的数值必须写为“未在本轮证据中核实”，不能为了让回答更完整而推断。",
      "证据等级约束：不能因为 Exa/AnySearch/SearXNG 返回多条新闻或海外案例就写“证据等级：高”。高证据等级必须至少有直接相关的财报/公告/监管/官方统计/公司级硬数据交叉验证。",
      "证据等级约束：如果证据等级段落写着“来自 Exa 检索、多地区新闻、券商研报、S&P 报告、海外案例、GCC、印度、美国”等，证据等级最高只能写“中”，不能写“高/中高/较高/中至高”。",
      "证据等级约束：如果证据主要是海外银行、海外公司或跨市场案例，而用户讨论的是中国/A股/港股语境，最高只能写“证据等级：中”，且必须说明这些案例只能作为风险类比，不能直接证明中国标的。",
      "业绩预估约束：如果用户问全年业绩、净利润、营收或预测，必须区分“已披露财报事实”“券商/外部预测”“模型推算”。非站内财报或官方公告证据不得写成“实际值”。",
      "业绩预估约束：给区间预测时必须写清楚基数来源、推算公式和证据等级；如果基数或同比口径无法审计，必须把结论降为低置信情景测算。",
      "事实口径约束：没有明确财报、公告或可信外部证据时，禁止写“营收利润双降”“上市首次亏损”“首次下滑”等强事实；只能写为“待核验线索”或不写。",
      "事实口径约束：没有明确财报、公告或可信外部证据时，禁止写“首次业绩双降”“业绩双降”“上市25年首次业绩双降”等强事实；只能写为“业绩承压待核验线索”或不写。",
      "定量阈值约束：没有上下文证据明确给出数值时，禁止自造“订单>500台”“渗透率>50%”“贡献>20%”这类确认阈值。反证/确认条件可以写方向，例如“订单连续放量且现金流改善”，但不能编造具体门槛。",
      "证据等级约束：如果判断主要依赖站内自选股排行、模板报告、模型评分或搜索线索，而缺少直接财报/公告/官方统计交叉验证，证据等级最高只能写“中”，不能写“中高/高”。",
      "Memory 只用于理解用户长期偏好和表达方式，不能替代事实证据。",
      "如果问题涉及投资动作，必须保持审慎，区分事实、推断和不确定性。",
      "理性约束：禁止迎合用户预设结论；禁止用单一新闻、单家公司极端同比、短期股价涨跌直接推出投资结论。",
      "理性约束：每个强判断都必须说明证据等级、反证条件和仍需验证的数据；证据不足时优先降级为观察。",
      "反驳类问题约束：如果用户要求反驳观点，必须先精确拆分“观点中可能合理的部分”和“错误或过度绝对化的部分”。例如高股息策略可能合理，但“稳赚/无风险/必然赚钱”必须明确反驳。",
      "反驳类问题约束：反驳不能只堆海外案例。优先给适用于当前市场的机制拆解：总回报=股息+股价变化、净息差、信用成本、资本充足率、分红政策、估值和本金回撤。",
      "反驳类问题约束：表格里的反证条件要写成“什么情况会削弱我的反驳/让我错”，不要写“支持稳赚”的反证条件，因为投资里几乎不存在无风险稳赚。",
      "格式约束：禁止输出空标题或空章节；如果某一节没有实质内容就删掉。Markdown 表格前必须有具体标题，例如“反驳要点表”“用户观点拆解”“反证与确认条件”“跟踪指标”，不要写“结构化表格1/2/3”。",
      "图表规则：如果用户明确要求画图、画表、对比表、趋势图或证据矩阵，必须先给结论，再给一张 Markdown 表格，表格列名清晰且数值列可解析；不要输出 ECharts JSON 或代码块。",
      "图表规则：表格里的数值必须来自上下文证据或明确标注为打分/估计；无法给出数值时输出证据矩阵而不是编造趋势。",
      "图表规则：不要说“无法画图”或“以表格替代图表”；系统会把合格 Markdown 表格自动渲染为图表。",
    ].join("\n"),
    "assistant-chat",
  );
  const stableContext = cacheStableUserContent({
    kind: "assistant-chat-context",
    stable: {
      schemaVersion: 2,
      outputRules: ["先结论后证据", "必须给反证条件", "证据不足时明确标注", "不修改站内业务数据"],
    },
    volatile: {
      volatileContext: {
        assistantMode: modeLabel,
        confirmedMemories: input.memories.map((memory) => ({ category: memory.category, content: memory.content })),
        threadSummary: input.threadSummary || "暂无长期摘要。",
        siteEvidenceSummary: input.evidenceSummary,
        currentTurnPolicy: "最近聊天作为后续 messages append-only 追加，不写入稳定上下文。",
        externalSearchEvidence: input.externalEvidenceSummary || "本轮未触发外部搜索。",
      },
    },
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
    maxTokens: 4500,
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
