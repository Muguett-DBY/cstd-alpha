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
import { buildAssistantTaskContract, formatAssistantTaskContract, validateAssistantTaskAnswer } from "../../functions/_shared/assistant-task-contract";
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
    siteEvidenceSummary: await buildSiteEvidenceSummary(env.REPORT_LIBRARY_DB, job.userKey, job.query),
    modeEvidenceSummary: "",
  };
  const calls = buildDeepResearchExecutionToolCalls(job, context);
  await writeAssistantDeepResearchStep(env.REPORT_LIBRARY_DB, { jobId, round: 1, stage: "plan", title: "已生成最低证据包", status: "completed", summary: calls.map((call) => call.name).join("、") });

  const stoppedBeforeTools = await isAssistantDeepResearchStopRequested(env.REPORT_LIBRARY_DB, jobId);
  await progress(env, job, stoppedBeforeTools ? "stopping" : "running", stoppedBeforeTools ? "正在整理阶段性总结..." : "正在查行情、财报、公告和外部来源...", "collect", 2);
  let evidenceResult = stoppedBeforeTools
    ? { items: [], exa: { used: false, count: 0 }, summary: "用户在检索前停止任务。" }
    : await runWithAbortTimeout(
      DEEP_RESEARCH_TOOL_TIMEOUT_MS,
      "深度研究证据检索超时。",
      (signal) => executeAssistantToolCalls(env, calls, signal, context),
    );
  const enrichmentCalls = stoppedBeforeTools ? [] : buildDeepResearchCandidateEnrichmentToolCalls(job, evidenceResult.items, calls);
  if (enrichmentCalls.length) {
    await writeAssistantDeepResearchStep(env.REPORT_LIBRARY_DB, {
      jobId,
      round: 2,
      stage: "enrich",
      title: "正在补抓候选公司行情和财报",
      status: "running",
      summary: enrichmentCalls.map((call) => call.name).join("、"),
    });
    const enriched = await runWithAbortTimeout(
      DEEP_RESEARCH_TOOL_TIMEOUT_MS,
      "候选公司补充检索超时。",
      (signal) => executeAssistantToolCalls(env, enrichmentCalls, signal, context),
    );
    calls.push(...enrichmentCalls);
    evidenceResult = {
      items: [...evidenceResult.items, ...enriched.items],
      exa: evidenceResult.exa,
      summary: [evidenceResult.summary, enriched.summary].filter(Boolean).join("；"),
    };
  }
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
  const contract = buildAssistantTaskContract(job.researchKind, job.query);
  const validation = validateAssistantTaskAnswer(generated.text, contract);
  const disciplineIssues = findAssistantEvidenceDisciplineIssues(generated.text, evidenceResult.items);
  const repaired = !stopped && (!validation.valid || disciplineIssues.length)
    ? await repairAssistantDeepResearchAnswer(env, job, generated.text, [...validation.missing, ...disciplineIssues], calls, context.siteEvidenceSummary, evidenceResult.items)
    : generated.text;
  const normalized = sanitizeAssistantAStockTickerPairs(repaired, evidenceResult.items);
  const disciplined = sanitizeAssistantEvidenceConfidenceLabels(normalized, evidenceResult.items);
  const content = ensureDeepResearchAnswerCompleteness(disciplined, job, stopped, evidenceResult.items.length);
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
  const taskContract = buildAssistantTaskContract(job.researchKind, job.query);
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
    "任何精确金额、百分比、倍数、份额、增速、估值和预测数字必须紧邻本轮证据编号（例如 E3）。如果本轮证据没有提供该数字，删除精确数字，改写成定性判断或“待核验线索”；禁止凭常识补数字。",
    "搜索摘要、券商研报汇总和财经新闻不能标成“高置信”或“中高置信”。高置信标签必须引用本轮结构化行情、财报、公告或官方统计 E 编号。",
    "任何标注“异常波动待核验”“财务口径提醒”的同比数据，只能作为核验线索，不得直接写成公司已经断崖下滑、暴雷或确定回避；除非另有至少一条独立公告/财报原文交叉验证。",
    "输出前复核所有金额、百分比、年份和单位，禁止把“2200元”误写成“22年”这类数值单位混淆。",
    "任务契约优先级最高：必须完整回答契约要求的市场、数量、主体和字段。格式完整但漏掉用户要的名单、当前价或对比对象，仍然属于失败答案。",
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
      taskContract: formatAssistantTaskContract(taskContract),
      researchKind: job.researchKind,
      stopped,
      toolCalls: calls.map((call) => ({ name: call.name, reason: call.reason })),
      siteEvidenceSummary: siteEvidenceSummary || "暂无站内摘要。",
      collectedEvidence: formatCollectedEvidenceForAgent(evidence),
    },
  });
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

async function repairAssistantDeepResearchAnswer(
  env: WorkerEnv,
  job: AssistantDeepResearchWorkerJob,
  originalText: string,
  missing: string[],
  calls: AssistantSearchToolCall[],
  siteEvidenceSummary: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  const contract = buildAssistantTaskContract(job.researchKind, job.query);
  const messages: DeepSeekMessage[] = [
    {
      role: "system",
      content: withCacheProtocol([
        "你是 CSTD Alpha 深研答案修复器。只修复当前答案遗漏的用户任务，不要追加通用模板，不要改变问题，不要省略原答案里正确的信息。",
        "必须直接补齐缺失的名单、数量、市场、当前价格、预测区间或对比对象。不能把名单藏进情景说明。禁止编造本轮证据没有提供的硬数据。",
        "精确金额、百分比、倍数、份额、增速、估值和预测数字必须紧邻真实存在的本轮 E 编号。如果证据中没有数字，删除该精确数字并改写为定性判断或待核验线索。禁止为了显得专业而补数字。",
        "搜索摘要、券商研报汇总和财经新闻只能作为线索，不能标成高置信或中高置信；高置信必须绑定本轮结构化行情、财报、公告或官方统计 E 编号。",
      ].join("\n"), "assistant-deep-research-repair"),
    },
    {
      role: "user",
      content: cacheStableUserContent({
        kind: "assistant-deep-research-repair",
        stable: { repairRule: "answer_the_exact_question_and_fill_only_missing_requirements" },
        volatile: {
          question: job.query,
          taskContract: formatAssistantTaskContract(contract),
          missing,
          originalText,
          toolCalls: calls.map((call) => ({ name: call.name, reason: call.reason })),
          siteEvidenceSummary,
          collectedEvidence: formatCollectedEvidenceForAgent(evidence),
        },
      }),
    },
  ];
  for (const route of buildDeepSeekFallbackRoutes(env)) {
    try {
      const response = await fetch(route.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) },
        body: JSON.stringify(buildDeepSeekRequestBody({
          model: route.model,
          messages,
          maxTokens: 12_000,
          reasoningEffort: "max",
          thinking: { type: "enabled" },
          temperature: 0.04,
          responseFormat: null,
        })),
      });
      if (!response.ok) continue;
      const text = extractMessageContent(await response.json() as Record<string, unknown>).trim();
      if (text && validateAssistantTaskAnswer(text, contract).valid) return text;
    } catch {
      continue;
    }
  }
  return originalText.trim();
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

export function buildDeepResearchCandidateEnrichmentToolCalls(
  job: Pick<AssistantDeepResearchWorkerJob, "query" | "researchKind">,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
  previousCalls: AssistantSearchToolCall[] = [],
) {
  if (job.researchKind !== "selection") return [];
  const text = evidence.map((item) => `${item.title}\n${item.summary}\n${item.content ?? ""}`).join("\n");
  const codes = [...new Set(text.match(/\b[0368]\d{5}\b/g) ?? [])].slice(0, 8);
  if (!codes.length) return [];
  const existing = new Set(previousCalls.map((call) => `${call.name}:${call.query ?? ""}`));
  const calls: AssistantSearchToolCall[] = [];
  for (let index = 0; index < codes.length; index += 5) {
    const query = codes.slice(index, index + 5).join(",");
    const batch = Math.floor(index / 5) + 1;
    calls.push(
      { id: `deep:enrich:quote:${batch}`, name: "read_tencent_quote", query, reason: "候选公司发现后批量核验行情和估值" },
      { id: `deep:enrich:financials:${batch}`, name: "read_financial_statements", query, reason: "候选公司发现后批量核验财报和现金流" },
      { id: `deep:enrich:reports:${batch}`, name: "read_reports_concepts", query, reason: "候选公司发现后补研报与行业归属" },
    );
  }
  return calls.filter((call) => !existing.has(`${call.name}:${call.query}`));
}

export function sanitizeAssistantAStockTickerPairs(
  text: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  const verifiedPairs = new Map<string, string>();
  const evidenceText = evidence.map((item) => `${item.title}\n${item.summary}\n${item.content ?? ""}`).join("\n");
  for (const match of evidenceText.matchAll(/([A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff·]{1,20})\s*[（(]\s*([0368]\d{5})\s*[)）]/g)) {
    verifiedPairs.set(match[1], match[2]);
  }
  for (const match of evidenceText.matchAll(/【([A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff·]{1,20})\s+([0368]\d{5})\s+/g)) {
    verifiedPairs.set(match[1], match[2]);
  }
  let normalized = text;
  for (const [name, code] of verifiedPairs) {
    normalized = normalized.replace(
      new RegExp(`${escapeRegExp(name)}\\s*[（(]\\s*[0368]\\d{5}(?:\\.(?:SH|SZ|BJ))?\\s*[)）]`, "gi"),
      `${name} (${code})`,
    );
  }
  return normalized;
}

export function findAssistantEvidenceDisciplineIssues(
  text: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const issues: string[] = [];
  const uncitedPreciseClaims = lines.filter((line) => (
    hasAssistantPreciseInvestmentMetric(line)
    && !hasAssistantEvidenceCitation(line)
    && !isAssistantScenarioLine(line)
  ));
  if (uncitedPreciseClaims.length >= 2) {
    issues.push("精确数字必须引用本轮 E 编号，否则删除精确数字并改写为定性判断");
  }
  if (lines.some((line) => /(中高置信|高置信)/.test(line) && !hasStructuredAssistantEvidenceCitation(line, evidence))) {
    issues.push("高置信或中高置信标签必须绑定本轮结构化硬证据 E 编号");
  }
  return issues;
}

export function sanitizeAssistantEvidenceConfidenceLabels(
  text: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  return text.split(/\r?\n/).map((line) => {
    if (!/(中高置信|高置信)/.test(line) || hasStructuredAssistantEvidenceCitation(line, evidence)) return line;
    return line.replace(/中高置信|高置信/g, "中等（待核验原始来源）");
  }).join("\n");
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAssistantPreciseInvestmentMetric(line: string) {
  return /(?:\d+(?:\.\d+)?\s*(?:%|倍|x|X|亿元|万元|元|亿|万|bps|BP|PB|PE|P\/E)|(?:市占率|份额|增速|增长|收入|净利|毛利率|估值|产能|订单)[^\n]{0,18}\d)/.test(line);
}

function hasAssistantEvidenceCitation(line: string) {
  return /\bE\d+\b/.test(line);
}

function isAssistantScenarioLine(line: string) {
  return /(情景|假设|若|如果|预计|目标|触发|跟踪|风险|下修|上修|低于|高于|至多|至少)/.test(line);
}

function hasStructuredAssistantEvidenceCitation(
  line: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  const sorted = [...evidence]
    .sort((left, right) => assistantEvidencePriority(right) - assistantEvidencePriority(left))
    .slice(0, 24);
  for (const match of line.matchAll(/\bE(\d+)\b/g)) {
    const item = sorted[Number(match[1]) - 1];
    if (item?.source === "CSTD Alpha" && item.sourceType === "official" && (item.qualityScore ?? 1) >= 0.5) return true;
  }
  return false;
}

function assistantEvidencePriority(item: Parameters<typeof formatCollectedEvidenceForAgent>[0][number]) {
  return (
    (item.source === "CSTD Alpha" ? 100 : 0)
    + (item.sourceType === "official" ? 30 : 0)
    + Math.max(0, item.weight || 0)
    + Math.max(0, item.qualityScore || 0)
  );
}

export function ensureDeepResearchAnswerCompleteness(text: string, job: AssistantDeepResearchWorkerJob, stopped: boolean, evidenceCount: number) {
  if (hasRequiredDeepResearchAnswerSections(text, job.researchKind, job.query)) return text.trim();
  if (!stopped) return text.trim();
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
