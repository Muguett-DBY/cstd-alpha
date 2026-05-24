import {
  ASSISTANT_MODEL,
  ASSISTANT_REASONING_EFFORT,
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  buildAssistantDeepSeekBody,
  buildAssistantPromptMessages,
  buildSiteEvidenceSummary,
  detectMemoryCandidate,
  ensureAssistantSchema,
  getOrCreateDefaultThread,
  json,
  parseDeepSeekUsage,
  readActiveMemories,
  readRecentMessages,
  requireAdminSession,
  updateThreadSummaryIfLarge,
  writeAssistantMessage,
  writeMemoryCandidate,
  writeToolRun,
  writeUsageEvent,
  type AssistantEnv,
} from "../../_shared/assistant-db";
import { extractAssistantBlocks } from "../../_shared/assistant-blocks";
import { fetchAnySearchEvidence, fetchExaEvidence, fetchSearxngEvidence, type AnySearchEvidence, type AnySearchQuery } from "../../_shared/anysearch";
import { buildDeepSeekRequestBody, cacheStableUserContent, withCacheProtocol, type DeepSeekMessage } from "../../_shared/deepseek-cache";
import { isUnsatisfactoryEvidenceOnlyAnswer } from "../../_shared/assistant-quality";
import type { AssistantChatRequest, AssistantChatStreamEvent, AssistantChoiceOption, AssistantChoiceRequest, AssistantMode, AssistantUsage } from "../../../src/shared/assistant";

type AssistantSearchToolName = "search_anysearch" | "search_searxng" | "search_exa";
type AssistantSearchToolCall = {
  id: string;
  name: AssistantSearchToolName;
  query: string;
  reason?: string;
  freshness?: "day" | "week" | "month" | "year";
  maxResults?: number;
};

type ExternalEvidenceResult = {
  triggered: boolean;
  query?: string;
  items: AnySearchEvidence[];
  exa: { used: boolean; count: number; reason?: string; dailyCount?: number };
  routerUsage?: AssistantUsage;
  toolCalls?: AssistantSearchToolCall[];
  toolSummary?: string;
};

function assistantToolRunSummary(externalEvidence: ExternalEvidenceResult) {
  if (!externalEvidence.triggered) return `模型工具路由判断无需外部搜索。${externalEvidence.exa.reason ? ` ${externalEvidence.exa.reason}。` : ""}`;
  const base = externalEvidence.toolSummary || `外部搜索返回 ${externalEvidence.items.length} 条，已并入助手上下文。`;
  if (externalEvidence.exa.used) return base;
  if (externalEvidence.exa.reason) return `${base} Exa未用：${externalEvidence.exa.reason}。`;
  return base;
}

export const onRequestPost: PagesFunction<AssistantEnv> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  if (!env.DEEPSEEK_API_KEY) return json({ error: "DEEPSEEK_API_KEY is not configured." }, 500);

  await ensureAssistantSchema(env.REPORT_LIBRARY_DB);
  const body = (await request.json().catch(() => null)) as AssistantChatRequest | null;
  const userMessage = body?.message?.trim();
  if (!userMessage) return json({ error: "请输入助手问题。" }, 400);
  const mode = normalizeAssistantMode(body?.mode);

  const now = new Date().toISOString();
  const thread = await getOrCreateDefaultThread(env.REPORT_LIBRARY_DB, session.userId, now);
  const userStoredMessage = await writeAssistantMessage(env.REPORT_LIBRARY_DB, {
    userKey: session.userId,
    threadId: thread.id,
    role: "user",
    content: userMessage,
    now,
  });
  const pendingCandidate = detectMemoryCandidate(userMessage);
  const storedCandidate = pendingCandidate
    ? await writeMemoryCandidate(env.REPORT_LIBRARY_DB, {
        userKey: session.userId,
        messageId: userStoredMessage.id,
        candidate: pendingCandidate,
        now,
      })
    : null;

  const memories = await readActiveMemories(env.REPORT_LIBRARY_DB, session.userId);
  const recentMessages = (await readRecentMessages(env.REPORT_LIBRARY_DB, session.userId, thread.id, 12))
    .filter((message) => message.id !== userStoredMessage.id)
    .map((message): { role: "user" | "assistant"; content: string; createdAt: string } => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
      createdAt: message.createdAt,
    }));
  const researchContext = resolveAssistantResearchContext(userMessage, recentMessages);
  const evidenceMode = mode === "chat" && shouldAutoUseResearchEvidence(researchContext.message) ? "target" : mode;
  const simpleGeneralChat = shouldTreatAsSimpleGeneralChat(researchContext.message, evidenceMode);
  const promptRecentMessages = simpleGeneralChat || !shouldIncludeRecentAssistantContext(researchContext.message) ? [] : recentMessages.slice(-8);
  const answerDirectly = shouldAnswerDirectlyWithoutClarification(researchContext.message) || simpleGeneralChat;
  const clarificationDecision =
    answerDirectly || (researchContext.message !== userMessage && shouldAutoUseResearchEvidence(researchContext.message))
      ? { request: null }
      : await askModelForClarification({
          env,
          userMessage,
          memories: memories.map((memory) => ({ category: memory.category, content: memory.content })),
          threadSummary: thread.summary,
          recentMessages: promptRecentMessages,
          signal: request.signal,
        });
  if (clarificationDecision.request) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        enqueue(controller, { type: "start", threadId: thread.id, messageId: userStoredMessage.id });
        if (storedCandidate) enqueue(controller, { type: "memory_candidate", candidate: storedCandidate });
        enqueue(controller, { type: "choice_request", request: clarificationDecision.request! });
        if (clarificationDecision.usage) {
          await writeUsageEvent(env.REPORT_LIBRARY_DB!, { userKey: session.userId, threadId: thread.id, messageId: userStoredMessage.id, usage: clarificationDecision.usage });
          enqueue(controller, { type: "usage", usage: clarificationDecision.usage });
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });

    function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, event: AssistantChatStreamEvent) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    }
  }

  const [siteEvidenceSummary, modeEvidenceSummary] = await Promise.all([
    buildSiteEvidenceSummary(env.REPORT_LIBRARY_DB, session.userId),
    buildModeEvidenceSummary(env.REPORT_LIBRARY_DB, session.userId, researchContext.message, evidenceMode, { strictTargetMatch: mode === "chat" }),
  ]);
  const externalEvidence = await maybeFetchExternalEvidence(env, researchContext.message, evidenceMode, request.signal, {
    siteEvidenceSummary,
    modeEvidenceSummary,
  });
  const toolRun = await writeToolRun(env.REPORT_LIBRARY_DB, {
    userKey: session.userId,
    threadId: thread.id,
    toolName: "站内证据/外部搜索",
    status: externalEvidence.triggered ? "completed" : "skipped",
    summary: assistantToolRunSummary(externalEvidence),
    input: externalEvidence.query ? { query: externalEvidence.query, exa: externalEvidence.exa, toolCalls: externalEvidence.toolCalls } : externalEvidence.toolCalls ? { toolCalls: externalEvidence.toolCalls } : undefined,
    output: externalEvidence.items.slice(0, 8),
    now,
  });
  const evidenceSummary = [siteEvidenceSummary, modeEvidenceSummary].filter(Boolean).join("\n");
  const externalEvidenceSummary = formatExternalEvidence(externalEvidence.items, externalEvidence.exa);
  const promptMessages = buildAssistantPromptMessages({
    memories,
    threadSummary: thread.summary,
    evidenceSummary,
    externalEvidenceSummary,
    recentMessages: promptRecentMessages,
    userMessage: researchContext.promptMessage,
    mode: evidenceMode,
  });

  const assistantMessageId = crypto.randomUUID();
  const startedAt = Date.now();
  if (evidenceMode !== "chat") {
    const reviewed = await generateReviewedResearchAnswer({
      env,
      messages: promptMessages,
      userMessage: researchContext.promptMessage,
      mode: evidenceMode,
      signal: request.signal,
    });
    const guardedText = guardAssistantOutputLanguage(reviewed.text, researchContext.message, externalEvidence);
    if (!guardedText.trim()) return json({ error: "DeepSeek 助手连接失败。" }, 502);
    const blocks = extractAssistantBlocks(guardedText, userMessage);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        enqueue(controller, { type: "start", threadId: thread.id, messageId: assistantMessageId });
        if (storedCandidate) enqueue(controller, { type: "memory_candidate", candidate: storedCandidate });
        enqueue(controller, { type: "delta", text: guardedText });
        for (const block of blocks) enqueue(controller, { type: "block", block });
        const message = await writeAssistantMessage(env.REPORT_LIBRARY_DB!, {
          id: assistantMessageId,
          userKey: session.userId,
          threadId: thread.id,
          role: "assistant",
          content: guardedText,
          metadata: { usage: reviewed.usage, toolRuns: [toolRun], rationalReview: reviewed.review, blocks },
        });
        await writeUsageEvent(env.REPORT_LIBRARY_DB!, { userKey: session.userId, threadId: thread.id, messageId: assistantMessageId, usage: reviewed.usage });
        await updateThreadSummaryIfLarge(env.REPORT_LIBRARY_DB!, {
          userKey: session.userId,
          threadId: thread.id,
          previousSummary: thread.summary,
          recentMessages,
          latestUserMessage: userMessage,
          latestAssistantMessage: guardedText,
        });
        enqueue(controller, { type: "usage", usage: reviewed.usage });
        enqueue(controller, { type: "done", message });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });

    function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, event: AssistantChatStreamEvent) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    }
  }

  const upstream = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(buildAssistantDeepSeekBody(promptMessages)),
    signal: request.signal,
  });
  if (!upstream.ok || !upstream.body) return json({ error: "DeepSeek 助手连接失败。" }, 502);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let assistantText = "";
  let latestUsage: AssistantUsage | undefined;
  let buffer = "";

  const stream = new ReadableStream({
    async start(controller) {
      enqueue(controller, { type: "start", threadId: thread.id, messageId: assistantMessageId });
      if (storedCandidate) enqueue(controller, { type: "memory_candidate", candidate: storedCandidate });

      const reader = upstream.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = consumeSseBuffer(buffer);
          buffer = parsed.remainder;
          for (const item of parsed.items) {
            if (item === "[DONE]") continue;
            const data = JSON.parse(item) as Record<string, unknown>;
            const text = extractDeltaText(data);
            if (text) {
              assistantText += text;
              enqueue(controller, { type: "delta", text });
            }
            if (data.usage) {
              latestUsage = {
                model: ASSISTANT_MODEL,
                reasoningEffort: ASSISTANT_REASONING_EFFORT,
                ...parseDeepSeekUsage(data.usage),
                elapsedMs: Date.now() - startedAt,
              };
              enqueue(controller, { type: "usage", usage: latestUsage });
            }
          }
        }
        assistantText = guardAssistantOutputLanguage(assistantText, researchContext.message, externalEvidence);
        if (!assistantText.trim()) throw new Error("DeepSeek 未返回助手内容。");
        latestUsage ??= { model: ASSISTANT_MODEL, reasoningEffort: ASSISTANT_REASONING_EFFORT, elapsedMs: Date.now() - startedAt };
        const blocks = extractAssistantBlocks(assistantText, userMessage);
        for (const block of blocks) enqueue(controller, { type: "block", block });
        const message = await writeAssistantMessage(env.REPORT_LIBRARY_DB!, {
          id: assistantMessageId,
          userKey: session.userId,
          threadId: thread.id,
          role: "assistant",
          content: assistantText,
          metadata: { usage: latestUsage, toolRuns: [toolRun], blocks },
        });
        await writeUsageEvent(env.REPORT_LIBRARY_DB!, { userKey: session.userId, threadId: thread.id, messageId: assistantMessageId, usage: latestUsage });
        await updateThreadSummaryIfLarge(env.REPORT_LIBRARY_DB!, {
          userKey: session.userId,
          threadId: thread.id,
          previousSummary: thread.summary,
          recentMessages,
          latestUserMessage: userMessage,
          latestAssistantMessage: assistantText,
        });
        if (env.REPORT_LIBRARY_BUCKET) {
          await env.REPORT_LIBRARY_BUCKET.put(
            `assistant/v1/${encodeURIComponent(session.userId)}/${encodeURIComponent(thread.id)}/${assistantMessageId}.json`,
            JSON.stringify({ userMessage, assistantText, usage: latestUsage, toolRun, createdAt: new Date().toISOString() }),
            { httpMetadata: { contentType: "application/json; charset=utf-8" } },
          );
        }
        enqueue(controller, { type: "done", message });
        controller.close();
      } catch (error) {
        enqueue(controller, { type: "error", error: error instanceof Error ? error.message : "助手生成失败。" });
        controller.close();
      } finally {
        reader.releaseLock();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });

  function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, event: AssistantChatStreamEvent) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  }
};

async function maybeFetchExternalEvidence(
  env: AssistantEnv,
  message: string,
  mode: AssistantMode,
  signal: AbortSignal,
  context: { siteEvidenceSummary: string; modeEvidenceSummary: string },
): Promise<ExternalEvidenceResult> {
  if (!env.ANYSEARCH_API_KEY?.trim() && !env.SEARXNG_ENDPOINTS?.trim() && !env.EXA_API_KEY?.trim()) {
    return { triggered: false, items: [], exa: { used: false, count: 0, reason: "未配置外部搜索源" }, toolCalls: [] };
  }
  if (shouldTreatAsSimpleGeneralChat(message, mode)) {
    return { triggered: false, items: [], exa: { used: false, count: 0, reason: "通用概念问题无需外部搜索" }, toolCalls: [] };
  }
  const routerDecision = await askModelForSearchToolCalls({ env, message, mode, context, signal });
  let routerCalls = routerDecision.toolCalls;
  if (!routerCalls.length) {
    const fallback = fallbackSearchToolCalls(message, mode, context, routerDecision.reason || "模型判断无需外部搜索");
    routerCalls = fallback.toolCalls;
    if (!routerCalls.length) return { triggered: false, items: [], exa: { used: false, count: 0, reason: fallback.reason }, routerUsage: routerDecision.usage, toolCalls: [] };
  }
  const executed = await executeAssistantSearchToolCalls(env, routerCalls, signal);
  return {
    triggered: true,
    query: routerCalls.map((call) => `${call.name}:${call.query}`).join(" | ").slice(0, 500),
    items: executed.items.slice(0, 12),
    exa: executed.exa,
    routerUsage: routerDecision.usage,
    toolCalls: routerCalls,
    toolSummary: executed.summary,
  };
}

async function askModelForSearchToolCalls(input: {
  env: AssistantEnv;
  message: string;
  mode: AssistantMode;
  context: { siteEvidenceSummary: string; modeEvidenceSummary: string };
  signal: AbortSignal;
}): Promise<{ toolCalls: AssistantSearchToolCall[]; reason?: string; usage?: AssistantUsage }> {
  const startedAt = Date.now();
  const messages = buildSearchToolRouterMessages(input.message, input.mode, input.context);
  try {
    const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.env.DEEPSEEK_API_KEY}` },
      signal: input.signal,
      body: JSON.stringify({
        ...buildDeepSeekRequestBody({
          model: ASSISTANT_MODEL,
          messages,
          maxTokens: 900,
          reasoningEffort: ASSISTANT_REASONING_EFFORT,
          temperature: 0,
          responseFormat: null,
          stream: false,
          thinking: { type: "enabled" },
        }),
        tools: assistantSearchTools(),
        tool_choice: "auto",
      }),
    });
    if (!response.ok) return fallbackSearchToolCalls(input.message, input.mode, input.context, "工具路由模型调用失败");
    const data = (await response.json()) as Record<string, unknown>;
    const usage: AssistantUsage = {
      model: ASSISTANT_MODEL,
      reasoningEffort: ASSISTANT_REASONING_EFFORT,
      ...parseDeepSeekUsage(data.usage),
      elapsedMs: Date.now() - startedAt,
    };
    const toolCalls = augmentSearchToolCalls(normalizeSearchToolCalls(data), input.message, input.mode, input.context);
    const reason = extractMessageContent(data).slice(0, 180);
    if (toolCalls.length) return { toolCalls, reason, usage };
    return { toolCalls: fallbackSearchToolCalls(input.message, input.mode, input.context, reason || "模型未调用外部搜索工具").toolCalls, reason: reason || "模型未调用外部搜索工具", usage };
  } catch {
    return fallbackSearchToolCalls(input.message, input.mode, input.context, "工具路由异常");
  }
}

function augmentSearchToolCalls(
  toolCalls: AssistantSearchToolCall[],
  message: string,
  mode: AssistantMode,
  context: { siteEvidenceSummary: string; modeEvidenceSummary: string },
) {
  const evidenceText = `${context.siteEvidenceSummary}\n${context.modeEvidenceSummary}`;
  const needsExa = shouldUseExaForAssistant(message, mode, evidenceText).use;
  if (!needsExa || toolCalls.some((call) => call.name === "search_exa")) return toolCalls;
  return [
    ...toolCalls,
    {
      id: "model-router-exa-augment",
      name: "search_exa" as const,
      query: `${message.slice(0, 160)} 最新 财报 预测 风险 官方 source financial forecast risk`,
      freshness: "month" as const,
      maxResults: 10,
      reason: "高价值投研问题且站内证据不足，补充 Exa 高质量外部线索。",
    },
  ].slice(0, 5);
}

function buildSearchToolRouterMessages(message: string, mode: AssistantMode, context: { siteEvidenceSummary: string; modeEvidenceSummary: string }): DeepSeekMessage[] {
  const system = withCacheProtocol(
    [
      "你是 CSTD Alpha 助手的工具路由器。你只决定是否调用外部搜索工具，不输出最终答案。",
      "可用工具：search_anysearch 用于中文财经/公告/行业线索；search_searxng 用于免费元搜索补召回；search_exa 用于高价值、全球、英文、技术、产业链和站内证据不足的深度线索。",
      "不要要求用户必须提到 Exa、联网或搜索。只要问题需要最新公开信息、站内证据不足、涉及公司/行业预测/技术/风险/估值/订单/价格/库存/政策，就应主动调用合适工具。",
      "如果用户只是解释通用概念，且站内证据不是必要条件，可以不调用工具。",
      "如果调用工具，优先用 1-3 个高质量查询；高价值研究可同时调用 AnySearch、SearXNG、Exa。Exa 不必总用，但站内证据不足且问题有投资价值时应使用。",
      "工具 query 必须具体，包含公司/行业、年份或最新、关键指标，不要只复制用户原句。",
    ].join("\n"),
    "assistant-tool-router",
  );
  const payload = cacheStableUserContent({
    kind: "assistant-tool-router-context",
    stable: {
      mode,
      routingRules: ["external_search_when_latest_or_weak_evidence", "exa_for_high_value_global_or_technical_research", "no_tool_for_simple_concepts"],
    },
    volatile: {
      userMessage: message,
      siteEvidenceSummary: context.siteEvidenceSummary || "暂无站内证据。",
      modeEvidenceSummary: context.modeEvidenceSummary || "当前模式没有命中结构化证据。",
    },
  });
  return [
    { role: "system", content: system },
    { role: "user", content: payload },
  ];
}

function assistantSearchTools() {
  const parameters = {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "具体搜索查询，包含研究对象、年份/最新口径和关键指标。" },
      reason: { type: "string", description: "为什么需要这个搜索。" },
      freshness: { type: "string", enum: ["day", "week", "month", "year"], description: "证据新鲜度，默认 month。" },
      maxResults: { type: "number", description: "返回结果上限，1-10。" },
    },
  };
  return [
    { type: "function", function: { name: "search_anysearch", description: "中文财经、公司公告、行业变化、政策风险的高质量搜索。", parameters } },
    { type: "function", function: { name: "search_searxng", description: "免费元搜索补充召回，用于发现新闻、网页和遗漏来源。", parameters } },
    { type: "function", function: { name: "search_exa", description: "高价值外部检索，适合全球/英文/技术/产业链/深度研究线索。", parameters } },
  ];
}

function normalizeSearchToolCalls(data: Record<string, unknown>): AssistantSearchToolCall[] {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return toolCalls.map(normalizeSearchToolCall).filter((call): call is AssistantSearchToolCall => Boolean(call)).slice(0, 5);
}

function normalizeSearchToolCall(value: unknown): AssistantSearchToolCall | null {
  if (!isRecord(value)) return null;
  const fn = isRecord(value.function) ? value.function : {};
  const name = typeof fn.name === "string" ? fn.name : "";
  if (name !== "search_anysearch" && name !== "search_searxng" && name !== "search_exa") return null;
  const args = parseToolArguments(fn.arguments);
  const query = stringOrFallback(args.query, "").slice(0, 220);
  if (!query) return null;
  const freshness = args.freshness === "day" || args.freshness === "week" || args.freshness === "month" || args.freshness === "year" ? args.freshness : "month";
  const maxResults = typeof args.maxResults === "number" && Number.isFinite(args.maxResults) ? Math.min(Math.max(Math.round(args.maxResults), 1), 10) : undefined;
  return {
    id: stringOrFallback(value.id, crypto.randomUUID()),
    name,
    query,
    reason: stringOrFallback(args.reason, "").slice(0, 180) || undefined,
    freshness,
    maxResults,
  };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function fallbackSearchToolCalls(message: string, mode: AssistantMode, context: { siteEvidenceSummary: string; modeEvidenceSummary: string }, reason: string): { toolCalls: AssistantSearchToolCall[]; reason: string } {
  const evidenceText = `${context.siteEvidenceSummary}\n${context.modeEvidenceSummary}`;
  if (!shouldTriggerExternalEvidence(message, mode, evidenceText)) return { toolCalls: [], reason };
  const queries = buildAssistantEvidenceQueries(message, mode).slice(0, 2);
  const calls: AssistantSearchToolCall[] = queries.map((query, index) => ({
    id: `fallback-${index}`,
    name: "search_anysearch",
    query: query.query,
    freshness: query.freshness ?? "month",
    maxResults: query.maxResults,
    reason: "规则兜底：高价值投研问题或站内证据不足。",
  }));
  if (shouldUseExaForAssistant(message, mode, evidenceText).use) {
    calls.push({
      id: "fallback-exa",
      name: "search_exa",
      query: `${message.slice(0, 160)} company industry financial official source risk`,
      freshness: "month",
      maxResults: 10,
      reason: "规则兜底：高价值研究且站内证据不足。",
    });
  }
  return { toolCalls: calls.slice(0, 4), reason };
}

async function executeAssistantSearchToolCalls(env: AssistantEnv, toolCalls: AssistantSearchToolCall[], signal: AbortSignal) {
  const anysearchQueries = toolCalls.filter((call) => call.name === "search_anysearch").map(toolCallToAnySearchQuery);
  const searxngQueries = toolCalls.filter((call) => call.name === "search_searxng").map(toolCallToAnySearchQuery);
  const exaCalls = toolCalls.filter((call) => call.name === "search_exa");
  const [anysearch, searxng, exaDecision] = await Promise.all([
    anysearchQueries.length && env.ANYSEARCH_API_KEY?.trim() ? fetchAnySearchEvidence({ queries: anysearchQueries, apiKey: env.ANYSEARCH_API_KEY, signal }) : Promise.resolve([]),
    searxngQueries.length && env.SEARXNG_ENDPOINTS?.trim() ? fetchSearxngEvidence({ queries: searxngQueries, endpoints: env.SEARXNG_ENDPOINTS, signal }) : Promise.resolve([]),
    executeExaToolCalls(env, exaCalls, signal),
  ]);
  const items = [...anysearch, ...searxng, ...exaDecision.items];
  const summary = `模型调用工具：${toolCalls.map((call) => call.name).join("、")}；AnySearch ${anysearch.length} 条，SearXNG ${searxng.length} 条，Exa ${exaDecision.exa.count} 条。`;
  return { items: dedupeExternalEvidence(items), exa: exaDecision.exa, summary };
}

function toolCallToAnySearchQuery(call: AssistantSearchToolCall): AnySearchQuery {
  return {
    query: call.query,
    topic: "assistant",
    sourceType: "news",
    maxResults: call.maxResults ?? 4,
    domains: ["finance", "business"],
    contentTypes: ["news", "web"],
    freshness: call.freshness ?? "month",
  };
}

async function executeExaToolCalls(env: AssistantEnv, toolCalls: AssistantSearchToolCall[], signal: AbortSignal) {
  if (!toolCalls.length) return { items: [], exa: { used: false, count: 0 } };
  if (!env.EXA_API_KEY?.trim()) return { items: [], exa: { used: false, count: 0, reason: "未配置EXA_API_KEY" } };
  if (!env.REPORT_CACHE) return { items: [], exa: { used: false, count: 0, reason: "缺少额度记录KV" } };
  const quota = await reserveExaQuota(env.REPORT_CACHE);
  if (!quota.allowed) return { items: [], exa: { used: false, count: 0, reason: "达到今日Exa自动调用上限", dailyCount: quota.count } };
  const items = await fetchExaEvidence({
    apiKey: env.EXA_API_KEY,
    signal,
    queries: toolCalls.map((call) => ({ ...toolCallToAnySearchQuery(call), maxResults: call.maxResults ?? 10 })),
  });
  return { items, exa: { used: true, count: items.length, dailyCount: quota.count } };
}

function dedupeExternalEvidence(items: AnySearchEvidence[]) {
  const seen = new Set<string>();
  const result: AnySearchEvidence[] = [];
  for (const item of items) {
    const key = item.url || `${item.source}:${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function buildAssistantEvidenceQueries(message: string, mode: AssistantMode): AnySearchQuery[] {
  const subject = message.slice(0, 120);
  const common = { topic: "assistant", sourceType: "news" as const, maxResults: 4, domains: ["finance" as const, "business" as const], contentTypes: ["news" as const, "web" as const], freshness: "month" as const };
  if (mode === "industry") {
    return [
      { ...common, query: `${subject} 行业硬数据 价格 库存 产能 销量 开工率 景气` },
      { ...common, query: `${subject} 政策 监管 文件 出口管制 集采 补贴` },
      { ...common, query: `${subject} 风险 亏损 过剩 需求下滑 价格下跌 泡沫` },
    ];
  }
  const targetQueries = [
    { ...common, query: `${subject} 财报 业绩预告 业绩快报 经营现金流 毛利率 净利润` },
    { ...common, query: `${subject} 行业 价格 销量 库存 订单 批价 竞争格局` },
    { ...common, query: `${subject} 风险 监管 政策 负面事件 估值 下调` },
  ];
  if (/(技术|优势|人形机器人|大脑|小脑|协调|产品|专利|算法|控制|模型)/.test(message)) {
    targetQueries.push({ ...common, query: `${subject} 技术 产品 专利 运动控制 大模型 协调性 商业化` });
  }
  return targetQueries;
}

export function resolveAssistantResearchContext(
  userMessage: string,
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>,
) {
  if (containsLikelyResearchSubject(userMessage)) return { message: userMessage, promptMessage: userMessage };
  if (!isFollowUpResearchQuestion(userMessage)) return { message: userMessage, promptMessage: userMessage };
  const lastUserSubject = [...recentMessages]
    .reverse()
    .find((message) => message.role === "user" && containsLikelyResearchSubject(message.content))?.content;
  if (!lastUserSubject) return { message: userMessage, promptMessage: userMessage };
  const message = `${lastUserSubject}\n${userMessage}`;
  return {
    message,
    promptMessage: `${userMessage}\n\n[对话承接]\n本轮问题延续上一轮研究对象：${lastUserSubject}`,
  };
}

export function shouldAutoUseResearchEvidence(message: string) {
  return containsLikelyResearchSubject(message) && isHighValueResearchQuestion(message);
}

export function shouldAnswerDirectlyWithoutClarification(message: string) {
  if (!containsLikelyResearchSubject(message)) return false;
  if (/(能买吗|买不买|该不该|怎么操作|怎么样\??$|如何操作)/.test(message)) return false;
  return /(今年|业绩|预估|预测|净利润|营收|利润|估值|现金流|财报|风险|技术|优势|人形机器人|大脑|小脑|协调|竞争|订单|库存|价格|批价|行业|影响|周期|反转|修复|出清|到底|框架|反证|反驳|泡沫|区分|平稳现金流|高股息|投资价值)/.test(message);
}

export function shouldTriggerExternalEvidence(message: string, mode: AssistantMode, evidenceSummary: string) {
  if (/(最新|联网|查一下|搜索|新闻|今天|刚刚|实时|全球|海外|英文|Exa|深搜)/i.test(message)) return true;
  if (mode !== "chat" && isHighValueResearchQuestion(message)) return true;
  if (shouldAutoUseResearchEvidence(message)) return true;
  return containsLikelyResearchSubject(message) && /(未命中|不足|暂无|缺少|缺|必须依赖|外部搜索|证据包为空|无法)/.test(evidenceSummary) && isHighValueResearchQuestion(message);
}

export function shouldTreatAsSimpleGeneralChat(message: string, mode: AssistantMode) {
  if (mode !== "chat") return false;
  if (containsLikelyResearchSubject(message)) return false;
  if (/(最新|联网|查一下|搜索|新闻|今天|刚刚|实时|全球|海外|英文|Exa|深搜)/i.test(message)) return false;
  return /(解释|什么是|为什么|区别|用.*句话|一句话|两句话|概念|定义|怎么算|含义)/.test(message);
}

function containsLikelyResearchSubject(message: string) {
  const hasTickerLikeToken = (message.match(/\b[A-Z]{1,5}\b/g) ?? []).some((token) => !COMMON_FINANCIAL_ACRONYMS.has(token.toUpperCase()));
  return hasTickerLikeToken || /\d{5,6}|茅台|宁德时代|优必选|腾讯|阿里|美团|小米|比亚迪|万科|英伟达|Nvidia|NVDA|苹果|Apple|中芯国际|港交所|紫金矿业|药明康德|泡泡玛特|中远海能|海底捞|拼多多|中国移动|中国电信|中国联通|光伏|白酒|航运|银行|高股息|机器人|AI算力|算力|港股互联网|互联网平台|低空经济|消费电子|地产|半导体|电网|储能|锂电|创新药|CXO|煤炭|水泥|钢铁|铜矿|固态电池|核电/i.test(message);
}

const COMMON_FINANCIAL_ACRONYMS = new Set(["ROE", "ROIC", "FCF", "DCF", "EPS", "PE", "PB", "PS", "PEG", "EBIT", "EBITDA", "CAPEX", "OPEX", "WACC", "CAGR", "TAM", "GDP", "CPI", "PMI", "IPO", "ETF", "REIT"]);

function isHighValueResearchQuestion(message: string) {
  return /(今年|业绩|预估|预测|净利润|营收|利润|增长|估值|现金流|财报|公告|技术|优势|人形机器人|大脑|小脑|协调|竞争|风险|订单|库存|价格|批价|行业|公司|股票|能买吗|持有|买入|卖出|影响|周期|反转|修复|出清|到底|框架|反证|反驳|泡沫|区分|高股息|平稳现金流|产业链|投资价值|AI|硬件|换机|智能驾驶)/.test(message);
}

function isFollowUpResearchQuestion(message: string) {
  return /(根据现有|继续|那|这个|它|该公司|这家公司|上述|前面|进行预测|预测|预估|怎么看|大脑|小脑|协调)/.test(message);
}

export function shouldIncludeRecentAssistantContext(message: string) {
  if (/(继续|接着|刚才|上次|之前|前面|上述|上面|这个|这些|它|该公司|这家公司|前一个|上一条|你刚才|你上面)/.test(message)) return true;
  return !containsLikelyResearchSubject(message) && isFollowUpResearchQuestion(message);
}

function guardForecastLanguage(text: string, message: string) {
  if (shouldTreatAsSimpleGeneralChat(message, "chat")) return text;
  if (!/(业绩|预估|预测|净利润|营收|利润)/.test(message) || !text.trim()) return text;
  const guarded = text
    .replace(/(\d{4}年)实际值/g, "$1基数线索")
    .replace(/(\d{4}年)实际/g, "$1基数线索")
    .replace(/(全年|归母净利润|营收)实际值/g, "$1基数线索")
    .replace(/证据等级[：:]\s*中至高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*中高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*较高/g, "证据等级：中");
  if (/口径说明：/.test(guarded)) return guarded;
  return `口径说明：以下为基于本轮站内证据和外部搜索线索的情景测算；未逐条核对官方公告的历史基数，不应把搜索摘要当作确定财务事实。\n\n${guarded}`;
}

function guardAssistantOutputLanguage(text: string, message: string, externalEvidence?: ExternalEvidenceResult) {
  return cleanAssistantFormatting(
    guardExternalEvidenceConsistency(
      guardExternalEvidenceLevel(
        guardUnauditedStrongFactLanguage(guardStaleHistoryLanguage(guardForecastLanguage(text, message))),
        message,
        externalEvidence,
      ),
      externalEvidence,
    ),
  );
}

function guardStaleHistoryLanguage(text: string) {
  return text
    .replace(/当前无新增证据[，,、\s]*/g, "")
    .replace(/本次无新增站内证据或外部检索信息修正此前判断[，,。；;\s]*/g, "")
    .replace(/本轮无新增[^。\n]*(站内|外部|证据|检索)[^。\n]*[。；;]?\s*/g, "")
    .replace(/本次无新增站内证据[，,、\s]*/g, "")
    .replace(/维持此前测算口径[，,、\s]*/g, "本轮测算口径：")
    .replace(/与上次(?:判断|回答)?完全一致[，,。；;\s]*/g, "")
    .replace(/口径与上次完全一致[，,。；;\s]*/g, "")
    .replace(/与前次口径完全相同/g, "本轮口径")
    .replace(/与上次回答完全一致/g, "本轮判断")
    .replace(/此前结论保持不变[——\-:：\s]*/g, "本轮判断：")
    .replace(/维持此前结论[——\-:：\s]*/g, "本轮判断：")
    .replace(/此前结论/g, "本轮判断");
}

function guardUnauditedStrongFactLanguage(text: string) {
  return text
    .replace(/上市\d+年首次业绩双降/g, "业绩承压待核验线索")
    .replace(/上市以来首次业绩双降/g, "业绩承压待核验线索")
    .replace(/首次业绩双降/g, "业绩承压待核验线索")
    .replace(/业绩双降/g, "业绩承压待核验线索")
    .replace(/营收[和与、及]?利润首次双降/g, "营收和利润承压待核验线索")
    .replace(/营收[和与、及]?利润双降/g, "营收和利润承压待核验线索")
    .replace(/收入[和与、及]?利润首次双降/g, "收入和利润承压待核验线索")
    .replace(/收入[和与、及]?利润双降/g, "收入和利润承压待核验线索")
    .replace(/利润[和与、及]?收入首次双降/g, "利润和收入承压待核验线索")
    .replace(/利润[和与、及]?收入双降/g, "利润和收入承压待核验线索")
    .replace(/营收利润双降/g, "营收和利润承压待核验线索")
    .replace(/首次年度亏损/g, "年度亏损待核验线索");
}

function guardExternalEvidenceConsistency(text: string, externalEvidence?: ExternalEvidenceResult) {
  if (!externalEvidence?.exa.used || externalEvidence.exa.count <= 0) return text;
  return text
    .replace(/Exa无可用结果/g, "Exa返回了外部线索，但硬证据强度有限")
    .replace(/Exa未返回可用结果/g, "Exa返回了外部线索，但硬证据强度有限")
    .replace(/本轮检索未返回任何([^。\n]*)条目/g, "本轮检索返回了外部线索，但$1条目的硬证据强度有限")
    .replace(/本轮检索未返回任何([^。\n]*)相关条目/g, "本轮检索返回了相关外部线索，但硬证据强度有限")
    .replace(/外部搜索（Exa）：本轮检索未返回任何([^。\n]*)/g, "外部搜索（Exa）：本轮返回了外部线索，但$1的硬证据强度有限");
}

function guardExternalEvidenceLevel(text: string, message: string, externalEvidence?: ExternalEvidenceResult) {
  if (!externalEvidence || !/(Exa|AnySearch|SearXNG|外部搜索|海外|全球|GCC|印度|美国|季度报告|市场新闻|S&P)/i.test(text)) return text;
  const likelyChinaOrAh = /(A股|港股|中国|银行股|高股息|四大行|国有大行|茅台|宁德时代|腾讯|优必选|比亚迪|万科|招商银行|工商银行|建设银行|农业银行|中国银行)/i.test(message + text);
  const evidenceGradeDependsOnSearch =
    /证据等级[：:][^\n。]*(Exa|AnySearch|SearXNG|外部搜索|海外|全球|GCC|印度|美国|S&P|券商研报|行业新闻|市场新闻|多地区)/i.test(text) ||
    /(Exa|AnySearch|SearXNG|外部搜索)[^。]*(证据等级[：:]\s*(高|较高|中高|中至高|强))/i.test(text);
  const hasDirectChinaHardSource = /(央行|金融监管总局|交易所公告|公司公告|上市银行年报|上市银行季报|官方统计|监管文件)/.test(text);
  if (!likelyChinaOrAh && !evidenceGradeDependsOnSearch) return text;
  if (hasDirectChinaHardSource && !evidenceGradeDependsOnSearch) return text;
  return text
    .replace(/证据等级[：:]\s*中至高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*中高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*较高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*强/g, "证据等级：中");
}

function cleanAssistantFormatting(text: string) {
  return removeEmptyMarkdownSections(text)
    .replace(/^结构化表格\s*\d*\s*$/gim, "")
    .replace(/反证条件（支持“?稳赚”?）/g, "削弱反驳的条件")
    .replace(/反证条件\(支持“?稳赚”?\)/g, "削弱反驳的条件")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeEmptyMarkdownSections(text: string) {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isPotentialEmptyHeading(line)) {
      kept.push(line);
      continue;
    }
    let firstNonBlank = index + 1;
    while (firstNonBlank < lines.length && !lines[firstNonBlank].trim()) firstNonBlank += 1;
    if (/^[-—_]{3,}$/.test(lines[firstNonBlank]?.trim() ?? "")) {
      let afterRule = firstNonBlank + 1;
      while (afterRule < lines.length && (!lines[afterRule].trim() || /^[-—_]{3,}$/.test(lines[afterRule].trim()))) afterRule += 1;
      index = afterRule - 1;
      continue;
    }
    let cursor = index + 1;
    let hasContent = false;
    while (cursor < lines.length && !isAnyMarkdownHeading(lines[cursor])) {
      const current = lines[cursor].trim();
      if (current && !/^[-—_]{3,}$/.test(current)) {
        hasContent = true;
        break;
      }
      cursor += 1;
    }
    if (hasContent) {
      kept.push(line);
    } else {
      index = cursor - 1;
    }
  }
  return kept.join("\n");
}

function isPotentialEmptyHeading(line: string) {
  return /^#{1,6}\s*(核心理由|证据|证据等级|反驳用户(?:典型)?观点|我可能错在哪里(?:（[^）]*）)?|下一步跟踪|后续跟踪|反证条件|正向确认信号)\s*[：:]?\s*$/.test(line.trim());
}

function isAnyMarkdownHeading(line: string) {
  return /^#{1,6}\s+\S+/.test(line.trim());
}

function formatExternalEvidence(items: AnySearchEvidence[], exa: { used: boolean; count: number; reason?: string }) {
  const exaStatus = exa.used && exa.count === 0 ? "Exa状态：本轮已尝试 Exa，但没有返回可用结果；禁止把其他搜索源说成 Exa。" : "";
  if (!items.length) return exaStatus;
  return [
    exaStatus,
    `外部搜索线索（仅用于发现和补充，不是财报/公告/价格/销量硬数据；检索服务不等于原始发布方）：${items
      .map((item, index) => `E${index + 1} ${item.title}（检索=${item.source}，类型=${item.sourceType}，来源域名=${hostLabel(item.url)}，日期=${item.publishedAt || "unknown"}）：${item.summary}`)
      .join("；")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function hostLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export function shouldUseExaForAssistant(message: string, mode: AssistantMode, evidenceSummary: string) {
  if (/Exa|exa|深搜|高质量来源|英文来源|全球来源/.test(message)) return { use: true, reason: "用户明确要求高质量外部检索" };
  const highValue = mode !== "chat" && /(最新|全球|海外|英文|竞争|产业链|政策|监管|风险|财报|估值|对比|数据|订单|库存|价格|出海|海外|今年|业绩|预估|预测|净利润|营收|利润|技术|优势|人形机器人|大脑|小脑|协调|影响|周期|反转|修复|出清|到底|框架|反证|反驳|泡沫|区分|高股息|平稳现金流|投资价值|AI|硬件|换机|智能驾驶|消费电子|光伏|白酒|银行|航运|机器人|低空经济)/.test(message);
  const evidenceWeak = /(未命中|不足|暂无|缺少|缺|必须依赖|外部搜索|证据包为空|无法)/.test(evidenceSummary);
  if (highValue && evidenceWeak) return { use: true, reason: "研究问题高价值且站内证据不足" };
  if (highValue) return { use: true, reason: "研究问题高价值，补充Exa外部线索交叉验证" };
  return { use: false, reason: "不是Exa高价值触发场景" };
}

const ASSISTANT_EXA_DAILY_AUTO_LIMIT = 80;

async function reserveExaQuota(cache: KVNamespace, now = new Date()) {
  const key = `assistant:exa:auto:${now.toISOString().slice(0, 10)}`;
  const current = Number((await cache.get(key).catch(() => null)) || "0");
  if (current >= ASSISTANT_EXA_DAILY_AUTO_LIMIT) return { allowed: false, count: current };
  const next = current + 1;
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const expirationTtl = Math.max(3600, Math.floor((tomorrow.getTime() - now.getTime()) / 1000) + 3600);
  await cache.put(key, String(next), { expirationTtl }).catch(() => undefined);
  return { allowed: true, count: next };
}

async function buildModeEvidenceSummary(db: D1Database, userKey: string, message: string, mode: AssistantMode, options: { strictTargetMatch?: boolean } = {}) {
  if (mode === "chat") return "";
  if (mode === "target") return buildTargetEvidenceSummary(db, userKey, message, options);
  return buildIndustryEvidenceSummary(db, message);
}

async function buildTargetEvidenceSummary(db: D1Database, userKey: string, message: string, options: { strictTargetMatch?: boolean } = {}) {
  const watchlist = await db
    .prepare(`SELECT id, company_name, ticker, market FROM user_watchlist WHERE user_key = ?1 ORDER BY added_at DESC LIMIT 80`)
    .bind(userKey)
    .all<{ id: string; company_name: string; ticker: string; market: string }>()
    .catch(() => ({ results: [] }));
  const matched = (watchlist.results ?? []).filter((item) => watchlistItemMatchesMessage(item, message)).slice(0, 3);
  if (options.strictTargetMatch && !matched.length) {
    return "标的研究证据：当前问题疑似公司研究，但站内自选股和公司证据包未命中明确主体；必须使用外部搜索补证据，且不能引用无关自选股。";
  }
  const targets = matched.length ? matched : (watchlist.results ?? []).slice(0, 3);
  if (!targets.length) return "标的研究证据：自选股为空，站内标的证据不足；必须依赖用户输入和外部搜索，结论应保守。";
  const targetIds = new Set(targets.map((item) => item.id));
  const analyses = await db
    .prepare(`SELECT watchlist_id, company_name, template_title, score, verdict, summary FROM template_analysis WHERE user_key = ?1 AND status = 'completed' ORDER BY updated_at DESC LIMIT 40`)
    .bind(userKey)
    .all<{ watchlist_id: string; company_name: string; template_title: string; score: number | null; verdict: string; summary: string }>()
    .catch(() => ({ results: [] }));
  const packages = await db
    .prepare(`SELECT watchlist_id, company_name, ticker, market, material_hash, evidence_hash, status, fetched_at FROM company_evidence_packages WHERE user_key = ?1 ORDER BY updated_at DESC LIMIT 80`)
    .bind(userKey)
    .all<{ watchlist_id: string; company_name: string; ticker: string; market: string; material_hash: string; evidence_hash: string; status: string; fetched_at: string }>()
    .catch(() => ({ results: [] }));
  const templateLines = (analyses.results ?? [])
    .filter((item) => targetIds.has(item.watchlist_id))
    .slice(0, 8)
    .map((item) => `${item.company_name}/${item.template_title}/评分${item.score ?? "NA"}/${item.verdict}：${item.summary.slice(0, 90)}`);
  const packageLines = (packages.results ?? [])
    .filter((item) => targetIds.has(item.watchlist_id))
    .slice(0, 5)
    .map((item) => `${item.company_name}(${item.ticker}/${item.market}) 证据包${item.status}，fetched_at=${item.fetched_at}，materialHash=${item.material_hash || item.evidence_hash}`);
  return [`标的研究模式：候选标的=${targets.map((item) => `${item.company_name}(${item.ticker}/${item.market})`).join("、")}`, templateLines.length ? `相关模板报告：${templateLines.join("；")}` : "相关模板报告：未命中，结论必须降级。", packageLines.length ? `公司证据包：${packageLines.join("；")}` : "公司证据包：未命中，必须补外部搜索或提示证据缺口。"].join("\n");
}

function watchlistItemMatchesMessage(item: { company_name: string; ticker: string; market: string }, message: string) {
  const upper = message.toUpperCase();
  if (upper.includes(item.ticker.toUpperCase())) return true;
  if (message.includes(item.company_name)) return true;
  return companyAliases(item.company_name).some((alias) => alias.length >= 2 && message.includes(alias));
}

function companyAliases(name: string) {
  const cleaned = name
    .replace(/股份有限公司|控股有限公司|集团股份|集团|股份|控股|科技|有限|公司|-W|Ｈ股|H股|A股/g, "")
    .trim();
  const aliases = new Set<string>([name, cleaned]);
  if (cleaned.length >= 4) aliases.add(cleaned.slice(-2));
  if (cleaned.length >= 5) aliases.add(cleaned.slice(-3));
  return [...aliases].filter((alias) => !["时代", "科技", "集团", "股份", "公司"].includes(alias));
}

async function buildIndustryEvidenceSummary(db: D1Database, message: string) {
  const radar = await db
    .prepare(
      `SELECT COALESCE(t.name, i.name, ri.id) AS topic, ri.stage, ri.conclusion, ri.confidence, ri.risk, ri.growth_score, ri.evidence_score, ri.evidence_count
       FROM radar_items ri
       LEFT JOIN themes t ON t.id = ri.theme_id
       LEFT JOIN industries i ON i.id = ri.industry_id
       JOIN radar_runs rr ON rr.id = ri.run_id
       WHERE rr.status = 'completed'
       ORDER BY rr.run_time DESC, ri.evidence_score DESC
       LIMIT 80`,
    )
    .all<{ topic: string; stage: string; conclusion: string | null; confidence: number | null; risk: number | null; growth_score: number | null; evidence_score: number | null; evidence_count: number }>()
    .catch(() => ({ results: [] }));
  const rows = radar.results ?? [];
  const matched = rows.filter((item) => item.topic && message.includes(item.topic)).slice(0, 8);
  const selected = matched.length ? matched : rows.slice(0, 10);
  const evidence = await db
    .prepare(`SELECT title, source_type, published_at FROM evidence_items ORDER BY fetched_at DESC LIMIT 30`)
    .all<{ title: string; source_type: string; published_at: string | null }>()
    .catch(() => ({ results: [] }));
  if (!selected.length) return "行业研究证据：雷达结构化表未命中；必须依赖外部搜索，不能给强结论。";
  return [
    `行业研究模式：雷达候选=${selected.map((item) => `${item.topic}/${item.stage}/增长${item.growth_score ?? "NA"}/风险${item.risk ?? "NA"}/证据${item.evidence_count}`).join("；")}`,
    `最近行业证据样本：${(evidence.results ?? []).slice(0, 12).map((item) => `${item.title}（${item.source_type}/${item.published_at || "unknown"}）`).join("；") || "无"}`,
  ].join("\n");
}

function consumeSseBuffer(buffer: string) {
  const parts = buffer.split("\n\n");
  const remainder = parts.pop() ?? "";
  const items: string[] = [];
  for (const part of parts) {
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith("data:")) items.push(line.slice(5).trim());
    }
  }
  return { items, remainder };
}

function extractDeltaText(data: Record<string, unknown>) {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const delta = first?.delta as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  return typeof delta?.content === "string" ? delta.content : typeof message?.content === "string" ? message.content : "";
}

async function generateReviewedResearchAnswer(input: {
  env: AssistantEnv;
  messages: DeepSeekMessage[];
  userMessage: string;
  mode: AssistantMode;
  signal: AbortSignal;
}): Promise<{ text: string; usage: AssistantUsage; review?: unknown }> {
  const startedAt = Date.now();
  const answerResponse = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(
      buildDeepSeekRequestBody({
        model: ASSISTANT_MODEL,
        messages: input.messages,
        maxTokens: 3600,
        reasoningEffort: ASSISTANT_REASONING_EFFORT,
        temperature: 0.08,
        stream: false,
        responseFormat: null,
        thinking: { type: "enabled" },
      }),
    ),
    signal: input.signal,
  });
  if (!answerResponse.ok) return { text: "", usage: { model: ASSISTANT_MODEL, reasoningEffort: ASSISTANT_REASONING_EFFORT, elapsedMs: Date.now() - startedAt } };
  const answerData = (await answerResponse.json()) as Record<string, unknown>;
  const answer = extractMessageContent(answerData);
  const answerUsage = parseDeepSeekUsage(answerData.usage);
  const review = await reviewResearchAnswer({ env: input.env, userMessage: input.userMessage, mode: input.mode, answer, signal: input.signal });
  const text = selectReviewedResearchText(answer, review.revisedAnswer, input.userMessage, input.mode);
  return {
    text,
    review: review.raw,
    usage: {
      model: ASSISTANT_MODEL,
      reasoningEffort: ASSISTANT_REASONING_EFFORT,
      ...answerUsage,
      totalTokens: (answerUsage.totalTokens ?? 0) + (review.usage.totalTokens ?? 0) || answerUsage.totalTokens,
      promptTokens: (answerUsage.promptTokens ?? 0) + (review.usage.promptTokens ?? 0) || answerUsage.promptTokens,
      completionTokens: (answerUsage.completionTokens ?? 0) + (review.usage.completionTokens ?? 0) || answerUsage.completionTokens,
      promptCacheHitTokens: (answerUsage.promptCacheHitTokens ?? 0) + (review.usage.promptCacheHitTokens ?? 0) || answerUsage.promptCacheHitTokens,
      promptCacheMissTokens: (answerUsage.promptCacheMissTokens ?? 0) + (review.usage.promptCacheMissTokens ?? 0) || answerUsage.promptCacheMissTokens,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

function selectReviewedResearchText(answer: string, revisedAnswer: string | undefined, userMessage: string, mode: AssistantMode) {
  if (!revisedAnswer) return isUnsatisfactoryEvidenceOnlyAnswer(answer) ? buildConstructiveEvidenceGapAnswer(userMessage, mode) : answer;
  const originalUnsatisfactory = isUnsatisfactoryEvidenceOnlyAnswer(answer);
  if (!originalUnsatisfactory && answer.length >= 1000 && revisedAnswer.length < Math.min(700, answer.length * 0.45)) {
    return answer;
  }
  return revisedAnswer;
}

function buildConstructiveEvidenceGapAnswer(userMessage: string, mode: AssistantMode) {
  const subject = userMessage.split(/\n/)[0]?.slice(0, 80) || "当前问题";
  const modeLabel = mode === "industry" ? "行业" : "标的";
  if (/(业绩|预估|预测|净利润|营收|利润)/.test(userMessage)) {
    return [
      `结论：${subject} 不能只停在“资料不够”，当前应给低置信情景测算。`,
      "证据等级：低。请把下面结果视为可更新的估算框架，而不是确定预测。",
      "核心理由：先用已披露季度增速、历史全年基数、价格/销量/渠道线索和行业景气做交叉；若缺少其中任一项，就给保守、中性、乐观三档，而不是单点预测。",
      "情景测算：保守情景为增长明显低于最近季度趋势；中性情景为全年增速接近最近季度或一致预期；乐观情景需要价格、销量、结构或成本端至少两个变量改善。",
      "反驳用户观点：如果只因为品牌、龙头地位或上一轮高增长就推出全年高增，这是不充分的；需要看到利润率、现金流和终端价格同时验证。",
      `我可能错在哪里：${modeLabel} 的最新公告、券商一致预期或价格数据如果已经变化，本轮低置信区间需要立刻重算。`,
      "下一步跟踪：最近一期财报、管理层指引、核心产品价格、销量/订单、库存、现金流和估值分位。",
    ].join("\n");
  }
  return [
    `结论：${subject} 当前应输出低置信判断，而不是停止回答。`,
    "证据等级：低。可用证据只够形成方向性判断，不能形成高置信投资结论。",
    "核心理由：先列出已知事实，再给最可能解释、反证条件和需要补齐的数据。",
    "反驳用户观点：如果用户把单一新闻、单家公司样本或概念叙事当作充分证据，这个逻辑不成立。",
    "我可能错在哪里：若最新公告、官方统计或公司级硬数据已经更新，本轮判断可能被推翻。",
    "下一步跟踪：补公司公告、财务指标、行业价格/销量/库存/订单、竞争格局和政策变化。",
  ].join("\n");
}

async function reviewResearchAnswer(input: { env: AssistantEnv; userMessage: string; mode: AssistantMode; answer: string; signal: AbortSignal }): Promise<{ revisedAnswer?: string; usage: ReturnType<typeof parseDeepSeekUsage>; raw?: unknown }> {
  try {
    const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify(
        buildDeepSeekRequestBody({
          model: ASSISTANT_MODEL,
          messages: buildRationalReviewMessages(input),
          maxTokens: 1200,
          reasoningEffort: ASSISTANT_REASONING_EFFORT,
          temperature: 0,
          responseFormat: { type: "json_object" },
          stream: false,
          thinking: { type: "enabled" },
        }),
      ),
      signal: input.signal,
    });
    if (!response.ok) return { usage: {} };
    const data = (await response.json()) as Record<string, unknown>;
    const content = extractMessageContent(data);
    const parsed = parseRationalReview(content);
    return { revisedAnswer: parsed.revisedAnswer, raw: parsed.raw, usage: parseDeepSeekUsage(data.usage) };
  } catch {
    return { usage: {} };
  }
}

function buildRationalReviewMessages(input: { userMessage: string; mode: AssistantMode; answer: string }): DeepSeekMessage[] {
  const system = withCacheProtocol(
    [
      "你是 CSTD Alpha 的理性审查器，只输出 JSON。",
      "检查研究回答是否迎合用户、证据不足却下强结论、缺少反证、把新闻当硬数据、没有反驳明显错误观点、或输出空话。",
      "如果回答合格，输出 {\"passed\":true}。",
      "如果不合格，输出 {\"passed\":false,\"issues\":[...],\"revisedAnswer\":\"修正后的完整中文回答\"}。",
      "修正后的回答必须保留结构：结论、证据等级、核心理由、反驳用户观点、我可能错在哪里、下一步跟踪。",
      "不要编造新事实；证据薄时降级为低置信情景测算或观察，但禁止只写“证据不足、无法回答”。",
      "如果草稿只是在说无法预测、无法判断、证据不足，必须改写为有用回答：列出可用证据、低置信情景/区间、关键假设、反证条件、下一步跟踪。",
      "重点检查数字一致性：同比增速、基数、区间、季度外推之间不能互相矛盾；若无法校验基数，必须把区间和证据等级下调。",
      "重点检查来源口径：外部搜索线索不能被写成公司公告、官方统计、内部记录或硬数据；检索服务不等于原始发布方。",
      "重点检查证据等级：不能因为 Exa/AnySearch/SearXNG 返回多条新闻或海外案例就给高证据等级；若缺少直接相关财报、公告、监管或官方统计，必须降为中或低。",
      "重点检查证据等级：证据等级段落如果写明来自 Exa 检索、多地区新闻、券商研报、S&P 报告、海外案例、GCC、印度或美国，最高只能是中，不能是高/中高/较高/中至高。",
      "重点检查跨市场类比：海外银行、海外公司或海外行业案例只能作为风险机制类比，不能直接证明中国/A股/港股标的；需要在回答中写明适用边界。",
      "重点检查反驳类问题：必须拆分“用户观点中合理的部分”和“错误的绝对化部分”；例如高股息可以是策略，但“稳赚”必须被明确反驳。",
      "重点检查反驳表格：不要把反证条件写成“支持稳赚”；应写为“削弱反驳的条件”或“我可能错在哪里”。",
      "重点检查格式：禁止空标题、空章节和只有横线的章节；Markdown 表格必须有具体标题，不能写“结构化表格1/2/3”。",
      "重点检查业绩预估：没有站内财报或官方公告支撑的基数，不能写成“实际值”；只能写“外部线索/券商预测显示”或“待核验基数”。",
      "重点检查事实口径：没有明确证据时，禁止写“营收利润双降”“上市首次亏损”“首次下滑”等强事实；若只是搜索线索或推断，必须改成“待核验线索”。",
      "重点检查事实口径：没有明确证据时，禁止写“首次业绩双降”“业绩双降”“上市25年首次业绩双降”等强事实；若只是搜索线索或推断，必须改成“业绩承压待核验线索”。",
    ].join("\n"),
    "assistant-rational-review",
  );
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: cacheStableUserContent({
        kind: "assistant-rational-review-context",
        stable: { mode: input.mode, requiredSections: ["结论", "证据等级", "核心理由", "反驳用户观点", "我可能错在哪里", "下一步跟踪"] },
        volatile: { userMessage: input.userMessage, draftAnswer: input.answer },
      }),
    },
  ];
}

function parseRationalReview(content: string) {
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    return {
      raw: data,
      revisedAnswer: data.passed === false && typeof data.revisedAnswer === "string" && data.revisedAnswer.trim() ? data.revisedAnswer.trim() : undefined,
    };
  } catch {
    return { raw: content };
  }
}

async function askModelForClarification(input: {
  env: AssistantEnv;
  userMessage: string;
  memories: Array<{ category: string; content: string }>;
  threadSummary: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>;
  signal: AbortSignal;
}): Promise<{ request: AssistantChoiceRequest | null; usage?: AssistantUsage }> {
  const startedAt = Date.now();
  const messages = buildClarificationDecisionMessages(input);
  try {
    const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.env.DEEPSEEK_API_KEY}` },
      signal: input.signal,
      body: JSON.stringify(
        buildDeepSeekRequestBody({
          model: ASSISTANT_MODEL,
          messages,
          maxTokens: 850,
          reasoningEffort: ASSISTANT_REASONING_EFFORT,
          temperature: 0,
          responseFormat: { type: "json_object" },
          stream: false,
          thinking: { type: "enabled" },
        }),
      ),
    });
    if (!response.ok) return { request: null };
    const data = (await response.json()) as Record<string, unknown>;
    const content = extractMessageContent(data);
    const parsed = parseClarificationDecision(content);
    const usage: AssistantUsage = {
      model: ASSISTANT_MODEL,
      reasoningEffort: ASSISTANT_REASONING_EFFORT,
      ...parseDeepSeekUsage(data.usage),
      elapsedMs: Date.now() - startedAt,
    };
    return { request: parsed, usage };
  } catch {
    return { request: null };
  }
}

function buildClarificationDecisionMessages(input: {
  userMessage: string;
  memories: Array<{ category: string; content: string }>;
  threadSummary: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>;
}): DeepSeekMessage[] {
  const system = withCacheProtocol(
    [
      "你是 CSTD Alpha 助手的澄清判定器，只输出 JSON。",
      "目标：判断当前用户问题是否信息不足到不应直接回答。",
      "如果问题已足够清楚，或用户是在明确教你长期规则/偏好，输出 {\"needClarification\":false}。",
      "只有在直接回答会明显误导时才澄清：缺研究对象、缺时间维度、缺判断口径、多个分支冲突、风险偏好/动作目标缺失。",
      "如果需要澄清，只问当前最重要的一个问题；若还有第二个不确定点，等用户回答后下一轮再问。",
      "返回格式必须是 JSON：needClarification:boolean；需要澄清时包含 request，request 有 id/title/question/reason/customPlaceholder/options。",
      "options 必须正好 3 个，每个有 id/label/description；必须且只能有一个 recommended=true；需要用户自定义补充时可设置 requiresCustom=true。",
      "不要输出正式投资结论，不要解释 JSON 之外的内容。",
    ].join("\n"),
    "assistant-choice-request",
  );
  const context = cacheStableUserContent({
    kind: "assistant-choice-request-context",
    stable: {
      outputSchema: {
        needClarification: "boolean",
        request: "optional choice request with exactly three options",
      },
      confirmedMemories: input.memories,
      threadSummary: input.threadSummary || "暂无长期摘要。",
    },
    volatile: {
      recentMessages: input.recentMessages,
      currentUserMessage: input.userMessage,
    },
  });
  return [
    { role: "system", content: system },
    { role: "user", content: context },
  ];
}

function extractMessageContent(data: Record<string, unknown>) {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

function parseClarificationDecision(content: string): AssistantChoiceRequest | null {
  if (!content.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.needClarification !== true) return null;
  return normalizeChoiceRequest(data.request);
}

function normalizeChoiceRequest(value: unknown): AssistantChoiceRequest | null {
  if (!isRecord(value)) return null;
  const options = Array.isArray(value.options) ? value.options.map(normalizeChoiceOption).filter(isChoiceOption).slice(0, 3) : [];
  if (options.length !== 3) return null;
  const recommendedCount = options.filter((option) => option.recommended).length;
  const normalizedOptions = recommendedCount === 1 ? options : options.map((option, index) => ({ ...option, recommended: index === 0 }));
  const title = stringOrFallback(value.title, "先确认一下");
  const question = stringOrFallback(value.question, "你希望我优先按哪种口径继续？");
  const reason = stringOrFallback(value.reason, "这个问题存在多个合理回答方向，先确认口径可以避免误判。");
  return {
    id: stringOrFallback(value.id, `choice-${Date.now()}`).slice(0, 80),
    title: title.slice(0, 80),
    question: question.slice(0, 180),
    reason: reason.slice(0, 180),
    customPlaceholder: stringOrFallback(value.customPlaceholder, "也可以写你的具体补充。").slice(0, 120),
    options: normalizedOptions,
  };
}

function normalizeChoiceOption(value: unknown): AssistantChoiceOption | null {
  if (!isRecord(value)) return null;
  const id = stringOrFallback(value.id, "");
  const label = stringOrFallback(value.label, "");
  const description = stringOrFallback(value.description, "");
  if (!id || !label || !description) return null;
  return {
    id: id.slice(0, 64),
    label: label.slice(0, 40),
    description: description.slice(0, 140),
    recommended: value.recommended === true,
    requiresCustom: value.requiresCustom === true,
  };
}

function isChoiceOption(value: AssistantChoiceOption | null): value is AssistantChoiceOption {
  return value !== null;
}

function stringOrFallback(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeAssistantMode(value: unknown): AssistantMode {
  return value === "target" || value === "industry" || value === "chat" ? value : "chat";
}
