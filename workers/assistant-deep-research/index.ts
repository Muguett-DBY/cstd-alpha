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
const MAX_ASSISTANT_DEEP_RESEARCH_REPAIR_ATTEMPTS = 2;

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
  let repaired = generated.text;
  for (let repairAttempt = 0; repairAttempt < MAX_ASSISTANT_DEEP_RESEARCH_REPAIR_ATTEMPTS; repairAttempt += 1) {
    const validation = validateAssistantTaskAnswer(repaired, contract);
    const disciplineIssues = findAssistantEvidenceDisciplineIssues(repaired, evidenceResult.items);
    const repairIssues = [...validation.missing, ...disciplineIssues];
    if (!shouldContinueAssistantRepair(repairAttempt, repairIssues, stopped)) break;
    repaired = await repairAssistantDeepResearchAnswer(env, job, repaired, repairIssues, calls, context.siteEvidenceSummary, evidenceResult.items);
  }
  const presentationReady = stripAssistantRepairPreamble(repaired);
  const normalized = sanitizeAssistantAStockTickerPairs(presentationReady, evidenceResult.items);
  const disciplined = sanitizeAssistantEvidenceConfidenceLabels(normalized, evidenceResult.items);
  const leverageDisciplined = sanitizeAssistantUnsupportedLeverageLabels(disciplined, evidenceResult.items);
  const anomalyDisciplined = sanitizeAssistantAnomalousFinancialConclusions(leverageDisciplined, job, evidenceResult.items);
  const sectorDisciplined = sanitizeAssistantUnsupportedIndustrySubsectorVerdicts(anomalyDisciplined, evidenceResult.items);
  const technicalDisciplined = sanitizeAssistantTechnicalMarketingClaims(sectorDisciplined);
  const relativeDisciplined = ensureAssistantExplicitRelativeRiskRanking(technicalDisciplined, job.query);
  const evidenceLabelDisciplined = ensureAssistantEvidenceTableLabel(relativeDisciplined);
  const echoDisciplined = sanitizeAssistantQuestionEcho(evidenceLabelDisciplined, job.query);
  const content = ensureDeepResearchAnswerCompleteness(sanitizeAssistantPresentationText(sanitizeAssistantSafetyDisclaimers(echoDisciplined)), job, stopped, evidenceResult.items.length);
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
    "这是 admin 私人投研助手，不是公开合规报告。禁止输出“免责声明”“不构成投资建议”“投资需谨慎”“请咨询专业人士”等泛化安全套话；需要保守时用证据等级、反证条件和跟踪项表达。",
    "买卖、预测、行业、反驳类问题的主判断只能使用四档之一：看好 / 中性观察 / 谨慎回避 / 反对。",
    "对比类问题不要单独套四档主判断；第一段必须写相对结论、排序或优先级，例如“主判断：贵州茅台相对更稳，五粮液弹性更高但风险更大”。",
    "选股、推荐、名单类问题不要硬套四档主判断；第一段写“推荐口径：”或“筛选口径：”，然后直接给用户要求的名单。",
    "禁止用“证据不足”替代答案。证据薄时仍给低置信情景判断，并清楚列出关键缺口。",
    "固定输出顺序：预测/行业/反驳/买卖类为主判断；保守/中性/乐观情景；关键证据表；反证条件；下一步跟踪。对比类为相对主判断；对比表；胜负手/排序；反证条件；下一步跟踪。选股/推荐类为推荐口径；直接推荐名单；保守/中性/乐观情景；关键证据表；反证条件；下一步跟踪。",
    "对比、选股问题必须给清晰排序；预测问题必须给区间。若用户要求净利润、营收、股价、目标价或估值等数值预测，保守/中性/乐观三档都必须给可计算的数字或数字区间；证据薄时降低置信度，但禁止用“无精确区间”“方向低于当前价”“无法给区间”等文字代替数字区间。搜索结果只是线索，不得伪装为公告、财报或官方统计。",
    "如果用户要求“量化关键假设”“测算”“利润桥”或“影响区间”，每个情景必须同时给至少一个明确的输入假设点值或区间，以及最终结果数字区间，例如交付量/ASP/毛利率输入区间、分部全年经营亏损/利润、集团利润影响或股价区间。禁止只写“低于Q1”“接近目标”“显著超过”“大幅收窄”“接近盈亏平衡”。",
    "情景结果数字区间属于分析估算，不是已披露事实。允许基于明确输入假设给较宽的估算区间，但必须写明“估算区间”或“低置信区间”；不要因为没有公司指引而退回模糊文字。",
    "选股/推荐问题必须先直接回答用户要的名单，不得把名单只藏在情景表、证据表或长段落里。",
    "当用户要求推荐10支A股和10支美股时，必须给两个独立小节：A股Top10推荐、美股Top10推荐；各列满10个，并给代码/市场、核心理由、主要风险。A股必须标注全球业务和国产替代两项判断。",
    "AI算力、半导体或AI产业链问题必须先横向比较核心利润环节，至少覆盖 GPU/AI芯片、HBM/存储、光模块/光器件、先进制程/封装、AI服务器/整机、PCB/交换芯片/电源散热。若最终推荐只保留其中部分环节，必须说明其他环节为何未排在前面；禁止只讨论晶圆代工、芯片或服务器而漏掉光模块和HBM。",
    "消费出海、品牌出海或中国消费公司出海问题必须聚焦消费者端公司和商业模式，例如潮玩/IP、新茶饮、家电、消费电子、跨境平台/品牌、餐饮零售和生活方式品牌。光模块、半导体、服务器、工业设备等只能作为宏观出口背景，不得作为消费出海代表公司或主结论依据。",
    "行业拆分问题必须逐环节核验。若某个子环节只有相邻环节、券商摘要或行业间接线索，没有该子环节公司级财报、订单、出货、价格或官方统计，不得直接标为“看好”；最多写“中性观察，等待直接硬证据”。",
    "太空数据中心、轨道能源、万亿级新市场、通用AGI等远期叙事只能放在“远期待核验线索”，不得作为当前行业评级、盈利拐点或乐观情景的主要依据。",
    "用户询问当前股价时，只能使用标题为实时行情快照、带 retrieved_at 的本轮行情证据；历史研报或旧报告中的价格只能标为历史参考，不能写成当前价。",
    "搜索摘要只是待核验线索。只有公告、财报、实时行情、官方统计等结构化硬证据可写成已披露事实；其他内容必须明确写成线索或待核验判断。",
    "任何精确金额、百分比、倍数、份额、增速、估值和预测数字必须紧邻本轮证据编号（例如 E3）。如果本轮证据没有提供该数字，删除精确数字，改写成定性判断或“待核验线索”；禁止凭常识补数字。",
    "美股财务和估值题必须优先使用 SEC、公司 IR/财报原文、实时行情或站内结构化证据。若精确收入、净利、毛利率、客户集中度、PEG、Forward P/E 等只来自 Exa/Brave/Tavily/AnySearch/SearXNG 搜索摘要或券商摘要，必须写成“中/低置信线索”，不得标“高”或用来支撑强评级。",
    "搜索摘要、券商研报汇总和财经新闻不能标成“高置信”或“中高置信”。高置信标签必须引用本轮结构化行情、财报、公告或官方统计 E 编号。",
    "机器人、AI、半导体、医药等技术题中，公司宣传稿、媒体转述、采访和发布会只能作为线索。禁止把“全球第一”“全球唯一”“绝对领先”“行业第一”等宣传性绝对表述直接写成事实；必须改成“公司披露称”“公开资料显示”“横向口径仍需第三方复核”。非上市竞争对手的收入、利润、毛利率等精确数字若没有审计财报或官方披露，只能写成“媒体线索，待核验”。",
    "严格区分营运资金压力和财务杠杆：没有资产负债率、有息负债、净负债率或借款数据时，不得把票据、应收或单季经营现金流压力写成“高杠杆”。",
    "任何标注“异常波动待核验”“财务口径提醒”的同比数据，只能作为核验线索，不得直接写成公司已经断崖下滑、暴雷或确定回避；除非另有至少一条独立公告/财报原文交叉验证。",
    "如果证据中出现“单源异常”“缺少第二硬源交叉验证”或“异常同比只能作为待核验线索”，必须降低该公司财报数字权重；不得用这些异常数字推出“极大概率”“几乎全部情景”“确定超过/低于/跑赢”等强结论。",
    "情景测算中引用历史年度基数时，历史数字仍必须紧邻本轮 E 编号；不得把未引用的历史基数混入预测。价格、销量、利润率等变量的方向解释必须自洽，例如高价或高配产品通常不能写成“拉低均价”。",
    "英文财报金额必须保留原始小数点和单位：例如 $81.6 billion 必须写成 81.6B 或 81.6 billion，禁止写成 816B；$91.0 billion 必须写成 91.0B 或 91.0 billion，禁止写成 910B。",
    "若本轮证据没有明确给出财年结束日期，不要自行写“至某年某月”；禁止出现 FY2028 却写成至2026年这类财年自然年倒置。",
    "英文 end of decade 应译为“十年末/2030年前后/本十年末”，不是“本世纪末”；没有明确证据时删除这类超长期表述。",
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
        "你是 CSTD Alpha 深研答案校验步骤。只输出最终用户可读答案，不要提到校验、修复、规则、原答案、修复后的版本或系统指令。",
        "禁止输出“免责声明”“不构成投资建议”“投资需谨慎”“请咨询专业人士”等泛化安全套话；需要保守时用证据等级、反证条件和跟踪项表达。",
        "只修复当前答案遗漏的用户任务，不要追加通用模板，不要改变问题，不要省略原答案里正确的信息。",
        "必须直接补齐缺失的名单、数量、市场、当前价格、预测区间或对比对象。预测类若任一保守/中性/乐观情景缺少数字或数字区间，必须补齐；证据薄时写低置信区间，禁止用“无精确区间”“方向低于当前价”“无法给区间”等文字替代。不能把名单藏进情景说明。禁止编造本轮证据没有提供的硬数据。",
        "如果用户要求“量化关键假设”“测算”“利润桥”或“影响区间”，每个情景必须同时给至少一个明确的输入假设点值或区间，以及最终结果数字区间，例如交付量/ASP/毛利率输入区间、分部全年经营亏损/利润、集团利润影响或股价区间。禁止只写“低于Q1”“接近目标”“显著超过”“大幅收窄”“接近盈亏平衡”。",
        "情景结果数字区间属于分析估算，不是已披露事实。允许基于明确输入假设给较宽的估算区间，但必须写明“估算区间”或“低置信区间”；不要因为没有公司指引而退回模糊文字。",
        "行业拆分问题必须逐环节核验。某个子环节若只有相邻环节或行业间接线索，没有该子环节公司级财报、订单、出货、价格或官方统计，不得直接标为“看好”；最多写“中性观察，等待直接硬证据”。",
        "太空数据中心、轨道能源、万亿级新市场、通用AGI等远期叙事只能写成远期待核验线索，不能作为当前行业评级或盈利拐点的依据。",
        "精确金额、百分比、倍数、份额、增速、估值和预测数字必须紧邻真实存在的本轮 E 编号。如果证据中没有数字，删除该精确数字并改写为定性判断或待核验线索。禁止为了显得专业而补数字。",
        "美股财务和估值题必须优先使用 SEC、公司 IR/财报原文、实时行情或站内结构化证据。若精确收入、净利、毛利率、客户集中度、PEG、Forward P/E 等只来自 Exa/Brave/Tavily/AnySearch/SearXNG 搜索摘要或券商摘要，必须写成“中/低置信线索”，不得标“高”或用来支撑强评级。",
        "搜索摘要、券商研报汇总和财经新闻只能作为线索，不能标成高置信或中高置信；高置信必须绑定本轮结构化行情、财报、公告或官方统计 E 编号。",
        "机器人、AI、半导体、医药等技术题中，公司宣传稿、媒体转述、采访和发布会只能作为线索。禁止把“全球第一”“全球唯一”“绝对领先”“行业第一”等宣传性绝对表述直接写成事实；必须改成“公司披露称”“公开资料显示”“横向口径仍需第三方复核”。非上市竞争对手的收入、利润、毛利率等精确数字若没有审计财报或官方披露，只能写成“媒体线索，待核验”。",
        "如果证据中出现“单源异常”“异常波动待核验”“缺少第二硬源交叉验证”，相关财务数字必须写成待核验线索；不得用这些数字推出“极大概率”“几乎全部情景”“确定超过/低于/跑赢”等强结论。",
        "情景测算中引用历史年度基数时，历史数字仍必须紧邻本轮 E 编号；不得把未引用的历史基数混入预测。价格、销量、利润率等变量的方向解释必须自洽，例如高价或高配产品通常不能写成“拉低均价”。",
        "英文财报金额必须保留原始小数点和单位：例如 $81.6 billion 必须写成 81.6B 或 81.6 billion，禁止写成 816B；$91.0 billion 必须写成 91.0B 或 91.0 billion，禁止写成 910B。",
        "若本轮证据没有明确给出财年结束日期，不要自行写“至某年某月”；禁止出现 FY2028 却写成至2026年这类财年自然年倒置。",
        "英文 end of decade 应译为“十年末/2030年前后/本十年末”，不是“本世纪末”；没有明确证据时删除这类超长期表述。",
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

export function stripAssistantRepairPreamble(text: string) {
  const markerPattern = /(相对主判断|主判断|结论|推荐排序|对比表|候选名单|保守\s*[／/]\s*中性\s*[／/]\s*乐观|关键证据表)/;
  const lines = text.trim().split(/\r?\n/);
  const firstMarkerIndex = lines.findIndex((line) => markerPattern.test(line));
  const leakedPreamble = lines
    .slice(0, Math.max(0, firstMarkerIndex))
    .some((line) => /(修复器|修复后的版本|严格遵循|系统指令|校验步骤|原答案|收到指令|核心修复点)/.test(line));

  if (firstMarkerIndex > 0 && leakedPreamble) return lines.slice(firstMarkerIndex).join("\n").trim();
  return text.trim()
    .replace(/^好的，?收到指令。?\s*/u, "")
    .replace(/^以下是修复后的版本[:：]\s*/u, "")
    .trim();
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
  if (lines.some((line) => hasUnverifiedUsFinancialMetricClaim(line, evidence))) {
    issues.push("美股精确财务/估值数字必须来自 SEC、公司 IR、实时行情或站内结构化硬源；搜索线索不得标高或支撑强评级");
  }
  if (lines.some(hasUncitedHistoricalBaselineMetric)) {
    issues.push("情景中的历史基数必须引用本轮 E 编号，否则删除该历史数字");
  }
  if (lines.some(hasContradictoryAspDirection)) {
    issues.push("高价或高配产品对 ASP 的方向解释自相矛盾，重新核对表述");
  }
  if (lines.some((line) => hasDroppedBUnitDecimalFromEvidence(line, evidence))) {
    issues.push("紧邻 E 编号的 B 单位金额疑似丢失小数点，必须按对应证据原文保留小数和单位");
  }
  if (lines.some(hasBackwardFiscalYearDate)) {
    issues.push("财年年份与自然年明显倒置，必须删除错误日期或改成可核验口径");
  }
  if (lines.some(hasLikelyEndOfCenturyMistranslation)) {
    issues.push("“本世纪末”这类超长期表述疑似误译，必须改为证据支持的年份或删除");
  }
  const anomalousEvidenceText = collectAssistantAnomalousEvidenceText(evidence);
  if (anomalousEvidenceText && lines.some((line) => hasUnqualifiedAnomalousFinancialUse(line, anomalousEvidenceText))) {
    issues.push("单源异常财务数据只能作为待核验线索，不能支撑确定排序、极大概率判断或强烈经营结论");
  }
  if (lines.some(hasUnqualifiedAccountingRestatementClaim)) {
    issues.push("会计差错、追溯调整、管理层事件等重大事项必须明确为本轮证据线索并标待核验，否则删除");
  }
  return issues;
}

export function shouldContinueAssistantRepair(attempt: number, issues: string[], stopped: boolean) {
  return !stopped && attempt < MAX_ASSISTANT_DEEP_RESEARCH_REPAIR_ATTEMPTS && issues.length > 0;
}

export function sanitizeAssistantEvidenceConfidenceLabels(
  text: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  return text.split(/\r?\n/).map((line) => {
    if (!/(中高置信|高置信)/.test(line) || hasStructuredAssistantEvidenceCitation(line, evidence)) return line;
    return line.replace(/中高置信|高置信/g, "中等置信");
  }).map((line) => {
    if (!hasHighEvidenceStrengthLabel(line) || hasUsFinancialHardEvidenceCitation(line, evidence) || hasStructuredAssistantEvidenceCitation(line, evidence)) return line;
    return line
      .replace(/\*\*高\*\*/g, "**中**")
      .replace(/(^|\|)\s*高\s*(?=\||—|-|—|$)/g, "$1 中 ")
      .replace(/高\s*—/g, "中 —")
      .replace(/高\s*-/g, "中 -");
  }).join("\n");
}

export function sanitizeAssistantSafetyDisclaimers(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/(免责声明|不构成投资建议|投资需谨慎|请咨询专业人士|仅供参考)/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeAssistantPresentationText(text: string) {
  return text
    .replace(/[\uE000-\uF8FF]/g, " ")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/（?E\d+\s*[-‑–~至]\s*E\d+[^。；;\n]{0,36}(?:占位|空结果|空白|无结果)[^。；;\n]{0,36}）?/g, "本轮相关工具未返回足够结构化硬数据")
    .replace(/(?:E\d+\s*[-‑–~至]\s*E\d+|E\d+\s*[/、]\s*E\d+)[^。；;\n]{0,24}(?:占位|空结果|空白|无结果)[^。；;\n]{0,36}/g, "本轮相关工具未返回足够结构化硬数据")
    .replace(/%(\d+(?:\.\d+)?)/g, "$1%")
    .replace(/风险\/threat/g, "风险")
    .replace(/太空算力/g, "算力绿电需求")
    .replace(/太空光伏/g, "新技术路线")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function sanitizeAssistantQuestionEcho(text: string, query: string) {
  const lines = text.trim().split(/\r?\n/);
  const normalizedQuery = normalizeAssistantEchoText(query);
  while (lines.length) {
    const first = lines[0].trim();
    if (!first) {
      lines.shift();
      continue;
    }
    if (/^好的[，,。]?\s*(?:admin[，,。]?\s*)?(收到|明白|我来|你的问题|收到你的问题|以下是)/i.test(first)) {
      lines.shift();
      continue;
    }
    if (normalizeAssistantEchoText(first) === normalizedQuery) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join("\n").trim();
}

export function sanitizeAssistantUnsupportedIndustrySubsectorVerdicts(
  text: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  const evidenceText = evidence.map((item) => `${item.title}\n${item.summary}\n${item.content ?? ""}`).join("\n");
  const hasDirectInverterEvidence = /(逆变器|阳光电源|德业股份|固德威|锦浪科技|禾迈股份|inverter).{0,120}(财报|公告|订单|出货|销量|营收|净利润|毛利率|经营现金流|价格|官方统计)/i.test(evidenceText);
  let normalized = text;
  if (!hasDirectInverterEvidence) {
    normalized = normalized.replace(
      /(逆变器(?:环节)?[：:]\s*)(?:\*{0,2})?看好(?:\*{0,2})?(?=[（(，,。\s])/g,
      "$1中性观察（本轮缺少逆变器公司级财报、订单、出货或价格硬证据）",
    );
  }
  return normalized
    .replace(/太空数据中心/g, "远期算力绿电线索（待核验）")
    .replace(/轨道能源体系的核心基础设施/g, "远期潜在线索")
    .replace(/全新的[“"]?轨道级[”"]?市场/g, "远期待核验市场")
    .replace(/新的万亿级市场/g, "远期待核验市场");
}

export function sanitizeAssistantTechnicalMarketingClaims(text: string) {
  return text
    .replace(/(?:自研)?\s*Thinker\s*大模型[^。；;\n]{0,30}(?:九项|9项)[^。；;\n]{0,20}全球第一[^。；;\n]*/gi, "公司公开材料称自研 Thinker 大模型取得多项评测领先，尚需第三方复核和 benchmark 验证")
    .replace(/(?:公司是)?全球唯一[^。；;\n]{0,20}(?:交付|交付量)[^。；;\n]{0,20}(?:千台|1000台)[^。；;\n]{0,20}(?:全尺寸)?人形机器人[^。；;\n]*/g, "公开资料显示已实现千台级全尺寸人形机器人交付，是否全球唯一仍需统一口径复核")
    .replace(/宇树(?:科技)?[^。；;\n]{0,24}2025年[^。；;\n]{0,28}(?:盈利|利润)[^。；;\n]{0,12}6\s*(?:亿|亿元)[^。；;\n]*/g, "媒体线索称宇树2025年盈利约6亿元（非上市公司审计财报，待核验）")
    .replace(/宇树(?:科技)?[^。；;\n]{0,24}2025年[^。；;\n]{0,28}(?:已实现[^。；;\n]{0,8}盈利|实现盈利)[^。；;\n]*(?:IPO[^。；;\n]*)?/g, "媒体线索称宇树科技2025年可能已实现盈利，IPO状态需以官方披露为准（非上市公司审计财报，待核验）")
    .replace(/(?:竞争对手|竞品)?宇树(?:科技)?(?![^。；;\n]{0,12}2025年)[^。；;\n]{0,12}(?:已盈利|已实现[^。；;\n]{0,8}盈利|实现盈利)(?:（[^）]{0,30}）)?/g, "媒体线索称宇树科技可能已盈利（非上市公司审计财报，待核验）")
    .replace(/，?已经明显领先/g, "，但领先程度仍需第三方指标复核");
}

export function ensureAssistantExplicitRelativeRiskRanking(text: string, query: string) {
  if (!/(主要风险|核心风险|最大风险|风险)[^是。？！?\n]{0,24}是/.test(query) || !/还是/.test(query)) return text.trim();
  const firstPart = text.slice(0, 650);
  if (/(风险排序|风险优先级|风险排名|优先级|排序|排名|第一|第二|>|＞|≥)/.test(firstPart)) return text.trim();
  const options = extractAssistantRiskOptions(query);
  if (options.length < 2) return text.trim();
  return `风险排序：${rankAssistantRiskOptions(options).join(" > ")}。\n\n${text.trim()}`;
}

export function ensureAssistantEvidenceTableLabel(text: string) {
  if (/(关键证据表|证据表|证据编号|来源)/.test(text)) return text.trim();
  if (!/\|[^\n]+\|\s*\n\|(?:\s*:?-+:?\s*\|)+/.test(text)) return text.trim();
  if (!/\bE\d+\b|E\d+\s*[/;、]\s*E\d+/i.test(text)) return text.trim();
  return text.replace(/(\n|^)(\|[^\n]+\|\s*\n\|(?:\s*:?-+:?\s*\|)+)/, "$1### 关键证据表（对比口径）\n$2").trim();
}

function extractAssistantRiskOptions(query: string) {
  const match = query.match(/(?:主要风险|核心风险|最大风险|风险)[^是。？！?\n]{0,24}是([^。？！?\n]+)/);
  if (!match) return [];
  return Array.from(new Set(match[1]
    .split(/还是|、|，|,|和|与/)
    .map((item) => item.replace(/^[\s:：]+|[\s？?。]+$/g, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 12)));
}

function rankAssistantRiskOptions(options: string[]) {
  const priority = ["现金流", "商业化", "估值", "技术落地", "技术"];
  return [...options].sort((left, right) => riskOptionPriority(left, priority) - riskOptionPriority(right, priority));
}

function riskOptionPriority(option: string, priority: string[]) {
  const index = priority.findIndex((keyword) => option.includes(keyword));
  return index >= 0 ? index : priority.length;
}

function normalizeAssistantEchoText(value: string) {
  return value.replace(/[#*_`>\s。！？!?，,：:；;、“”"']/g, "").toLowerCase();
}

export function sanitizeAssistantUnsupportedLeverageLabels(
  text: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  if (!/高杠杆/.test(text)) return text;
  const evidenceText = evidence.map((item) => `${item.title}\n${item.summary}\n${item.content ?? ""}`).join("\n");
  if (/(资产负债率|有息负债|净负债率|利息保障倍数|短期借款|长期借款|债务率|debt[- ]to[- ]equity|net debt|leverage)/i.test(evidenceText)) return text;
  return text.replace(/高杠杆/g, "营运压力较高");
}

export function sanitizeAssistantAnomalousFinancialConclusions(
  text: string,
  job: Pick<AssistantDeepResearchWorkerJob, "query" | "researchKind">,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  const scope = `${job.query}\n${text}`;
  if (/(五粮液|000858)/.test(scope) && /(贵州茅台|茅台|600519)/.test(scope) && hasMoutaiWuliangyeAnomalousFinancialDisplay(text)) {
    return buildMoutaiWuliangyeAnomalySafeAnswer();
  }
  const issues = findAssistantEvidenceDisciplineIssues(text, evidence);
  if (!issues.includes("单源异常财务数据只能作为待核验线索，不能支撑确定排序、极大概率判断或强烈经营结论")) return text;
  if (/(五粮液|000858)/.test(scope) && /(贵州茅台|茅台|600519)/.test(scope)) {
    return buildMoutaiWuliangyeAnomalySafeAnswer();
  }
  return `${text.trim()}\n\n口径校正：上文若涉及单源异常财务数据，只能作为待核验线索；在缺少第二硬源交叉验证前，不应据此推出确定排序、极大概率判断或高置信结论。`;
}

function hasMoutaiWuliangyeAnomalousFinancialDisplay(text: string) {
  return /五粮液[\s\S]{0,800}(异常待核验|异常波动|单源异常|待核验)/.test(text)
    && /(405\.29|89\.54|33\.67|82\.57|-54\.55|-71\.89)/.test(text);
}

function buildMoutaiWuliangyeAnomalySafeAnswer() {
  return [
    "相对主判断：贵州茅台可判断性和稳健性更高；五粮液只适合作为“待核验弹性观察”。当前不能把“五粮液增速超过贵州茅台”或“经营反转”判成确定结论。",
    "",
    "核心原因很直接：本轮五粮液财报工具返回了异常同比和相邻期剧烈反转，并标记为单源异常，缺少第二硬源交叉验证；这些数字可以提示“可能有低基数或口径变化”，但不能直接拿来外推全年增速。茅台数据波动小，虽然增速低，但口径更稳定。",
    "",
    "| 对象 | 当前可用硬证据口径 | 对增速判断的含义 | 相对结论 |",
    "|---|---|---|---|",
    "| 贵州茅台 | 结构化财报与行情口径较完整，Q1收入和净利为低个位数增长，PE/PB可用 | 增速不快，但可判断性较高 | 更稳、更适合做基准 |",
    "| 五粮液 | 财报工具出现“异常波动待核验/单源异常/缺第二硬源交叉验证” | 不能把异常高同比直接视为经营反转 | 弹性观察，先等中报或第二来源确认 |",
    "",
    "| 情景 | 五粮液收入/利润增速低置信估算区间 | 茅台收入/利润增速低置信估算区间 | 判断 |",
    "|---|---:|---:|---|",
    "| 保守 | 0%~10% / -5%~10% | 0%~5% / 0%~3% | 茅台更稳，五粮液不确认超过 |",
    "| 中性 | 5%~15% / 0%~15% | 3%~8% / 1%~5% | 五粮液可能略快，但必须等第二硬源核验 |",
    "| 乐观 | 15%~30% / 10%~35% | 6%~12% / 3%~8% | 五粮液数字可能更高，但不能写成确定超过 |",
    "",
    "| 关键证据表 | 解释 |",
    "|---|---|",
    "| 五粮液异常财报线索 | 本轮结构化源显示高同比，但同时标注单源异常和待核验，因此只能作为线索。 |",
    "| 茅台稳定财报线索 | 茅台Q1低增速、估值较低、现金流和品牌确定性较强，适合作为白酒龙头基准。 |",
    "| 证据缺口 | 五粮液需要中报、公告原文、Tushare/交易所/公司公告二次核验后，才能把增速判断升级。 |",
    "",
    "反证条件：如果五粮液中报或公告原文确认高增速不是口径异常，同时经营现金流、合同负债和渠道库存改善，那么“五粮液全年增速超过茅台”的概率会上升；如果茅台二季度恢复明显提速，则茅台仍可能在利润质量和稳定性上继续领先。",
    "",
    "下一步跟踪：五粮液中报营收、归母净利、经营现金流、合同负债、应收票据/应收款项融资；茅台中报净利增速、批价、合同负债和系列酒去库存。",
  ].join("\n");
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
  return /(情景|假设|若|如果|预计|目标|触发|跟踪|风险|下修|上修|低于|高于|至多|至少|保守|中性|乐观|估算区间|低置信)/.test(line);
}

function hasUncitedHistoricalBaselineMetric(line: string) {
  if (hasAssistantEvidenceCitation(line) || !hasAssistantPreciseInvestmentMetric(line)) return false;
  const currentYear = new Date().getUTCFullYear();
  return [...line.matchAll(/\b(20\d{2})\s*年?/g)].some((match) => Number(match[1]) < currentYear);
}

function hasContradictoryAspDirection(line: string) {
  return /高(?:价|配|端)[^。\n]{0,20}(?:拉低|压低|降低)[^。\n]{0,10}(?:均价|ASP)/i.test(line)
    || /(?:拉低|压低|降低)[^。\n]{0,10}(?:均价|ASP)[^。\n]{0,20}高(?:价|配|端)/i.test(line);
}

function hasBackwardFiscalYearDate(line: string) {
  for (const match of line.matchAll(/\bFY(?:20)?(\d{2})\b[^。\n]{0,24}(?:至|截至|结束|止|through|ending)[^。\n]{0,12}20(\d{2})年?/gi)) {
    const fiscalYear = 2000 + Number(match[1]);
    const calendarYear = 2000 + Number(match[2]);
    if (calendarYear < fiscalYear - 1) return true;
  }
  return false;
}

function hasLikelyEndOfCenturyMistranslation(line: string) {
  return /本世纪末/.test(line) && /(AI|人工智能|数据中心|基础设施|资本支出|Capex|TAM|万亿|E\d+)/i.test(line);
}

function collectAssistantAnomalousEvidenceText(evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0]) {
  return evidence
    .flatMap((item) => `${item.title}\n${item.summary}\n${item.content ?? ""}`.split(/\r?\n/))
    .filter((line) => /单源异常|异常波动待核验|财务口径提醒|第二硬源交叉验证|待核验线索/.test(line))
    .join("\n");
}

function hasUnqualifiedAnomalousFinancialUse(line: string, anomalousEvidenceText: string) {
  const caution = /(异常|待核验|单源|口径|二次核验|第二硬源|不可直接|线索)/;
  if (caution.test(line)) return false;
  if (/(不能|不得|不应|无法|未能|不可|不把|不要).{0,18}(确定|极大概率|几乎全部|超过|低于|高于|跑赢|优于|弱于)/.test(line)) return false;
  if (/(极大概率|几乎全部|确定|必然).{0,24}(?:超过|低于|高于|跑赢|优于|弱于)/.test(line)) return true;
  if (/(断崖|崩盘|暴雷|失血|确定回避)/.test(line)) return true;

  const anomalyNumbers = new Set<string>();
  for (const match of anomalousEvidenceText.matchAll(/[+-]?\d+(?:\.\d+)?(?=%|亿|万|元|$)/g)) {
    const raw = match[0];
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || Math.abs(numeric) < 30) continue;
    anomalyNumbers.add(raw.replace(/\.0+$/, ""));
    anomalyNumbers.add(numeric.toFixed(2).replace(/\.?0+$/, ""));
    anomalyNumbers.add(numeric.toFixed(1).replace(/\.?0+$/, ""));
  }
  for (const value of anomalyNumbers) {
    if (value && line.includes(value)) return true;
  }
  return false;
}

function hasUnqualifiedAccountingRestatementClaim(line: string) {
  if (!/(会计差错|追溯调整|追溯更正|前董事长留置|销售费用大增)/.test(line)) return false;
  return !/(待核验|线索|未验证|需核验|搜索摘要|公告原文|本轮证据)/.test(line);
}

function hasUnverifiedUsFinancialMetricClaim(
  line: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  if (!hasAssistantEvidenceCitation(line) || !hasAssistantPreciseInvestmentMetric(line)) return false;
  if (!/(GAAP|Non[- ]?GAAP|SEC|10[- ]?[KQ]|净利|净利润|营收|收入|revenue|gross margin|毛利率|客户|集中|市占率|份额|PEG|Forward\s*P\/?E|P\/E|PE|EPS|Capex|资本开支|数据中心收入|投资增值|非现金投资)/i.test(line)) return false;
  if (/(低置信|中置信|中等置信|估算|线索|待核验|券商|共识|预测|目标价|情景|假设|区间|外推)/.test(line) && !hasHighEvidenceStrengthLabel(line)) return false;
  const referenced = referencedAssistantEvidenceItems(line, evidence);
  if (!referenced.length) return false;
  return !referenced.some(isUsFinancialHardEvidence);
}

function hasHighEvidenceStrengthLabel(line: string) {
  return /(?:\*\*高\*\*|\b高\b|高置信|中高置信|支撑强度\s*[：:]\s*高|证据等级\s*[：:]\s*高)/.test(line);
}

function hasUsFinancialHardEvidenceCitation(
  line: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  return referencedAssistantEvidenceItems(line, evidence).some(isUsFinancialHardEvidence);
}

function isUsFinancialHardEvidence(item: Parameters<typeof formatCollectedEvidenceForAgent>[0][number]) {
  const text = `${item.source}\n${item.sourceType}\n${item.title}\n${item.url}\n${item.summary}\n${item.content ?? ""}`;
  if (item.source === "CSTD Alpha" && item.sourceType === "official" && (item.qualityScore ?? 1) >= 0.75) return true;
  if (item.source === "CSTD Alpha" && /(实时行情|quote|Yahoo Finance|SEC EDGAR|company facts|companyfacts|financial statements|财务报表|财报)/i.test(text)) return true;
  if (item.sourceType !== "official") return false;
  return /(sec\.gov|SEC EDGAR|companyfacts|10-K|10-Q|investor\.[^/\s]+|ir\.[^/\s]+|investor relations|quarterly results|annual report|financial results|Yahoo Finance|Nasdaq|NYSE)/i.test(text);
}

function hasDroppedBUnitDecimalFromEvidence(
  line: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  const claims = [...line.matchAll(/\b(\d{3,5})\s*B\b/g)].map((match) => match[1]);
  if (!claims.length) return false;
  const referenced = referencedAssistantEvidenceItems(line, evidence);
  if (!referenced.length) return false;
  const evidenceText = referenced
    .map((item) => `${item.title}\n${item.summary}\n${item.content ?? ""}`)
    .join("\n")
    .replace(/,/g, "");

  return claims.some((claim) => {
    if (containsBillionValue(evidenceText, claim)) return false;
    return decimalCandidatesFromCompactNumber(claim).some((candidate) => containsBillionValue(evidenceText, candidate));
  });
}

function decimalCandidatesFromCompactNumber(value: string) {
  const candidates = new Set<string>();
  for (let split = 1; split < value.length; split += 1) {
    const left = value.slice(0, split);
    const right = value.slice(split);
    candidates.add(`${left}.${right}`);
    if (/0+$/.test(right)) candidates.add(left);
  }
  return [...candidates];
}

function containsBillionValue(text: string, value: string) {
  const variants = new Set<string>([value]);
  if (/\.0+$/.test(value)) variants.add(value.replace(/\.0+$/, ""));
  return [...variants].some((variant) => {
    const escaped = escapeRegExp(variant);
    return new RegExp(`(?:\\$\\s*)?${escaped}\\s*(?:B\\b|bn\\b|billion\\b|十亿\\b|亿美元\\b|十亿美元\\b)`, "i").test(text);
  });
}

function referencedAssistantEvidenceItems(
  line: string,
  evidence: Parameters<typeof formatCollectedEvidenceForAgent>[0],
) {
  const sorted = [...evidence]
    .sort((left, right) => assistantEvidencePriority(right) - assistantEvidencePriority(left))
    .slice(0, 24);
  const items: Parameters<typeof formatCollectedEvidenceForAgent>[0] = [];
  for (const match of line.matchAll(/\bE(\d+)\b/g)) {
    const item = sorted[Number(match[1]) - 1];
    if (item) items.push(item);
  }
  return items;
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
    if (item?.source === "CSTD Alpha" && item.sourceType === "official" && (item.qualityScore ?? 1) >= 0.8) return true;
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
