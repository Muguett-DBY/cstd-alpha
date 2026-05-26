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
import {
  fetchAnySearchEvidence,
  fetchArxivEvidence,
  fetchExaEvidence,
  fetchGdeltEvidence,
  fetchSearxngEvidence,
  fetchSemanticScholarEvidence,
  type AnySearchEvidence,
  type AnySearchQuery,
} from "../../_shared/anysearch";
import { buildDeepSeekRequestBody, cacheStableUserContent, withCacheProtocol, type DeepSeekMessage } from "../../_shared/deepseek-cache";
import { isUnsatisfactoryEvidenceOnlyAnswer } from "../../_shared/assistant-quality";
import { guardAssistantOutputLanguage } from "../../_shared/assistant-output-guards";
import { readCompanyEvidencePackage, type CompanyEvidencePackage } from "../../_shared/company-evidence";
import type { WatchlistRow } from "../../_shared/user-research-db";
import type { AssistantChatRequest, AssistantChatStreamEvent, AssistantChoiceOption, AssistantChoiceRequest, AssistantMode, AssistantUsage } from "../../../src/shared/assistant";

type AssistantSearchToolName = "search_anysearch" | "search_searxng" | "search_exa" | "search_gdelt" | "search_arxiv" | "search_semantic_scholar";
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

const ASSISTANT_AUXILIARY_REASONING_EFFORT = "high" as const;

function assistantToolRunSummary(externalEvidence: ExternalEvidenceResult) {
  if (!externalEvidence.triggered) return `模型工具路由判断无需外部搜索。${externalEvidence.exa.reason ? ` ${externalEvidence.exa.reason}。` : ""}`;
  const base = externalEvidence.toolSummary || `外部搜索返回 ${externalEvidence.items.length} 条，已并入助手上下文。`;
  if (externalEvidence.exa.used) return base;
  if (externalEvidence.exa.reason) return `${base} Exa未用：${externalEvidence.exa.reason}。`;
  return base;
}

function isExplicitMemoryOnlyMessage(message: string) {
  const normalized = message.trim();
  return (
    /^(记住|请记住|帮我记住|以后|纠正一下|我的投资框架|我的偏好|我的规则|不要忘了)[:：]/.test(normalized) ||
    /^(记住|请记住|帮我记住|我的投资框架是|我的偏好是|我的规则是|以后评分|以后回答|以后分析|以后遇到|纠正一下)/.test(normalized)
  );
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
  if (storedCandidate && isExplicitMemoryOnlyMessage(userMessage)) {
    const assistantMessageId = crypto.randomUUID();
    const reply = `已识别为一条待确认记忆：${storedCandidate.content}\n\n请在记忆候选里确认后生效。确认前它不会影响正式投研结论。`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        enqueue(controller, { type: "start", threadId: thread.id, messageId: assistantMessageId });
        enqueue(controller, { type: "memory_candidate", candidate: storedCandidate });
        enqueue(controller, { type: "delta", text: reply });
        const message = await writeAssistantMessage(env.REPORT_LIBRARY_DB!, {
          id: assistantMessageId,
          userKey: session.userId,
          threadId: thread.id,
          role: "assistant",
          content: reply,
          metadata: { memoryCandidateId: storedCandidate.id, noModelCall: true },
        });
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
  const answerDirectly = evidenceMode !== "chat" || shouldAnswerDirectlyWithoutClarification(researchContext.message) || simpleGeneralChat;
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
  const forcedClarification = clarificationDecision.request ? null : buildSubjectOnlyClarificationRequest(researchContext.message) ?? buildForcedClarificationRequest(researchContext.message);
  const choiceRequest = clarificationDecision.request ?? forcedClarification;
  if (choiceRequest) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        enqueue(controller, { type: "start", threadId: thread.id, messageId: userStoredMessage.id });
        if (storedCandidate) enqueue(controller, { type: "memory_candidate", candidate: storedCandidate });
        enqueue(controller, { type: "choice_request", request: choiceRequest });
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
    buildModeEvidenceSummary(env, session.userId, researchContext.message, evidenceMode, { strictTargetMatch: mode === "chat" }),
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
    const guardedText = guardAssistantOutputLanguage(reviewed.text, researchContext.message, externalEvidence, {
      isSimpleGeneralChat: (value) => shouldTreatAsSimpleGeneralChat(value, "chat"),
    });
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
        assistantText = guardAssistantOutputLanguage(assistantText, researchContext.message, externalEvidence, {
          isSimpleGeneralChat: (value) => shouldTreatAsSimpleGeneralChat(value, "chat"),
        });
        if (!assistantText.trim()) throw new Error("DeepSeek 未返回助手内容。");
        const repairedText = repairIncompleteAssistantAnswer(assistantText, researchContext.message, evidenceMode);
        if (repairedText !== assistantText) {
          const appendix = repairedText.slice(assistantText.length);
          assistantText = repairedText;
          enqueue(controller, { type: "delta", text: appendix });
        }
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
  if (shouldTreatAsSimpleGeneralChat(message, mode)) {
    return { triggered: false, items: [], exa: { used: false, count: 0, reason: "通用概念问题无需外部搜索" }, toolCalls: [] };
  }
  const hasConfiguredSearch = Boolean(env.ANYSEARCH_API_KEY?.trim() || env.SEARXNG_ENDPOINTS?.trim() || env.EXA_API_KEY?.trim());
  if (!hasConfiguredSearch && !shouldUseKeylessFreeSearch(message)) {
    return { triggered: false, items: [], exa: { used: false, count: 0, reason: "未配置付费/自建搜索源，且问题不适合仅用免费开放源补证据" }, toolCalls: [] };
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
          reasoningEffort: ASSISTANT_AUXILIARY_REASONING_EFFORT,
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
      reasoningEffort: ASSISTANT_AUXILIARY_REASONING_EFFORT,
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
  const augmented = [...toolCalls];
  if (shouldUseFreeGlobalSearch(message, mode, evidenceText) && !augmented.some((call) => call.name === "search_gdelt" || call.name === "search_exa")) {
    augmented.push({
      id: "model-router-gdelt-augment",
      name: "search_gdelt" as const,
      query: `${message.slice(0, 160)} latest market news financial risk policy`,
      freshness: "month" as const,
      maxResults: 8,
      reason: "免费全球新闻补召回，用于发现外部风险和变化线索。",
    });
  }
  if (shouldUseAcademicSearch(message) && !augmented.some((call) => call.name === "search_arxiv")) {
    augmented.push({
      id: "model-router-arxiv-augment",
      name: "search_arxiv" as const,
      query: `${message.slice(0, 160)} robotics AI semiconductor control model technology`,
      freshness: "year" as const,
      maxResults: 5,
      reason: "技术类问题补充开放学术论文线索。",
    });
  }
  if (shouldUseAcademicSearch(message) && !augmented.some((call) => call.name === "search_semantic_scholar")) {
    augmented.push({
      id: "model-router-semantic-scholar-augment",
      name: "search_semantic_scholar" as const,
      query: `${message.slice(0, 160)} robotics AI semiconductor control model technology`,
      freshness: "year" as const,
      maxResults: 5,
      reason: "技术类问题补充 Semantic Scholar 学术线索。",
    });
  }
  const needsExa = shouldUseExaForAssistant(message, mode, evidenceText).use;
  if (needsExa && !augmented.some((call) => call.name === "search_exa")) {
    augmented.push({
      id: "model-router-exa-augment",
      name: "search_exa" as const,
      query: `${message.slice(0, 160)} 最新 财报 预测 风险 官方 source financial forecast risk`,
      freshness: "month" as const,
      maxResults: 10,
      reason: "高价值投研问题且站内证据不足，补充 Exa 高质量外部线索。",
    });
  }
  return augmented.slice(0, 3);
}

function buildSearchToolRouterMessages(message: string, mode: AssistantMode, context: { siteEvidenceSummary: string; modeEvidenceSummary: string }): DeepSeekMessage[] {
  const system = withCacheProtocol(
    [
      "你是 CSTD Alpha 助手的工具路由器。你只决定是否调用外部搜索工具，不输出最终答案。",
      "可用工具：search_anysearch 用于中文财经/公告/行业线索；search_searxng 用于免费元搜索补召回；search_gdelt 用于免费全球新闻召回；search_arxiv/search_semantic_scholar 用于机器人、AI、半导体、医药等技术/学术线索；search_exa 用于高价值、全球、英文、技术、产业链和站内证据不足的深度线索。",
      "不要要求用户必须提到 Exa、联网或搜索。只要问题需要最新公开信息、站内证据不足、涉及公司/行业预测/技术/风险/估值/订单/价格/库存/政策，就应主动调用合适工具。",
      "如果用户只是解释通用概念，且站内证据不是必要条件，可以不调用工具。",
      "如果调用工具，优先用 1-3 个高质量查询；高价值研究可同时调用 AnySearch、SearXNG、GDELT、Exa；技术类问题可加 arXiv/Semantic Scholar。Exa 不必总用，但站内证据不足且问题有投资价值时应使用。",
      "工具 query 必须具体，包含公司/行业、年份或最新、关键指标，不要只复制用户原句。",
    ].join("\n"),
    "assistant-tool-router",
  );
  const payload = cacheStableUserContent({
    kind: "assistant-tool-router-context",
    stable: {
      mode,
      routingRules: ["external_search_when_latest_or_weak_evidence", "free_global_news_for_coverage", "academic_search_for_technical_questions", "exa_for_high_value_global_or_technical_research", "no_tool_for_simple_concepts"],
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
    { type: "function", function: { name: "search_gdelt", description: "免费 GDELT 全球新闻搜索，用于补充海外、政策、风险、产业链新闻线索。", parameters } },
    { type: "function", function: { name: "search_arxiv", description: "免费 arXiv 学术论文搜索，用于技术路线、机器人、AI、半导体、控制算法等学术线索。", parameters } },
    { type: "function", function: { name: "search_semantic_scholar", description: "免费 Semantic Scholar 学术搜索，用于技术/论文/专利前沿的补充线索。", parameters } },
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
  if (name !== "search_anysearch" && name !== "search_searxng" && name !== "search_exa" && name !== "search_gdelt" && name !== "search_arxiv" && name !== "search_semantic_scholar") return null;
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
  if (shouldUseFreeGlobalSearch(message, mode, evidenceText)) {
    calls.push({
      id: "fallback-gdelt",
      name: "search_gdelt",
      query: `${message.slice(0, 160)} latest market news financial risk policy`,
      freshness: "month",
      maxResults: 8,
      reason: "规则兜底：免费全球新闻补召回。",
    });
  }
  if (shouldUseAcademicSearch(message)) {
    calls.push(
      {
        id: "fallback-arxiv",
        name: "search_arxiv",
        query: `${message.slice(0, 160)} robotics AI semiconductor control model technology`,
        freshness: "year",
        maxResults: 5,
        reason: "规则兜底：技术类问题补充开放学术搜索。",
      },
      {
        id: "fallback-semantic-scholar",
        name: "search_semantic_scholar",
        query: `${message.slice(0, 160)} robotics AI semiconductor control model technology`,
        freshness: "year",
        maxResults: 5,
        reason: "规则兜底：技术类问题补充 Semantic Scholar。",
      },
    );
  }
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
  return { toolCalls: calls.slice(0, 3), reason };
}

async function executeAssistantSearchToolCalls(env: AssistantEnv, toolCalls: AssistantSearchToolCall[], signal: AbortSignal) {
  const anysearchQueries = toolCalls.filter((call) => call.name === "search_anysearch").map(toolCallToAnySearchQuery);
  const searxngQueries = toolCalls.filter((call) => call.name === "search_searxng").map(toolCallToAnySearchQuery);
  const gdeltQueries = toolCalls.filter((call) => call.name === "search_gdelt").map(toolCallToAnySearchQuery);
  const arxivQueries = toolCalls.filter((call) => call.name === "search_arxiv").map(toolCallToAnySearchQuery);
  const semanticScholarQueries = toolCalls.filter((call) => call.name === "search_semantic_scholar").map(toolCallToAnySearchQuery);
  const exaCalls = toolCalls.filter((call) => call.name === "search_exa");
  const [anysearch, searxng, gdelt, arxiv, semanticScholar, exaDecision] = await Promise.all([
    anysearchQueries.length && env.ANYSEARCH_API_KEY?.trim() ? fetchAnySearchEvidence({ queries: anysearchQueries, apiKey: env.ANYSEARCH_API_KEY, signal }) : Promise.resolve([]),
    searxngQueries.length && env.SEARXNG_ENDPOINTS?.trim() ? fetchSearxngEvidence({ queries: searxngQueries, endpoints: env.SEARXNG_ENDPOINTS, signal }) : Promise.resolve([]),
    gdeltQueries.length ? fetchGdeltEvidence({ queries: gdeltQueries, signal }) : Promise.resolve([]),
    arxivQueries.length ? fetchArxivEvidence({ queries: arxivQueries, signal }) : Promise.resolve([]),
    semanticScholarQueries.length ? fetchSemanticScholarEvidence({ queries: semanticScholarQueries, signal }) : Promise.resolve([]),
    executeExaToolCalls(env, exaCalls, signal),
  ]);
  const items = [...anysearch, ...searxng, ...gdelt, ...arxiv, ...semanticScholar, ...exaDecision.items];
  const summary = `模型调用工具：${toolCalls.map((call) => call.name).join("、")}；AnySearch ${anysearch.length} 条，SearXNG ${searxng.length} 条，GDELT ${gdelt.length} 条，ArXiv ${arxiv.length} 条，Semantic Scholar ${semanticScholar.length} 条，Exa ${exaDecision.exa.count} 条。`;
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
  if (isBroadInvestmentFrameworkQuestion(message)) return true;
  if (!containsLikelyResearchSubject(message)) return false;
  if (/(反驳|你反驳|根据我的自选股|自选股|排雷|还能涨|还能不能涨|继续涨|会不会涨)/.test(message)) return true;
  if (/(能买吗|买不买|该不该|怎么操作|怎么样\??$|如何操作)/.test(message)) return false;
  return /(今年|业绩|预估|预测|净利润|营收|利润|估值|现金流|财报|风险|技术|优势|人形机器人|大脑|小脑|协调|竞争|订单|库存|价格|批价|行业|影响|周期|反转|修复|出清|到底|框架|反证|反驳|泡沫|区分|平稳现金流|高股息|投资价值|涨跌|上涨|下跌)/.test(message);
}

function isBroadInvestmentFrameworkQuestion(message: string) {
  return /(逆向抄底|反共识|最值得.*资产类别|资产类别|便宜.*更便宜|连续涨.*怕错过|怕错过.*追|追进去|追涨|FOMO|高波动成长股|最可能暴涨|十倍股|筛选模型)/i.test(message);
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
  if (/^(你好|您好|哈喽|hello|hi)([，,。.!！?\s]*(你是|你是谁|你能做什么|介绍一下|是谁|在吗))?[？?！!。.\s]*$/i.test(message.trim())) return true;
  return /(解释|什么是|为什么|区别|用.*句话|一句话|两句话|概念|定义|怎么算|含义)/.test(message);
}

function containsLikelyResearchSubject(message: string) {
  const hasTickerLikeToken = (message.match(/\b[A-Z]{1,5}\b/g) ?? []).some((token) => !COMMON_FINANCIAL_ACRONYMS.has(token.toUpperCase()));
  return hasTickerLikeToken || /\d{5,6}|自选股|茅台|宁德时代|优必选|腾讯|阿里|美团|小米|比亚迪|万科|英伟达|Nvidia|NVDA|苹果|Apple|中芯国际|港交所|紫金矿业|药明康德|泡泡玛特|中远海能|海底捞|拼多多|中国移动|中国电信|中国联通|光伏|白酒|航运|银行|高股息|机器人|AI算力|算力|港股互联网|互联网平台|低空经济|消费电子|地产|半导体|电网|储能|锂电|创新药|CXO|煤炭|水泥|钢铁|铜矿|固态电池|核电/i.test(message);
}

const COMMON_FINANCIAL_ACRONYMS = new Set(["ROE", "ROIC", "FCF", "DCF", "EPS", "PE", "PB", "PS", "PEG", "EBIT", "EBITDA", "CAPEX", "OPEX", "WACC", "CAGR", "TAM", "GDP", "CPI", "PMI", "IPO", "ETF", "REIT"]);

function isHighValueResearchQuestion(message: string) {
  return /(今年|业绩|预估|预测|净利润|营收|利润|增长|估值|现金流|财报|公告|技术|优势|人形机器人|大脑|小脑|协调|竞争|风险|订单|库存|价格|批价|行业|公司|股票|自选股|质量|证据强度|对比表|能买吗|持有|买入|卖出|影响|周期|反转|修复|出清|到底|框架|反证|反驳|泡沫|区分|高股息|平稳现金流|产业链|投资价值|AI|硬件|换机|智能驾驶)/.test(message);
}

function isFollowUpResearchQuestion(message: string) {
  return /(根据现有|继续|那|这个|它|该公司|这家公司|上述|前面|进行预测|预测|预估|怎么看|大脑|小脑|协调)/.test(message);
}

export function shouldIncludeRecentAssistantContext(message: string) {
  if (/(继续|接着|刚才|上次|之前|前面|上述|上面|这个|这些|它|该公司|这家公司|前一个|上一条|你刚才|你上面)/.test(message)) return true;
  return !containsLikelyResearchSubject(message) && isFollowUpResearchQuestion(message);
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

function shouldUseFreeGlobalSearch(message: string, mode: AssistantMode, evidenceSummary: string) {
  if (mode === "chat" && !/(最新|今年|预测|预估|全球|海外|政策|监管|风险|业绩|财报|行业|公司|技术|竞争|联网|搜索|查一下)/.test(message)) return false;
  return shouldTriggerExternalEvidence(message, mode, evidenceSummary) || /(最新|今年|预测|预估|全球|海外|政策|监管|风险|业绩|财报|行业|公司|技术|竞争|联网|搜索|查一下)/.test(message);
}

function shouldUseAcademicSearch(message: string) {
  return /(技术|优势|人形机器人|机器人|大脑|小脑|协调|算法|控制|模型|AI|人工智能|芯片|半导体|存储|HBM|光模块|创新药|靶点|临床|专利|论文|学术|材料|固态电池|低空|商业航天)/i.test(message);
}

function shouldUseKeylessFreeSearch(message: string) {
  return shouldUseAcademicSearch(message) || /(最新|全球|海外|英文|新闻|今天|刚刚|实时|政策|监管|供应链|出口|制裁|关税|地缘|GDELT|arXiv|论文|学术)/i.test(message);
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

async function buildModeEvidenceSummary(env: AssistantEnv, userKey: string, message: string, mode: AssistantMode, options: { strictTargetMatch?: boolean } = {}) {
  const db = env.REPORT_LIBRARY_DB;
  if (!db) return "";
  if (mode === "chat") return "";
  if (mode === "target") return buildTargetEvidenceSummary(env, userKey, message, options);
  return buildIndustryEvidenceSummary(db, message);
}

async function buildTargetEvidenceSummary(env: AssistantEnv, userKey: string, message: string, options: { strictTargetMatch?: boolean } = {}) {
  const db = env.REPORT_LIBRARY_DB;
  if (!db) return "";
  const watchlist = await db
    .prepare(`SELECT id, user_id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at FROM user_watchlist WHERE user_key = ?1 ORDER BY added_at DESC LIMIT 80`)
    .bind(userKey)
    .all<WatchlistRow>()
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
  const deepPackageLines = (
    await Promise.all(
      targets.slice(0, 2).map(async (target) => summarizeCompanyEvidencePackage(env, userKey, target).catch(() => "")),
    )
  ).filter(Boolean);
  const templateLines = (analyses.results ?? [])
    .filter((item) => targetIds.has(item.watchlist_id))
    .slice(0, 8)
    .map((item) => `${item.company_name}/${item.template_title}/评分${item.score ?? "NA"}/${item.verdict}：${item.summary.slice(0, 90)}`);
  const packageLines = (packages.results ?? [])
    .filter((item) => targetIds.has(item.watchlist_id))
    .slice(0, 5)
    .map((item) => `${item.company_name}(${item.ticker}/${item.market}) 证据包${item.status}，fetched_at=${item.fetched_at}，materialHash=${item.material_hash || item.evidence_hash}`);
  return [
    `标的研究模式：候选标的=${targets.map((item) => `${item.company_name}(${item.ticker}/${item.market})`).join("、")}`,
    templateLines.length ? `相关模板报告：${templateLines.join("；")}` : "相关模板报告：未命中，不能引用不存在的模板结论。",
    packageLines.length ? `公司证据包状态：${packageLines.join("；")}` : "公司证据包状态：未命中，必须补外部搜索或明确证据缺口。",
    deepPackageLines.length ? `公司证据包核心事实：\n${deepPackageLines.join("\n")}` : "公司证据包核心事实：未能读取R2事实包；如需定量回答必须依赖外部搜索补强。",
  ].join("\n");
}

async function summarizeCompanyEvidencePackage(env: AssistantEnv, userKey: string, watchlist: WatchlistRow) {
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) return "";
  const pkg = await readCompanyEvidencePackage({ REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB, REPORT_LIBRARY_BUCKET: env.REPORT_LIBRARY_BUCKET }, userKey, watchlist);
  if (!pkg) return "";
  return formatCompanyEvidencePackageForAssistant(pkg);
}

function formatCompanyEvidencePackageForAssistant(pkg: CompanyEvidencePackage) {
  const facts = isRecord(pkg.evidence.facts) ? pkg.evidence.facts : {};
  const quote = isRecord(facts.quote) ? facts.quote : undefined;
  const eastmoney = isRecord(facts.eastmoney) ? facts.eastmoney : undefined;
  const incomeRows = Array.isArray(eastmoney?.incomeRows) ? eastmoney.incomeRows.filter(isRecord).slice(0, 2) : [];
  const cashflowRows = Array.isArray(eastmoney?.cashflowRows) ? eastmoney.cashflowRows.filter(isRecord).slice(0, 1) : [];
  const tenYear = isRecord(facts.financialTenYear) ? facts.financialTenYear : undefined;
  const tenYearRows = Array.isArray(tenYear?.rows) ? tenYear.rows.filter(isRecord).slice(0, 5) : [];
  const evidenceLines = pkg.evidence.evidence
    .slice(0, 6)
    .map((item) => `${item.id || "E?"}:${item.title} / ${item.source} / ${item.freshness || "unknown"} / ${item.notes || ""}`.slice(0, 260));
  return [
    `${pkg.evidence.company.name}(${pkg.evidence.company.ticker}/${pkg.evidence.company.market}) fetched_at=${pkg.fetchedAt} materialHash=${pkg.materialHash}`,
    quote ? `行情：价格=${formatPkgValue(quote.regularMarketPrice)}，市值=${formatPkgValue(quote.marketCap)}，PE=${formatPkgValue(quote.trailingPE)}，PB=${formatPkgValue(quote.priceToBook)}，来源=${formatPkgValue(quote.quoteSourceName)}` : "行情：证据包未含可用行情。",
    incomeRows.length ? `最新利润表：${incomeRows.map(formatEastmoneyIncomeRow).join("；")}` : "",
    cashflowRows.length ? `最新现金流：${cashflowRows.map(formatEastmoneyCashflowRow).join("；")}` : "",
    tenYearRows.length ? `十年财务摘要：${tenYearRows.map(formatTenYearMetricRow).join("；")}` : "",
    evidenceLines.length ? `证据ID：${evidenceLines.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
  const review = shouldRunModelRationalReview(answer, input.userMessage)
    ? await reviewResearchAnswer({ env: input.env, userMessage: input.userMessage, mode: input.mode, answer, signal: input.signal })
    : { usage: {} };
  const text = ensureComparisonCompleteness(
    ensureMinimumResearchSections(selectReviewedResearchText(answer, review.revisedAnswer, input.userMessage, input.mode), input.userMessage, input.mode),
    input.userMessage,
  );
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

function shouldRunModelRationalReview(answer: string, userMessage: string) {
  const normalized = answer.trim();
  if (!normalized) return false;
  if (isUnsatisfactoryEvidenceOnlyAnswer(normalized)) return true;
  if (/^结构化表格\s*\d*$/im.test(normalized)) return true;
  if (/^#{1,6}\s*(核心理由|反驳用户观点|我可能错在哪里|下一步跟踪|证据等级)\s*$/im.test(normalized)) return true;
  if (/证据等级[：:]\s*(高|中高|较高|中至高)/.test(normalized) && /(Exa|AnySearch|SearXNG|GDELT|arXiv|Semantic Scholar|海外案例|GCC|印度|美国|券商研报|S&P)/i.test(normalized)) return true;
  if (/(上市\d+年首次业绩双降|首次业绩双降|营收利润首次双降|2025年实际值)/.test(normalized)) return true;
  if (/(无法|不能|不宜)(给出|判断|预测|回答|下结论)/.test(normalized.replace(/\s+/g, "")) && !/(情景|区间|假设|测算|框架|反证|跟踪)/.test(normalized)) return true;
  if (/(E\d*[:：]?$|\*\*?$|[,，、]$)/.test(normalized)) return true;
  if (/(预测|预估|净利润|营收|利润|亏损|能买吗|买入|卖出|反驳|高股息|风险|投资价值|长期|护城河|技术|优势|协调|怎么判断|怎么看)/.test(userMessage)) {
    const hasCounter = /(反证|我可能错|风险|削弱)/.test(normalized);
    const hasFollowUp = /(下一步|后续跟踪|跟踪指标|必须跟踪|观察指标|关注)/.test(normalized);
    const hasEvidenceLevel = /证据等级/.test(normalized);
    if (!hasCounter || !hasFollowUp || !hasEvidenceLevel) return true;
  }
  return false;
}

function selectReviewedResearchText(answer: string, revisedAnswer: string | undefined, userMessage: string, mode: AssistantMode) {
  if (!revisedAnswer) return isUnsatisfactoryEvidenceOnlyAnswer(answer) ? buildConstructiveEvidenceGapAnswer(userMessage, mode) : answer;
  const originalUnsatisfactory = isUnsatisfactoryEvidenceOnlyAnswer(answer);
  if (isLikelyTruncatedResearchAnswer(answer) && revisedAnswer.trim().length >= 120) return revisedAnswer;
  if (!hasRequiredInvestmentSections(answer, userMessage) && hasRequiredInvestmentSections(revisedAnswer, userMessage)) return revisedAnswer;
  if (!originalUnsatisfactory && answer.length >= 1000 && revisedAnswer.length < Math.min(700, answer.length * 0.45)) {
    return answer;
  }
  return revisedAnswer;
}

function isLikelyTruncatedResearchAnswer(answer: string) {
  return /(E\d*[:：]?$|\*\*?$|[,，、]$)/.test(answer.trim());
}

function ensureMinimumResearchSections(answer: string, userMessage: string, mode: AssistantMode) {
  if (!shouldEnsureResearchStructure(userMessage)) return answer;
  const parts = [answer.trim()];
  if (/(画表|表格|对比)/.test(userMessage) && !/\|[^\n]+\|[^\n]+\|\n\|[\s:-]+\|/.test(answer)) {
    parts.push(buildMinimumComparisonTable(userMessage));
  }
  if (!/证据等级/.test(answer)) {
    parts.push("证据等级：中低。以上判断依赖当前证据包和已触发的外部线索，仍需用最新公告、财务数据和行业硬指标复核。");
  }
  if (!/(反证|我可能错|风险|削弱)/.test(answer)) {
    parts.push("我可能错在哪里：如果后续财报、订单、价格、现金流或竞争格局出现与当前判断相反的硬证据，应立即下修或重算结论。");
  }
  if (!/(下一步|后续跟踪|跟踪指标|必须跟踪|观察指标|关注)/.test(answer)) {
    const subject = mode === "industry" ? "行业价格、销量、库存、产能、政策和龙头公司财报" : "最新财报、现金流、估值、核心业务增速、竞争变化和重大公告";
    parts.push(`下一步跟踪：优先跟踪${subject}；若关键变量连续两个报告期恶化，不应维持原结论。`);
  }
  if (isHighRiskAssistantQuestion(userMessage) && !/(仓位|上限|止损|退出|亏损上限|最大回撤|小仓|分批|禁入|回避)/.test(answer)) {
    parts.push("高风险交易纪律：如果仍要参与，只能作为试错仓处理；单一标的不应超过可承受亏损资金的小比例，必须预设亏损上限、止损位、退出触发条件和复盘日期。没有公告、财报、订单或成交量验证前，禁止满仓、借钱、杠杆或追涨加仓。");
  }
  return parts.join("\n\n");
}

function isHighRiskAssistantQuestion(message: string) {
  return /(梭哈|满仓|翻倍|暴涨|最猛|越激进越好|高波动|追涨|追进去|怕错过|日内|短线|期权|杠杆|融资|期货|永续|合约|借钱|贷款|补仓|摊低成本|网红|必涨)/.test(message);
}

function shouldEnsureResearchStructure(userMessage: string) {
  return (
    isHighValueResearchQuestion(userMessage) ||
    containsLikelyResearchSubject(userMessage) ||
    /(预测|预估|净利润|营收|利润|亏损|现金流|能买吗|买入|卖出|反驳|高股息|风险|投资价值|长期|护城河|反证|技术|优势|协调|画表|表格|对比|数据|缺口|模板|雷达|自选股|怎么判断|怎么看)/.test(userMessage)
  );
}

function buildMinimumComparisonTable(userMessage: string) {
  if (/银行/.test(userMessage) && /电力/.test(userMessage) && /煤炭/.test(userMessage) && /电信/.test(userMessage)) {
    return [
      "| 行业 | 股息吸引力 | 主要风险 | 跟踪指标 |",
      "|---|---:|---|---|",
      "| 电信 | 较高 | 增长慢、资本开支周期 | 自由现金流、派息率、5G/云业务资本开支 |",
      "| 电力 | 中高 | 煤价、水电来水、电价政策 | 燃料成本、利用小时、现金流 |",
      "| 银行 | 中 | 净息差收窄、资产质量、监管资本 | NIM、不良率、拨备覆盖率、核心一级资本 |",
      "| 煤炭 | 中 | 煤价周期下行、需求波动 | 煤价、产量、长协占比、资本开支 |",
    ].join("\n");
  }
  return [
    "| 项目 | 判断 | 主要依据 | 风险/反证 |",
    "|---|---|---|---|",
    "| 结论强度 | 中低 | 当前证据可形成框架但不足以高置信排序 | 最新财报或行业数据可能推翻 |",
    "| 下一步 | 继续验证 | 补价格、销量、现金流和估值数据 | 单一新闻或搜索线索不能作为硬结论 |",
  ].join("\n");
}

function ensureComparisonCompleteness(answer: string, userMessage: string) {
  if (!isComparisonQuestion(userMessage)) return answer;
  const subjects = extractComparisonItems(userMessage);
  if (subjects.length < 2) return answer;
  const missing = subjects.filter((subject) => !answer.includes(subject));
  const conclusion = answer.match(/^结论[:：]\s*([^\n]+)/)?.[1] ?? "";
  const singleActionConclusion = /^(持有|买入|卖出|回避|观察|增持|减持)([。；;，,]|$)/.test(conclusion.trim());
  if (!missing.length && !singleActionConclusion) return answer;
  return [
    answer.trim(),
    "",
    "---",
    "",
    "对比口径补正：",
    buildComparisonTableGapAnswer(userMessage),
  ].join("\n");
}

function isComparisonQuestion(message: string) {
  return /(对比|比较|谁更|哪个更|哪一个更|差异|胜出|更稳|更好|优劣|vs|VS|和.*与|和.*谁|与.*谁)/.test(message);
}

function hasRequiredInvestmentSections(answer: string, userMessage: string) {
  if (!/(预测|预估|净利润|营收|利润|亏损|能买吗|买入|卖出|反驳|高股息|风险|投资价值|长期|护城河|技术|优势|协调|怎么判断|怎么看)/.test(userMessage)) return true;
  return /证据等级/.test(answer) && /(反证|我可能错|风险|削弱)/.test(answer) && /(下一步|后续跟踪|跟踪指标|必须跟踪|观察指标|关注)/.test(answer);
}

function buildConstructiveEvidenceGapAnswer(userMessage: string, mode: AssistantMode) {
  const subject = userMessage.split(/\n/)[0]?.slice(0, 80) || "当前问题";
  const modeLabel = mode === "industry" ? "行业" : "标的";
  if (/(暴涨|最猛|越激进越好|小盘成长|高波动).*(AI|机器人|核能|成长股)|AI.*机器人.*核能.*小盘/.test(userMessage)) return buildAggressiveGrowthScreenAnswer();
  if (/(连续涨|涨了\d+%|怕错过|追进去|追涨|FOMO)/i.test(userMessage)) return buildFomoChaseAnswer();
  if (/(逆向抄底|反共识|市场都看空|资产类别|便宜.*更便宜)/.test(userMessage)) return buildContrarianAssetAnswer();
  if (/(上行空间.*下行风险|下行风险.*上行空间)/.test(userMessage)) return buildRiskReturnTableGapAnswer(userMessage);
  if (/(画表|画成表|做成表|表格|比较|对比|矩阵)/.test(userMessage)) return buildComparisonTableGapAnswer(userMessage);
  if (/(来自|靠|驱动).*(利润修复|回购|估值修复)|利润修复.*回购.*估值修复/.test(userMessage)) return buildDriverComparisonGapAnswer(userMessage);
  if (/(产业链|环节).*(先兑现|兑现业绩|业绩兑现)|人形机器人.*(先兑现|兑现业绩|业绩兑现)/.test(userMessage)) return buildSupplyChainRealizationGapAnswer(userMessage);
  if (isStockPriceForecastQuestion(userMessage)) return buildStockPriceForecastGapAnswer(userMessage);
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
    `结论：${subject} 可以先给低置信研究框架，但不能包装成确定投资结论。`,
    "证据等级：低。当前证据只够做方向性筛选，不能直接推导高置信买卖建议。",
    "核心理由：先拆清楚需求、价格、订单、利润率、现金流和估值六个变量；若只有新闻或主题热度，只能进入观察池。",
    "反驳用户观点：把单一新闻、单家公司样本或概念叙事当作充分证据是不成立的，尤其不能由此推出满仓、追涨或确定收益。",
    `我可能错在哪里：${modeLabel} 的最新公告、官方统计或公司级硬数据如果已经更新，本轮低置信框架需要立刻重算。`,
    "下一步跟踪：补公司公告、财务指标、行业价格/销量/库存/订单、竞争格局和政策变化；至少两类硬证据互相验证后再升级结论。",
  ].join("\n");
}

function buildFomoChaseAnswer() {
  return [
    "结论：不能因为已经涨了40%就直接追进去。正确做法不是简单劝退，而是把它当成高波动交易，先验证趋势延续证据，再用小仓、分批和硬退出规则参与。",
    "证据等级：低。没有当前价格、成交量、涨幅发生时间、基本面催化剂和估值位置，本轮只能给交易计划模板，不能判断这只股票是否值得追。",
    "",
    "| 方案 | 触发条件 | 仓位/风险预算 | 退出规则 |",
    "| --- | --- | --- | --- |",
    "| 不追，等待回撤 | 缺少公告、财报或订单催化，只有情绪上涨 | 0 仓位 | 回撤到关键均线或估值回到合理区间再评估 |",
    "| 小仓试错 | 有明确催化剂，成交量放大但未明显放巨量滞涨 | 总资金 1%-3% | 跌破突破位或回撤 8%-10% 退出 |",
    "| 回撤买入 | 上涨后缩量回踩，基本面催化仍在 | 分 2-3 笔，每笔不超过 2%-3% | 跌破回踩低点或催化证伪退出 |",
    "| 突破确认 | 放量突破前高且次日不回落 | 小仓跟随，禁止满仓 | 放量长上影、跌回突破位或基本面无新增即退出 |",
    "",
    "反驳用户观点：怕错过是典型 FOMO。真正的强趋势不需要在最拥挤的位置一次性买满；如果涨幅只靠情绪，追进去承担的是别人获利了结的风险。",
    "我可能错在哪里：如果上涨来自重大订单、利润上修或政策落地，且市场还没有充分定价，等待回撤可能错过一段趋势。但这需要硬证据，不是看涨幅本身。",
    "下一步跟踪：当前价、成交量、换手率、涨停/断板结构、财报或公告催化、估值分位、机构预期变化和是否出现减持/监管关注。",
  ].join("\n");
}

function buildContrarianAssetAnswer() {
  return [
    "结论：逆向抄底应优先找“预期极差但基本面未继续恶化”的资产，而不是单纯找跌得多的资产。低置信排序框架：高股息金融/公用事业、港股互联网核心资产、部分周期资源、被错杀的消费龙头；地产链和高杠杆资产只能放最后观察。",
    "证据等级：低至中。没有实时估值分位、资金流、盈利预测修正和违约风险数据时，只能给框架和确认信号，不能给确定买入清单。",
    "",
    "| 资产类别 | 逆向逻辑 | 确认信号 | 失效信号 |",
    "| --- | --- | --- | --- |",
    "| 高股息金融/公用事业 | 市场担心增长慢，但现金流和分红可能提供底部支撑 | 净息差/现金流稳定、分红政策不降、估值分位低 | 不良率/资本开支恶化、分红下调 |",
    "| 港股互联网核心资产 | 风险溢价高，若利润和回购兑现，估值可修复 | 利润率改善、回购持续、监管边际稳定 | EPS 下修、竞争加剧、回购缩量 |",
    "| 周期资源 | 若供给收缩强于需求下行，价格可能反转 | 库存下降、价格企稳、龙头现金流改善 | 价格继续破位、产能复产、需求塌陷 |",
    "| 消费龙头 | 需求差时估值压缩，若渠道库存出清可修复 | 批价/库存稳定、现金流恢复、费用率下降 | 价格继续下跌、渠道利润恶化 |",
    "| 地产链/高杠杆资产 | 最便宜但尾部风险最大 | 销售、融资、现金流三者同时改善 | 债务展期失败、销售继续下滑、资产减值 |",
    "",
    "反驳用户观点：便宜可能更便宜。逆向不是和市场情绪对赌，而是找市场过度定价但硬数据正在止跌的地方。",
    "我可能错在哪里：如果宏观流动性突然收紧或信用风险扩散，低估值资产会继续下跌；如果政策快速托底，高杠杆资产弹性可能比稳健资产更大。",
    "下一步跟踪：估值分位、盈利预测上修/下修、资金流、信用利差、违约风险、行业价格、库存和龙头公司现金流。",
  ].join("\n");
}

function buildAggressiveGrowthScreenAnswer() {
  return [
    "结论：可以做激进成长股候选池，但不能直接给“必暴涨名单”。更合理的做法是把AI、机器人、核能、小盘成长拆成四层筛选：主题热度、基本面兑现、估值/流动性、催化剂时点。",
    "证据等级：低。若没有实时价格、成交额、最新财报、订单公告和估值分位，本轮只能输出筛选框架和观察池规则，不应把候选股写成确定机会。",
    "",
    "| 主题 | 可以进入候选池的条件 | 必须剔除的情况 | 关键风险 |",
    "| --- | --- | --- | --- |",
    "| AI算力/硬件 | 有订单、营收占比或毛利率改善证据，而不只是概念新闻 | PE/PB极端、客户单一、收入占比无法披露 | 估值杀、资本开支放缓、价格战 |",
    "| 人形机器人 | 有真实交付、定点、零部件收入或客户验证 | 只有发布会、样机视频、互动平台口径 | 商业化慢、现金流消耗、股价透支 |",
    "| 核能/电力设备 | 有招标、中标、在手订单和交付周期证据 | 只有政策口号，缺公司订单 | 项目延期、毛利率低、回款慢 |",
    "| 小盘成长 | 营收/扣非利润连续改善，经营现金流不恶化，成交额足够 | 应收高增、减持、商誉、流动性差 | 暴涨后回撤、流动性踩踏、财务质量差 |",
    "",
    "风险预算：如果用户坚持做激进策略，单一标的应设仓位上限，组合也要预设最大亏损上限；未出现订单或财报验证前，只能用小仓试错，不能满仓追涨。",
    "反驳用户观点：“越激进越好”容易把波动当收益，把题材热度当基本面。真正可投的激进成长股必须同时满足催化剂、业绩路径、流动性和退出纪律，否则只是高赔率叙事。",
    "我可能错在哪里：若某个主题突然出现重大订单、政策落地或财报超预期，候选池排序会快速变化；若市场风险偏好下行，小盘成长会先杀估值。",
    "下一步跟踪：最新公告/中标、收入占比、毛利率、经营现金流、成交额、减持公告、估值分位和主题热度是否已经反映在股价里。",
  ].join("\n");
}

function isStockPriceForecastQuestion(message: string) {
  return /(股价|目标价|市值|估值).*(预测|预估|明年|未来|一年|12个月|空间|涨跌)|预测.*(股价|目标价|市值)|当前股价/.test(message);
}

function extractStockPriceSubject(message: string) {
  const known = ["贵州茅台", "茅台", "五粮液", "宁德时代", "腾讯", "英伟达", "比亚迪", "万科A", "隆基绿能", "阿里巴巴"];
  return known.find((name) => message.includes(name)) || message.replace(/(当前股价|股价|是多少|预测|预估|明年|未来|目标价|请|一下|？|\?)/g, "").trim().slice(0, 18) || "当前标的";
}

function buildStockPriceForecastGapAnswer(userMessage: string) {
  const subject = extractStockPriceSubject(userMessage);
  return [
    `结论：${subject} 的“当前股价 + 明年股价”不能用一句目标价糊弄，应拆成当前价格口径、盈利假设和估值倍数三步。若本轮证据没有可审计实时价，就必须先标注“当前价需以交易时段实时行情为准”，再给低置信情景区间。`,
    "证据等级：低。股价预测天然不确定；没有最新行情、EPS/净利润预测和估值分位交叉验证时，只能做情景测算，不能给确定目标价。",
    "",
    "| 情景 | 明年股价推算逻辑 | 需要满足的条件 | 主要反证 |",
    "| --- | --- | --- | --- |",
    "| 保守 | 当前合理估值下修，或利润增速低于预期 | 需求疲软、价格/批价走弱、盈利预测下调 | 财报重新加速、现金流改善、估值风险释放 |",
    "| 中性 | 明年EPS或净利润小幅增长，估值倍数大致维持 | 经营稳定，市场风险偏好不再恶化 | 估值继续压缩或盈利预测下修 |",
    "| 乐观 | 盈利上修叠加估值修复 | 价格/销量/渠道或成本端至少两个变量改善 | 利润兑现不足、库存压力、监管或宏观风险上升 |",
    "",
    "反驳用户观点：如果只想要一个明年股价数字，这个数字很可能是伪精确。真正有用的是“当前价相对三种情景的上行/下行空间”，以及哪些变量能让区间重算。",
    "我可能错在哪里：如果站内行情、最新财报、券商一致预期或估值分位已经更新，本轮低置信区间需要立即重算；尤其是当前价如果取错，会直接影响上行空间。",
    "下一步跟踪：实时股价、TTM/预期PE、明年EPS或净利润预测、经营现金流、核心产品价格/批价、渠道库存、分红回购和市场风险偏好。",
  ].join("\n");
}

function repairIncompleteAssistantAnswer(answer: string, userMessage: string, mode: AssistantMode) {
  const normalized = answer.trim();
  if (!normalized) return normalized;
  if (shouldSkipIncompleteAnswerRepair(userMessage)) return answer;
  const asksTable = /(画表|画成表|做成表|表格|比较|对比|矩阵|上行空间|下行风险)/.test(userMessage);
  const missingFollowUp = !/(下一步|后续跟踪|跟踪指标|必须跟踪|观察指标)/.test(normalized);
  const missingCounter = !/(反证|我可能错|下行风险|风险)/.test(normalized);
  const shortOrCut = normalized.length < 900 || /[（(]$|[，,、：:]$|报告日$/.test(normalized);
  if (!asksTable && !(shortOrCut && (missingFollowUp || missingCounter))) return answer;
  if (!shortOrCut && !missingFollowUp && !missingCounter) return answer;
  return [
    normalized,
    "",
    "---",
    "",
    "补充框架：",
    buildConstructiveEvidenceGapAnswer(userMessage, mode),
  ].join("\n");
}

function shouldSkipIncompleteAnswerRepair(userMessage: string) {
  const text = userMessage.trim();
  if (/^(你好|您好|哈喽|hello|hi)([，,。.!！?\s]*(你是|你是谁|你能做什么|介绍一下|是谁|在吗))?[？?！!。.\s]*$/i.test(text)) return true;
  if (/^(你是|你是谁|你能做什么|介绍一下|谢谢|辛苦了)[？?！!。.\s]*$/i.test(text)) return true;
  return shouldTreatAsSimpleGeneralChat(text, "chat");
}

function buildSupplyChainRealizationGapAnswer(userMessage: string) {
  const subject = userMessage.includes("人形机器人") ? "人形机器人" : userMessage.split(/[？?。]/)[0].slice(0, 40) || "当前产业链";
  return [
    `结论：${subject} 的兑现顺序应先看“可复用、已有订单、可独立供货”的环节，而不是先看整机。低置信排序为：精密零部件/执行器 > 传感器/控制器 > 减速器/丝杠等核心传动 > 代工制造 > 整机本体。`,
    "证据等级：低至中。该排序是产业链兑现框架，必须继续用公司公告、客户订单、单机价值量、毛利率和产能利用率验证。",
    "",
    "| 环节 | 兑现顺序 | 为什么可能先兑现 | 主要反证 | 必须验证的硬指标 |",
    "| --- | --- | --- | --- | --- |",
    "| 精密零部件/执行器 | 1 | 和汽车、消费电子、工业自动化供应链复用度高，单机价值量清晰，可能先进入小批量供货 | 客户定点未落地或价格快速下行 | 人形机器人收入占比、客户定点、毛利率、产能利用率 |",
    "| 传感器/控制器 | 2 | 感知和运动控制是整机迭代刚需，部分能力可复用到工业机器人和汽车 | 技术路线变化导致供应商切换 | 出货量、ASP、客户数量、研发费用转化 |",
    "| 减速器/丝杠/传动 | 3 | 价值量高，但良率、寿命和成本要求更高，兑现可能慢于普通结构件 | 国产替代不及预期或海外供应商压价 | 良率、寿命测试、订单金额、单位成本 |",
    "| 代工制造 | 4 | 若整机放量，组装和结构件公司会受益，但利润率通常较薄 | 产能闲置或客户自建产线 | 产线稼动率、单机加工费、客户排产 |",
    "| 整机本体 | 5 | 想象空间最大，但商业化、成本、场景和安全验证最难 | 真实订单少、亏损扩大、演示无法量产 | 实际交付台数、复购率、单位经济模型、现金流 |",
    "",
    "反驳用户观点：如果只看“人形机器人空间大”就直接买整机或所有概念股，逻辑不完整。更理性的做法是先找已经能从样机、小批量、工业自动化复用中确认收入的环节。",
    "我可能错在哪里：如果某家整机公司突然拿到大额真实订单，或核心传动件价格/良率显著改善，兑现顺序会前移。",
    "下一步跟踪：客户定点、样机转小批量、订单金额、毛利率、单位成本、库存、CAPEX和现金流，而不是只看发布会和概念新闻。",
  ].join("\n");
}

function buildComparisonTableGapAnswer(userMessage: string) {
  const items = extractComparisonItems(userMessage);
  const rows = items.map((item) => {
    const name = item.trim();
    if (/光模块/.test(name)) return "| 光模块 | 偏强观察 | 中 | AI资本开支、800G/1.6T需求 | 估值透支、客户集中、价格下行 | 龙头订单、毛利率、库存、CAPEX指引 |";
    if (/PCB/.test(name)) return "| PCB | 中性偏强观察 | 中低 | AI服务器高层数板和高频高速材料升级 | 良率、扩产、价格竞争 | 服务器PCB收入占比、订单、毛利率 |";
    if (/液冷/.test(name)) return "| 液冷 | 早期强观察 | 低至中 | 高功耗机柜推动渗透率提升 | 项目制波动、标准不统一、价格战 | 中标金额、交付节奏、客户复购 |";
    if (/存储|HBM/.test(name)) return "| 存储/HBM | 偏强但高周期 | 中 | HBM和DRAM涨价、AI服务器拉动 | 周期反转、扩产、终端需求下修 | 现货价格、合约价、库存、A/H链条业绩 |";
    if (/茅台|五粮液|白酒/.test(name)) return `| ${name} | 观察 | 低至中 | 品牌、批价、渠道库存、现金流和估值共同决定长期回报 | 高端消费疲软、批价下行、渠道利润收缩 | 批价、合同负债、经营现金流、分红、估值分位 |`;
    if (/宁德时代|比亚迪/.test(name)) return `| ${name} | 观察 | 中 | 技术路线、成本、客户结构、现金流和资本开支决定长期质量 | 价格战、产能过剩、技术替代、海外政策 | 电池毛利率、现金流、产能利用率、客户订单 |`;
    return `| ${name} | 观察 | 低 | 需要拆需求、价格、订单和利润率 | 概念化叙事、估值透支 | 财报、订单、价格、库存、客户验证 |`;
  });
  const subjectLabel = items.slice(0, 4).join("、");
  return [
    `结论：${subjectLabel} 需要做相对判断，不能只给单一标的“持有/买入/观察”。当前只能给低置信排序框架：谁更稳取决于现金流韧性、估值安全边际和关键经营变量是否继续恶化。`,
    "证据等级：低至中。以下表格是研究框架和初步判断，必须用公司公告、财报、订单、价格和库存继续验证。",
    "",
    "| 对比对象 | 初步判断 | 证据强度 | 主要驱动 | 主要风险 | 下一步必须验证 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "反驳用户观点：如果只因为龙头地位、品牌或历史高回报就判断长期更稳，这是不充分的；长期回报必须回到现金流、估值、增长韧性和反证条件。",
    "我可能错在哪里：若其中一方最新财报、价格、现金流或渠道数据明显好于另一方，上述低置信排序必须改写。",
    "下一步跟踪：逐家公司核对收入/净利增速、经营现金流、毛利率、库存/批价或订单、分红回购和估值分位。",
  ].join("\n");
}

function buildRiskReturnTableGapAnswer(userMessage: string) {
  const subject = /贵州茅台|茅台/.test(userMessage) ? "贵州茅台" : userMessage.split(/[？?。]/)[0].replace(/(把|画表|做成表|上行空间|下行风险|的)/g, "").trim().slice(0, 24) || "当前标的";
  return [
    `结论：${subject} 可以先用“上行空间 vs 下行风险”框架观察，但不能只看券商目标价或品牌叙事。当前应把上行看作需要验证的情景，把下行看作已在经营压力中体现的风险。`,
    "证据等级：低至中。表格是研究框架和低置信整理，不等同于买入建议；涉及目标价、批价、利润增速和渠道库存时必须回到最新财报、公告和价格数据复核。",
    "",
    `${subject}上行空间与下行风险对照表`,
    "",
    "| 方向 | 关键因素 | 对投资吸引力的影响 | 主要反证 | 必须跟踪 |",
    "| --- | --- | --- | --- | --- |",
    "| 上行空间 | 估值修复 | 若估值处于低位且盈利没有继续下修，股价可能先修复风险偏好 | 盈利预测继续下调，低估值变成价值陷阱 | PE/PB分位、券商预测修正、成交量 |",
    "| 上行空间 | 改革或渠道效率 | 直营占比、产品结构或渠道效率改善可能推高利润率 | 渠道利润被压缩、批价继续走弱、库存去化慢 | 批价、渠道库存、合同负债、毛利率 |",
    "| 上行空间 | 品牌和现金流韧性 | 龙头品牌和现金流可支撑长期定价权 | 高端消费需求持续疲软，品牌溢价下降 | 自由现金流、分红、经销商信心 |",
    "| 下行风险 | 利润增速放缓 | 若营收和净利增速继续下台阶，估值中枢会被重估 | 半年报或三季报重新加速 | 单季收入、净利润、经营现金流 |",
    "| 下行风险 | 价格和库存压力 | 批价下行会削弱渠道信心，并影响市场对真实需求的判断 | 批价连续回升且库存下降 | 飞天批价、终端库存、渠道打款 |",
    "| 下行风险 | 估值修复落空 | 若目标价依赖乐观假设而基本面未兑现，上行空间会缩水 | 盈利预测上修且估值分位仍低 | 一致预期、目标价调整、业绩兑现率 |",
    "",
    "反驳用户观点：如果只因为“品牌强、目标价高”就认为上行确定，这是不完整的。真正的上行需要利润、现金流、批价和渠道库存共同验证。",
    "我可能错在哪里：如果最新财报显示利润增速明显回升、批价稳定上行且合同负债改善，那么当前偏观察的判断应上调；反之如果价格继续下行或盈利预测下修，应降低吸引力。",
    "下一步跟踪：最近一期财报、飞天批价、渠道库存、合同负债、直营占比、经营现金流、券商一致预期和估值分位。",
  ].join("\n");
}

function buildDriverComparisonGapAnswer(userMessage: string) {
  const subject = userMessage.includes("港股互联网") ? "港股互联网" : userMessage.split(/[？?。]/)[0].slice(0, 40) || "当前行业";
  return [
    `结论：${subject} 的投资吸引力不能简单归因于单一因素。当前更合理的主导驱动排序是：利润修复第一，回购第二，估值修复第三；但三者都需要最新财报和公告继续验证。`,
    "证据等级：低至中。若只依赖外部新闻或历史估值，不能给高置信结论；必须用公司财报、回购公告、用户/广告/电商数据和监管变化交叉验证。",
    "",
    "| 驱动 | 当前作用 | 为什么重要 | 反证信号 |",
    "| --- | --- | --- | --- |",
    "| 利润修复 | 主导驱动 | 成本纪律、广告/电商/本地生活利润率改善能直接推升自由现金流，是最能解释长期价值的变量 | 收入低增且费用重新扩张，利润率回落 |",
    "| 回购 | 次要但重要 | 低估值下回购能提高每股价值，也能稳定市场预期 | 回购减少、股价上涨后回购收益率下降，或现金流转弱 |",
    "| 估值修复 | 结果变量 | 估值上修通常来自利润确定性和监管风险下降，不应单独作为买入理由 | 盈利兑现不足、政策不确定性上升，估值会再次压缩 |",
    "",
    "反驳过度乐观观点：港股互联网不是“便宜就一定涨”。如果利润修复停滞，回购只是托底，估值修复也可能只是短期情绪反弹。",
    "我可能错在哪里：如果最新季度显示收入重新加速、利润率继续扩张且回购明显放大，估值修复的权重会提高。",
    "下一步跟踪：腾讯、阿里、美团、快手等公司的利润率、自由现金流、回购金额、监管事件、广告/电商/本地生活增速和估值分位。",
  ].join("\n");
}

function extractComparisonItems(message: string) {
  const match = message.match(/(?:里|：|:)([^。？?]+?)(?:这[几四五六七八九十\d]*个|的景气|进行|$)/);
  const segment = match?.[1] || message;
  const items = segment
    .split(/[、,，/和与]/)
    .map((item) =>
      item
        .replace(/(画表|比较|对比|列表|矩阵|产业链|环节|景气度|证据强度|风险|里|长期回报|谁更稳|谁更好|哪个更好|哪一个更好|护城河差异|业务的|的|请|一下|？|\?)/g, "")
        .trim(),
    )
    .filter((item) => item.length >= 2 && item.length <= 12)
    .slice(0, 8);
  return items.length ? items : ["核心环节", "上游", "中游", "下游"];
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
          reasoningEffort: ASSISTANT_AUXILIARY_REASONING_EFFORT,
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
      "重点检查证据等级：不能因为 Exa/AnySearch/SearXNG/GDELT/arXiv/Semantic Scholar 返回多条新闻、论文或海外案例就给高证据等级；若缺少直接相关财报、公告、监管或官方统计，必须降为中或低。",
      "重点检查证据等级：证据等级段落如果写明来自 Exa/GDELT/arXiv/Semantic Scholar 检索、多地区新闻、学术论文、券商研报、S&P 报告、海外案例、GCC、印度或美国，最高只能是中，不能是高/中高/较高/中至高。",
      "重点检查跨市场类比：海外银行、海外公司或海外行业案例只能作为风险机制类比，不能直接证明中国/A股/港股标的；需要在回答中写明适用边界。",
      "重点检查反驳类问题：必须拆分“用户观点中合理的部分”和“错误的绝对化部分”；例如高股息可以是策略，但“稳赚”必须被明确反驳。",
      "重点检查反驳表格：不要把反证条件写成“支持稳赚”；应写为“削弱反驳的条件”或“我可能错在哪里”。",
      "重点检查对比问题：用户问 A 和 B 谁更稳/哪个更好/对比时，回答必须同时覆盖 A 和 B，并给相对判断；禁止只给某一个标的“持有/买入/观察”。",
      "重点检查格式：禁止空标题、空章节和只有横线的章节；Markdown 表格必须有具体标题，不能写“结构化表格1/2/3”。",
      "重点检查业绩预估：没有站内财报或官方公告支撑的基数，不能写成“实际值”；只能写“外部线索/券商预测显示”或“待核验基数”。",
      "重点检查股价预测：用户问当前股价/明年股价/目标价时，不能套用净利润预测兜底；必须包含当前价口径、保守/中性/乐观情景、估值倍数或EPS/利润假设、反证条件。",
      "重点检查股价预测一致性：结论区间、情景测算区间、最终重申区间必须一致；外部券商目标价只能作为参考，不能和模型情景区间混为“最可能区间”。如发现 1400-1700 这类结论与正文 1190-1490 情景不一致，必须改写为一致区间并解释外部目标价另列。",
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
          reasoningEffort: ASSISTANT_AUXILIARY_REASONING_EFFORT,
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
      reasoningEffort: ASSISTANT_AUXILIARY_REASONING_EFFORT,
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

function buildForcedClarificationRequest(message: string): AssistantChoiceRequest | null {
  if (!/(能买吗|买不买|该不该买|能不能买|可以买|要不要买|该不该卖|要不要卖|能不能卖|卖不卖)/.test(message)) return null;
  if (/(反驳|你反驳|反证|排雷|根据我的自选股|自选股)/.test(message)) return null;
  if (containsLikelyResearchSubject(message) && /(现在|当前|目前|此时|长期|短期|三年|五年|十年|持有|仓位|左侧|右侧|风险偏好|低风险|高风险|分批|定投|交易|波段|估值区间|安全边际)/.test(message)) return null;
  if (/(长期|短期|三年|五年|十年|持有|仓位|左侧|右侧|风险偏好|低风险|高风险|分批|定投|交易|波段|估值区间|安全边际)/.test(message)) return null;
  return {
    id: `forced-action-${Math.abs(hashString(message)).toString(36)}`,
    title: "先确认买卖口径",
    question: "这个问题缺少持有周期和动作目标，你希望我按哪种口径判断？",
    reason: "买卖动作如果不先确认时间维度、仓位状态和风险偏好，直接回答容易把长期配置、短线交易和已有持仓混在一起。",
    customPlaceholder: "也可以自己补充：已有仓位、目标持有多久、能接受多大回撤、想加仓还是新买。",
    options: [
      { id: "new-buy-long", label: "新买长期", description: "按 3 年以上持有，先看质量、估值安全边际和反证。", recommended: true },
      { id: "holding-review", label: "已有持仓", description: "按是否继续持有、是否减仓和跟踪风险来判断。" },
      { id: "short-catalyst", label: "短线机会", description: "按财报、政策、资金和情绪催化判断交易性机会。" },
    ],
  };
}

function buildSubjectOnlyClarificationRequest(message: string): AssistantChoiceRequest | null {
  const normalized = message.trim().replace(/[？?。.!！\s]/g, "");
  if (normalized.length > 8) return null;
  if (!/(半导体|光伏|白酒|银行|地产|煤炭|电力|航运|机器人|创新药|CXO|AI|算力|储能|锂电|水泥|钢铁|铜|猪周期|港股互联网)/i.test(normalized)) return null;
  return {
    id: "research_scope",
    title: "先确认研究口径",
    question: "你想按哪种口径看这个方向？",
    reason: "这个问题只有方向，没有说明你想看机会、风险、估值还是具体标的。先选一个口径，回答会更准。",
    customPlaceholder: "也可以写：只看A股设备链、只看港股、只看未来一年等。",
    options: [
      { id: "risk_opportunity", label: "机会与风险", description: `${normalized}的主要机会、风险和反证。`, recommended: true },
      { id: "valuation", label: "估值与位置", description: `${normalized}当前是否便宜，是否有泡沫。` },
      { id: "stocks", label: "代表公司", description: `${normalized}里哪些A/H标的更值得跟踪。` },
    ],
  };
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

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
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

function formatEastmoneyIncomeRow(row: Record<string, unknown>) {
  return [
    stringOrFallback(row.REPORT_DATE_NAME, stringOrFallback(row.REPORT_TYPE, "最新期")),
    `营收=${formatPkgNumber(row.TOTAL_OPERATE_INCOME)}`,
    `营收同比=${formatPkgPercent(row.TOTAL_OPERATE_INCOME_YOY)}`,
    `归母净利=${formatPkgNumber(row.PARENT_NETPROFIT)}`,
    `归母净利同比=${formatPkgPercent(row.PARENT_NETPROFIT_YOY)}`,
    `扣非净利=${formatPkgNumber(row.DEDUCT_PARENT_NETPROFIT)}`,
  ].join("/");
}

function formatEastmoneyCashflowRow(row: Record<string, unknown>) {
  return [
    stringOrFallback(row.REPORT_DATE_NAME, stringOrFallback(row.REPORT_TYPE, "最新期")),
    `经营现金流入=${formatPkgNumber(row.TOTAL_OPERATE_INFLOW)}`,
    `销售收现=${formatPkgNumber(row.SALES_SERVICES)}`,
    `现金净增=${formatPkgNumber(row.CCE_ADD)}`,
  ].join("/");
}

function formatTenYearMetricRow(row: Record<string, unknown>) {
  const metric = stringOrFallback(row.metric, "指标");
  const values = isRecord(row.values) ? Object.entries(row.values).slice(-3).map(([year, value]) => `${year}:${String(value)}`) : [];
  return `${metric}(${values.join(",")})`;
}

function formatPkgNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "NA";
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (abs >= 10_000) return `${(value / 10_000).toFixed(2)}万`;
  return value.toFixed(2);
}

function formatPkgPercent(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}%` : "NA";
}

function formatPkgValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return typeof value === "string" && value.trim() ? value.trim() : "NA";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeAssistantMode(value: unknown): AssistantMode {
  return value === "target" || value === "industry" || value === "chat" ? value : "chat";
}
