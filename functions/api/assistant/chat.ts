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
import type { AssistantChatRequest, AssistantChatStreamEvent, AssistantChoiceOption, AssistantChoiceRequest, AssistantMode, AssistantUsage } from "../../../src/shared/assistant";

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

  const [siteEvidenceSummary, modeEvidenceSummary, externalEvidence] = await Promise.all([
    buildSiteEvidenceSummary(env.REPORT_LIBRARY_DB, session.userId),
    buildModeEvidenceSummary(env.REPORT_LIBRARY_DB, session.userId, userMessage, mode),
    maybeFetchExternalEvidence(env, userMessage, mode, request.signal),
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
  const evidenceSummary = [siteEvidenceSummary, modeEvidenceSummary, formatExternalEvidence(externalEvidence.items)].filter(Boolean).join("\n");
  const promptMessages = buildAssistantPromptMessages({
    memories,
    threadSummary: thread.summary,
    evidenceSummary,
    recentMessages,
    userMessage,
    mode,
  });

  const assistantMessageId = crypto.randomUUID();
  const startedAt = Date.now();
  if (mode !== "chat") {
    const reviewed = await generateReviewedResearchAnswer({
      env,
      messages: promptMessages,
      userMessage,
      mode,
      signal: request.signal,
    });
    if (!reviewed.text.trim()) return json({ error: "DeepSeek 助手连接失败。" }, 502);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        enqueue(controller, { type: "start", threadId: thread.id, messageId: assistantMessageId });
        if (storedCandidate) enqueue(controller, { type: "memory_candidate", candidate: storedCandidate });
        enqueue(controller, { type: "delta", text: reviewed.text });
        const message = await writeAssistantMessage(env.REPORT_LIBRARY_DB!, {
          id: assistantMessageId,
          userKey: session.userId,
          threadId: thread.id,
          role: "assistant",
          content: reviewed.text,
          metadata: { usage: reviewed.usage, toolRuns: [toolRun], rationalReview: reviewed.review },
        });
        await writeUsageEvent(env.REPORT_LIBRARY_DB!, { userKey: session.userId, threadId: thread.id, messageId: assistantMessageId, usage: reviewed.usage });
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

async function maybeFetchExternalEvidence(env: AssistantEnv, message: string, mode: AssistantMode, signal: AbortSignal): Promise<{ triggered: boolean; query?: string; items: AnySearchEvidence[] }> {
  const researchMode = mode !== "chat";
  if (!researchMode && !/(最新|联网|查一下|搜索|新闻|今天|刚刚|实时)/.test(message)) return { triggered: false, items: [] };
  const suffix = mode === "target" ? "财报 公告 估值 现金流 竞争 风险" : mode === "industry" ? "行业 景气 价格 产能 库存 政策 风险" : "投资 财报 公告 风险";
  const query = `${message.slice(0, 120)} ${suffix}`;
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

async function buildModeEvidenceSummary(db: D1Database, userKey: string, message: string, mode: AssistantMode) {
  if (mode === "chat") return "";
  if (mode === "target") return buildTargetEvidenceSummary(db, userKey, message);
  return buildIndustryEvidenceSummary(db, message);
}

async function buildTargetEvidenceSummary(db: D1Database, userKey: string, message: string) {
  const watchlist = await db
    .prepare(`SELECT id, company_name, ticker, market FROM user_watchlist WHERE user_key = ?1 ORDER BY added_at DESC LIMIT 80`)
    .bind(userKey)
    .all<{ id: string; company_name: string; ticker: string; market: string }>()
    .catch(() => ({ results: [] }));
  const matched = (watchlist.results ?? []).filter((item) => message.includes(item.company_name) || message.toUpperCase().includes(item.ticker.toUpperCase())).slice(0, 3);
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
  const text = review.revisedAnswer || answer;
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
      "不要编造新事实；证据不足时降级为观察或回避。",
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
