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
import { fetchAnySearchEvidence, fetchSearxngEvidence, type AnySearchEvidence } from "../../_shared/anysearch";
import { buildDeepSeekRequestBody, cacheStableUserContent, withCacheProtocol, type DeepSeekMessage } from "../../_shared/deepseek-cache";
import type { AssistantChatRequest, AssistantChatStreamEvent, AssistantChoiceOption, AssistantChoiceRequest, AssistantUsage } from "../../../src/shared/assistant";

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
  const recentMessages = (await readRecentMessages(env.REPORT_LIBRARY_DB, session.userId, thread.id, 24))
    .filter((message) => message.id !== userStoredMessage.id)
    .map((message): { role: "user" | "assistant"; content: string; createdAt: string } => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
      createdAt: message.createdAt,
    }));
  const clarificationDecision = await askModelForClarification({
    env,
    userMessage,
    memories: memories.map((memory) => ({ category: memory.category, content: memory.content })),
    threadSummary: thread.summary,
    recentMessages: recentMessages.slice(-8),
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

  const [siteEvidenceSummary, externalEvidence] = await Promise.all([
    buildSiteEvidenceSummary(env.REPORT_LIBRARY_DB, session.userId),
    maybeFetchExternalEvidence(env, userMessage, request.signal),
  ]);
  const toolRun = await writeToolRun(env.REPORT_LIBRARY_DB, {
    userKey: session.userId,
    threadId: thread.id,
    toolName: "站内证据/外部搜索",
    status: externalEvidence.triggered ? "completed" : "skipped",
    summary: externalEvidence.triggered ? `外部搜索返回 ${externalEvidence.items.length} 条，已并入助手上下文。` : "未触发外部搜索，仅使用站内证据和记忆。",
    input: externalEvidence.query ? { query: externalEvidence.query } : undefined,
    output: externalEvidence.items.slice(0, 5),
    now,
  });
  const evidenceSummary = [siteEvidenceSummary, formatExternalEvidence(externalEvidence.items)].filter(Boolean).join("\n");
  const promptMessages = buildAssistantPromptMessages({
    memories,
    threadSummary: thread.summary,
    evidenceSummary,
    recentMessages,
    userMessage,
  });

  const assistantMessageId = crypto.randomUUID();
  const startedAt = Date.now();
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
        if (!assistantText.trim()) throw new Error("DeepSeek 未返回助手内容。");
        latestUsage ??= { model: ASSISTANT_MODEL, reasoningEffort: ASSISTANT_REASONING_EFFORT, elapsedMs: Date.now() - startedAt };
        const message = await writeAssistantMessage(env.REPORT_LIBRARY_DB!, {
          id: assistantMessageId,
          userKey: session.userId,
          threadId: thread.id,
          role: "assistant",
          content: assistantText,
          metadata: { usage: latestUsage, toolRuns: [toolRun] },
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

async function maybeFetchExternalEvidence(env: AssistantEnv, message: string, signal: AbortSignal): Promise<{ triggered: boolean; query?: string; items: AnySearchEvidence[] }> {
  if (!/(最新|联网|查一下|搜索|新闻|今天|刚刚|实时)/.test(message)) return { triggered: false, items: [] };
  const query = `${message.slice(0, 120)} 投资 财报 公告 风险`;
  const queries = [{ query, topic: "assistant", sourceType: "news" as const, maxResults: 4, domains: ["finance" as const, "business" as const], contentTypes: ["news" as const, "web" as const], freshness: "month" as const }];
  const [anysearch, searxng] = await Promise.all([
    fetchAnySearchEvidence({ queries, apiKey: env.ANYSEARCH_API_KEY, signal }),
    fetchSearxngEvidence({ queries, endpoints: env.SEARXNG_ENDPOINTS, signal }),
  ]);
  return { triggered: true, query, items: [...anysearch, ...searxng].slice(0, 8) };
}

function formatExternalEvidence(items: AnySearchEvidence[]) {
  if (!items.length) return "";
  return `外部搜索证据：${items.map((item, index) => `E${index + 1} ${item.title}（${item.source}/${item.publishedAt || "unknown"}）：${item.summary}`).join("；")}`;
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
