import { extractAssistantBlocks } from "../../functions/_shared/assistant-blocks";
import {
  ASSISTANT_REASONING_EFFORT,
  buildSiteEvidenceSummary,
  parseDeepSeekUsage,
  updateThreadSummaryIfLarge,
  writeAssistantMessage,
  writeToolRun,
  writeUsageEvent,
  type AssistantEnv,
} from "../../functions/_shared/assistant-db";
import {
  buildAssistantDeepResearchToolCalls,
  hasRequiredDeepResearchAnswerSections,
  isAssistantDeepResearchStopRequested,
  readAssistantDeepResearchJobForWorker,
  writeAssistantDeepResearchProgress,
  writeAssistantDeepResearchStep,
  type AssistantDeepResearchQueueMessage,
  type AssistantDeepResearchWorkerJob,
} from "../../functions/_shared/assistant-deep-research";
import { formatCollectedEvidenceForAgent, type AssistantSearchToolCall } from "../../functions/_shared/assistant-tools";
import { buildDeepSeekRequestBody, cacheStableUserContent, withCacheProtocol, type DeepSeekMessage } from "../../functions/_shared/deepseek-cache";
import { buildDeepSeekFallbackRoutes } from "../../functions/_shared/opencode-go";
import { buildMandatoryAgentToolCalls, executeAssistantToolCalls } from "../../functions/api/assistant/chat";
import type { AssistantUsage } from "../../src/shared/assistant";

const DEEP_RESEARCH_TOOL_TIMEOUT_MS = 8 * 60 * 1_000;
const DEEP_RESEARCH_MODEL_ROUTE_TIMEOUT_MS = 6 * 60 * 1_000;

type WorkerEnv = AssistantEnv & {
  REPORT_LIBRARY_DB: D1Database;
  REPORT_CACHE?: KVNamespace;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

export default {
  async queue(batch: MessageBatch<AssistantDeepResearchQueueMessage>, env: WorkerEnv) {
    for (const message of batch.messages) {
      try {
        await processAssistantDeepResearchJob(env, message.body.jobId);
        message.ack();
      } catch (error) {
        console.error("assistant_deep_research_failed", { jobId: message.body.jobId, attempts: message.attempts, error: safeError(error) });
        await writeAssistantDeepResearchProgress(env.REPORT_LIBRARY_DB, env.REPORT_CACHE, {
          id: message.body.jobId,
          status: "failed",
          title: "深度研究暂时失败，请稍后重试。",
          stage: "failed",
          current: 4,
          errorMessage: safeError(error),
        }).catch(() => undefined);
        if (message.attempts < 2) message.retry({ delaySeconds: 30 });
        else message.ack();
      }
    }
  },
} satisfies ExportedHandler<WorkerEnv, AssistantDeepResearchQueueMessage>;

export async function processAssistantDeepResearchJob(env: WorkerEnv, jobId: string) {
  const job = await readAssistantDeepResearchJobForWorker(env.REPORT_LIBRARY_DB, jobId);
  if (!job || job.status === "completed" || job.status === "failed") return;
  const startedAt = Date.now();
  await progress(env, job, "running", "正在整理研究问题...", "plan", 1);
  const context = {
    siteEvidenceSummary: await buildSiteEvidenceSummary(env.REPORT_LIBRARY_DB, job.userKey),
    modeEvidenceSummary: "",
  };
  const calls = buildDeepResearchExecutionToolCalls(job, context);
  await writeAssistantDeepResearchStep(env.REPORT_LIBRARY_DB, { jobId, round: 1, stage: "plan", title: "已生成最低证据包", status: "completed", summary: calls.map((call) => call.name).join("、") });

  const stoppedBeforeTools = await isAssistantDeepResearchStopRequested(env.REPORT_LIBRARY_DB, jobId);
  await progress(env, job, stoppedBeforeTools ? "stopping" : "running", stoppedBeforeTools ? "正在整理阶段性总结..." : "正在查行情、财报、公告和外部来源...", "collect", 2);
  const evidenceResult = stoppedBeforeTools
    ? { items: [], exa: { used: false, count: 0 }, summary: "用户在检索前停止任务。" }
    : await runWithAbortTimeout(
      DEEP_RESEARCH_TOOL_TIMEOUT_MS,
      "深度研究证据检索超时。",
      (signal) => executeAssistantToolCalls(env, calls, signal, context),
    );
  await writeAssistantDeepResearchStep(env.REPORT_LIBRARY_DB, {
    jobId,
    round: 2,
    stage: "collect",
    title: "最低证据包检索完成",
    status: "completed",
    summary: evidenceResult.summary,
    evidenceCount: evidenceResult.items.length,
  });

  const stopped = stoppedBeforeTools || await isAssistantDeepResearchStopRequested(env.REPORT_LIBRARY_DB, jobId);
  const evidenceObjectKey = `assistant/deep-research/v1/${encodeURIComponent(job.userKey)}/${job.id}.json`;
  if (env.REPORT_LIBRARY_BUCKET) {
    await env.REPORT_LIBRARY_BUCKET.put(evidenceObjectKey, JSON.stringify({
      jobId,
      query: job.query,
      kind: job.researchKind,
      stopped,
      calls,
      evidence: evidenceResult.items,
      createdAt: new Date().toISOString(),
    }), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  }
  await progress(env, job, stopped ? "stopping" : "running", stopped ? "正在生成阶段性总结..." : "正在交叉验证并形成最终判断...", "synthesize", 3, evidenceObjectKey);
  const generated = await generateAssistantDeepResearchAnswer(env, job, calls, context.siteEvidenceSummary, evidenceResult.items, stopped);
  const content = ensureDeepResearchAnswerCompleteness(generated.text, job, stopped, evidenceResult.items.length);
  const blocks = extractAssistantBlocks(content, job.query);
  const toolRun = await writeToolRun(env.REPORT_LIBRARY_DB, {
    userKey: job.userKey,
    threadId: job.threadId,
    toolName: "后台深度研究",
    status: "completed",
    summary: `${stopped ? "用户停止后生成阶段性总结" : "深度研究完成"}，共整理 ${evidenceResult.items.length} 条证据摘要。`,
    input: { kind: job.researchKind, calls: calls.map((call) => call.name) },
    output: evidenceResult.items.slice(0, 12),
  });
  const finalMessage = await writeAssistantMessage(env.REPORT_LIBRARY_DB, {
    userKey: job.userKey,
    threadId: job.threadId,
    role: "assistant",
    content,
    metadata: { usage: generated.usage, toolRuns: [toolRun], blocks },
  });
  await writeUsageEvent(env.REPORT_LIBRARY_DB, { userKey: job.userKey, threadId: job.threadId, messageId: finalMessage.id, usage: generated.usage });
  await updateThreadSummaryIfLarge(env.REPORT_LIBRARY_DB, {
    userKey: job.userKey,
    threadId: job.threadId,
    previousSummary: "",
    recentMessages: [],
    latestUserMessage: job.query,
    latestAssistantMessage: content,
  });
  await progress(env, job, "completed", stopped ? "阶段性总结已完成。" : "深度研究已完成。", "completed", 4, evidenceObjectKey, finalMessage.id);
  console.log("assistant_deep_research_completed", { jobId, kind: job.researchKind, evidenceCount: evidenceResult.items.length, elapsedMs: Date.now() - startedAt });
}

async function generateAssistantDeepResearchAnswer(
  env: WorkerEnv,
  job: AssistantDeepResearchWorkerJob,
  calls: AssistantSearchToolCall[],
  siteEvidenceSummary: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
  stopped: boolean,
) {
  const messages = buildDeepResearchMessages(job, calls, siteEvidenceSummary, evidence, stopped);
  let lastError: unknown;
  for (const route of buildDeepSeekFallbackRoutes(env)) {
    try {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("deep-research-model-timeout"), DEEP_RESEARCH_MODEL_ROUTE_TIMEOUT_MS);
      const response = await fetch(route.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) },
        signal: controller.signal,
        body: JSON.stringify(buildDeepSeekRequestBody({
          model: route.model,
          messages,
          maxTokens: 16_000,
          reasoningEffort: "max",
          thinking: { type: "enabled" },
          temperature: 0.08,
          responseFormat: null,
        })),
      }).finally(() => clearTimeout(timeout));
      if (!response.ok) {
        lastError = new Error(`${route.provider} failed: ${response.status}`);
        continue;
      }
      const data = await response.json() as Record<string, unknown>;
      const text = extractMessageContent(data);
      if (!text.trim()) {
        lastError = new Error(`${route.provider} returned empty deep research answer`);
        continue;
      }
      return {
        text,
        usage: {
          model: route.model,
          reasoningEffort: ASSISTANT_REASONING_EFFORT,
          ...parseDeepSeekUsage(data.usage),
          elapsedMs: Date.now() - startedAt,
        } satisfies AssistantUsage,
      };
    } catch (error) {
      lastError = error instanceof Error && error.name === "AbortError"
        ? new Error(`${route.provider} deep research answer timeout`)
        : error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("后台深度研究模型调用失败。");
}

async function runWithAbortTimeout<T>(timeoutMs: number, timeoutMessage: string, task: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(timeoutMessage), timeoutMs);
  try {
    return await task(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timeoutMessage, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildDeepResearchMessages(job: AssistantDeepResearchWorkerJob, calls: AssistantSearchToolCall[], siteEvidenceSummary: string, evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0], stopped: boolean): DeepSeekMessage[] {
  const system = withCacheProtocol([
    "你是 CSTD Alpha 的后台深度投研 Agent。你必须给明确、可复核、不过度承诺的投资判断。",
    "买卖、预测、对比、行业、反驳类问题的主判断只能使用四档之一：看好 / 中性观察 / 谨慎回避 / 反对。",
    "选股、推荐、名单类问题不要硬套四档主判断；第一段写“推荐口径：”或“筛选口径：”，然后直接给用户要求的名单。",
    "禁止用“证据不足”替代答案。证据薄时仍给低置信情景判断，并清楚列出关键缺口。",
    "固定输出顺序：非选股类为主判断；保守/中性/乐观情景；关键证据表；反证条件；下一步跟踪。选股/推荐类为推荐口径；直接推荐名单；保守/中性/乐观情景；关键证据表；反证条件；下一步跟踪。",
    "对比、选股问题必须给清晰排序；预测问题必须给区间。搜索结果只是线索，不得伪装为公告、财报或官方统计。",
    "选股/推荐问题必须先直接回答用户要的名单，不得把名单只藏在情景表、证据表或长段落里。",
    "当用户要求推荐10支A股和10支美股时，必须给两个独立小节：A股Top10推荐、美股Top10推荐；各列满10个，并给代码/市场、核心理由、主要风险。A股必须标注全球业务和国产替代两项判断。",
    "用户询问当前股价时，只能使用标题为实时行情快照、带 retrieved_at 的本轮行情证据；历史研报或旧报告中的价格只能标为历史参考，不能写成当前价。",
    "搜索摘要只是待核验线索。只有公告、财报、实时行情、官方统计等结构化硬证据可写成已披露事实；其他内容必须明确写成线索或待核验判断。",
    "任何标注“异常波动待核验”“财务口径提醒”的同比数据，只能作为核验线索，不得直接写成公司已经断崖下滑、暴雷或确定回避；除非另有至少一条独立公告/财报原文交叉验证。",
    "输出前复核所有金额、百分比、年份和单位，禁止把“2200元”误写成“22年”这类数值单位混淆。",
  ].join("\n"), "assistant-deep-research");
  const user = cacheStableUserContent({
    kind: "assistant-deep-research",
    stable: {
      answerSchema: job.researchKind === "selection"
        ? "selection_rationale_direct_lists_scenarios_evidence_table_counterevidence_tracking"
        : "verdict_scenarios_evidence_table_counterevidence_tracking",
      verdicts: ["看好", "中性观察", "谨慎回避", "反对"],
    },
    volatile: {
      question: job.query,
      researchKind: job.researchKind,
      stopped,
      toolCalls: calls.map((call) => ({ name: call.name, reason: call.reason })),
      siteEvidenceSummary: siteEvidenceSummary || "暂无站内摘要。",
      collectedEvidence: formatCollectedEvidenceForAgent(evidence),
    },
  });
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function buildDeepResearchExecutionToolCalls(
  job: Pick<AssistantDeepResearchWorkerJob, "query" | "mode" | "researchKind">,
  context: { siteEvidenceSummary: string; modeEvidenceSummary: string },
) {
  const mandatory = buildMandatoryAgentToolCalls(job.query, job.mode, context);
  const preferredCompanyQuery =
    mandatory.find((call) => call.name === "read_financial_statements")?.query
    ?? mandatory.find((call) => call.name === "read_tencent_quote")?.query;
  const fallback = buildAssistantDeepResearchToolCalls(job.researchKind, job.query).map((call) => {
    if (
      preferredCompanyQuery
      && (call.name === "read_tencent_quote" || call.name === "read_financial_statements" || call.name === "read_filings_news")
    ) {
      return { ...call, query: preferredCompanyQuery };
    }
    return call;
  });
  const normalizedMandatoryNames = new Set(
    mandatory
      .filter((call) => call.name.startsWith("read_"))
      .map((call) => call.name),
  );
  return dedupeDeepResearchToolCalls([
    ...mandatory,
    ...fallback.filter((call) => !call.name.startsWith("read_") || !normalizedMandatoryNames.has(call.name)),
  ]);
}

function dedupeDeepResearchToolCalls(calls: AssistantSearchToolCall[]) {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.name}:${call.query ?? call.code ?? JSON.stringify(call.rawArgs ?? {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function ensureDeepResearchAnswerCompleteness(text: string, job: AssistantDeepResearchWorkerJob, stopped: boolean, evidenceCount: number) {
  if (hasRequiredDeepResearchAnswerSections(text, job.researchKind, job.query)) return text.trim();
  return [
    text.trim(),
    "",
    `补充说明：${stopped ? "这是用户停止后的阶段性总结" : "本轮后台研究已完成"}，当前共整理 ${evidenceCount} 条证据摘要。`,
    "",
    "保守/中性/乐观情景：若关键硬数据恶化，按保守情景处理；若核心变量延续，按中性情景处理；只有财报、价格或订单至少两项同步改善，才进入乐观情景。",
    "",
    "| 关键证据 | 当前口径 |",
    "| --- | --- |",
    `| 已整理证据摘要 | ${evidenceCount} 条 |`,
    "",
    "反证条件：若最新公告、财报、价格、销量或订单和本轮摘要相反，应立即下调判断。",
    "",
    "下一步跟踪：跟踪最新财报、公告、价格、销量、订单、现金流和估值变化。",
  ].join("\n");
}

async function progress(env: WorkerEnv, job: AssistantDeepResearchWorkerJob, status: "running" | "stopping" | "completed", title: string, stage: string, current: number, evidenceObjectKey?: string, resultMessageId?: string) {
  await writeAssistantDeepResearchProgress(env.REPORT_LIBRARY_DB, env.REPORT_CACHE, {
    id: job.id,
    status,
    title,
    stage,
    current,
    total: 4,
    evidenceObjectKey,
    resultMessageId,
  });
}

function extractMessageContent(data: Record<string, unknown>) {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}
