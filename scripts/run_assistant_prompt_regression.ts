import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ASSISTANT_QUALITY_PROMPTS, ASSISTANT_REGRESSION_100_PROMPTS, isUnsatisfactoryEvidenceOnlyAnswer, type AssistantQualityPrompt } from "../functions/_shared/assistant-quality";
import { classifyAssistantDeepResearch } from "../functions/_shared/assistant-deep-research";
import { buildAssistantTaskContract, validateAssistantTaskAnswer } from "../functions/_shared/assistant-task-contract";

type RunResult = {
  id: string;
  category: string;
  mode: string;
  prompt: string;
  ok: boolean;
  elapsedMs: number;
  answerLength: number;
  gotClarification: boolean;
  gotMemoryCandidate: boolean;
  deepJobStatus?: string;
  usage?: unknown;
  issues: string[];
  answerPreview: string;
  answer: string;
  attempt?: number;
};

const args = parseArgs(process.argv.slice(2));
const isCliRun = process.argv[1]?.replaceAll("\\", "/").endsWith("run_assistant_prompt_regression.ts") ?? false;
const baseUrl = args["base-url"] || "https://alpha.custard.top";
let cookie = args.cookie || process.env.ASSISTANT_REGRESSION_COOKIE || "";
const suite = args.suite || "default";
const promptFile = args["prompt-file"] || "";
const accessFile = args["access-file"] || process.env.CSTD_ALPHA_ACCESS || "E:\\DEV\\codex-tools\\cstd-alpha-access.txt";
const promptsPerCategory = Number(args["prompts-per-category"] || (promptFile ? 0 : suite === "100" ? 5 : 1));
const limit = Number(args.limit || 0);
const onlyCategory = args.category;
const onlyIds = new Set((args.ids || "").split(",").map((value) => value.trim()).filter(Boolean));
const delayMs = Number(args["delay-ms"] || 600);
const perPromptTimeoutMs = Number(args["timeout-ms"] || 900_000);
const retryCount = Number(args.retries || 2);
const retryDelayMs = Number(args["retry-delay-ms"] || 20_000);
const stopOnFail = args["stop-on-fail"] === "true";

if (isCliRun) await main();

async function main() {
  if (!cookie) {
    cookie = await loginAndReadCookie();
  }

  const selectedPrompts = selectPrompts(await loadPromptSource());
  assertSelectedPrompts(selectedPrompts);
  const results: RunResult[] = [];
  await mkdir(".tmp", { recursive: true });
  const outputPath = `.tmp/assistant-regression-${new Date().toISOString().replaceAll(":", "-")}.json`;

  for (const prompt of selectedPrompts) {
    const result = await runPrompt(prompt);
    results.push(result);
    const status = result.ok ? "PASS" : "FAIL";
    console.log(`${status} ${prompt.category}/${prompt.id} ${result.elapsedMs}ms issues=${result.issues.join(";") || "-"}`);
    await writeRegressionOutput(outputPath, selectedPrompts, results);
    if (!result.ok && stopOnFail) break;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  await writeRegressionOutput(outputPath, selectedPrompts, results);

  const failed = results.filter((result) => !result.ok);
  console.log(`\nAssistant regression: ${results.length - failed.length}/${results.length} passed. Output: ${outputPath}`);
  if (failed.length) {
    console.log("Failures:");
    for (const item of failed) {
      console.log(`- ${item.category}/${item.id}: ${item.issues.join("; ")} | ${item.answerPreview}`);
    }
    process.exitCode = 1;
  }
}

async function writeRegressionOutput(outputPath: string, selectedPrompts: AssistantQualityPrompt[], results: RunResult[]) {
  const failed = results.filter((result) => !result.ok);
  await writeFile(outputPath, JSON.stringify({
    baseUrl,
    prompts: selectedPrompts.length,
    completed: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  }, null, 2), "utf8");
}

function selectPrompts(prompts: AssistantQualityPrompt[]) {
  let candidates = prompts;
  if (onlyIds.size) candidates = candidates.filter((prompt) => onlyIds.has(prompt.id));
  if (onlyCategory) candidates = candidates.filter((prompt) => prompt.category === onlyCategory);
  const byCategory = new Map<string, AssistantQualityPrompt[]>();
  for (const prompt of candidates) {
    const list = byCategory.get(prompt.category) ?? [];
    list.push(prompt);
    byCategory.set(prompt.category, list);
  }
  const selected = promptsPerCategory > 0
    ? Array.from(byCategory.values()).flatMap((list) => list.slice(0, promptsPerCategory))
    : candidates;
  return limit > 0 ? selected.slice(0, limit) : selected;
}

function assertSelectedPrompts(prompts: AssistantQualityPrompt[]) {
  if (prompts.length) return;
  const filters = [
    onlyIds.size ? `ids=${Array.from(onlyIds).join(",")}` : "",
    onlyCategory ? `category=${onlyCategory}` : "",
    promptFile ? `prompt-file=${promptFile}` : "",
  ].filter(Boolean).join(" ");
  throw new Error(`No assistant regression prompts matched${filters ? `: ${filters}` : ""}`);
}

async function runPrompt(prompt: AssistantQualityPrompt): Promise<RunResult> {
  let last: RunResult | undefined;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const result = await runPromptOnce(prompt, attempt);
    if (!shouldRetryPromptResult(result) || attempt === retryCount) return result;
    last = result;
    const waitMs = retryDelayMs * (attempt + 1);
    console.log(`RETRY ${prompt.category}/${prompt.id} after ${waitMs}ms because ${result.issues.join(";")}`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return last ?? runPromptOnce(prompt, 0);
}

async function runPromptOnce(prompt: AssistantQualityPrompt, attempt: number): Promise<RunResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`timeout ${perPromptTimeoutMs}ms`), perPromptTimeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/assistant/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ message: prompt.prompt, mode: prompt.mode }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = parseAssistantSse(raw);
    if (parsed.deepJob?.id) {
      const job = await pollDeepResearchJob(parsed.deepJob.id);
      const finalAnswer = await latestAssistantContent(job?.resultMessageId);
      parsed = { ...parsed, answer: finalAnswer || parsed.answer, deepJobStatus: job?.status };
    }
    const elapsedMs = Date.now() - startedAt;
    const issues = evaluatePromptResult(prompt, response.status, parsed);
    return {
      id: prompt.id,
      category: prompt.category,
      mode: prompt.mode,
      prompt: prompt.prompt,
      ok: issues.length === 0,
      elapsedMs,
      answerLength: parsed.answer.length,
      gotClarification: parsed.gotClarification,
      gotMemoryCandidate: parsed.gotMemoryCandidate,
      deepJobStatus: parsed.deepJobStatus,
      usage: parsed.usage,
      issues,
      answerPreview: compactPreview(parsed.answer || raw),
      answer: parsed.answer || raw,
      attempt,
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    return {
      id: prompt.id,
      category: prompt.category,
      mode: prompt.mode,
      prompt: prompt.prompt,
      ok: false,
      elapsedMs,
      answerLength: 0,
      gotClarification: false,
      gotMemoryCandidate: false,
      issues: [error instanceof Error ? error.message : String(error)],
      answerPreview: "",
      answer: "",
      attempt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function loginAndReadCookie() {
  const accessText = await readFile(accessFile, "utf8");
  const passwordLine = accessText.split(/\r?\n/).find((line) => /^\s*REPORT_PASSWORD\s*[:=]/.test(line));
  if (!passwordLine) throw new Error(`Missing cookie and REPORT_PASSWORD not found in ${accessFile}`);
  const password = passwordLine.replace(/^\s*REPORT_PASSWORD\s*[:=]\s*/, "").trim();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  if (!response.ok) throw new Error(`login failed ${response.status}: ${await response.text()}`);
  const setCookie = response.headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
  const sessionCookie = setCookie.map((item) => item.split(";")[0]).filter(Boolean).join("; ");
  if (!sessionCookie) throw new Error("login did not return a session cookie");
  return sessionCookie;
}

async function readPromptFile(path: string) {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const prompts = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.prompts) ? raw.prompts : [];
  return prompts.map((item, index) => normalizePromptFileItem(item, index));
}

function normalizePromptFileItem(item: unknown, index: number): AssistantQualityPrompt {
  if (!isObject(item) || typeof item.prompt !== "string") throw new Error(`Invalid prompt file item at index ${index}`);
  const category = typeof item.category === "string" ? item.category : "tooling";
  const mode = item.mode === "target" || item.mode === "industry" ? item.mode : "chat";
  return {
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `prompt-${index + 1}`,
    category: category as AssistantQualityPrompt["category"],
    mode,
    prompt: item.prompt.trim(),
    mustUseEvidence: Boolean(item.mustUseEvidence),
    shouldClarify: Boolean(item.shouldClarify),
  };
}

function shouldRetryPromptResult(result: RunResult) {
  return result.issues.some((issue) => /^http (500|502|503|504|520|522|524)/.test(issue) || issue.includes("timeout") || issue.includes("network") || issue.includes("fetch failed"));
}

function parseAssistantSse(raw: string) {
  let answer = "";
  let gotClarification = false;
  let gotMemoryCandidate = false;
  let usage: unknown;
  let error = "";
  let deepJob: { id?: string; status?: string } | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const event = JSON.parse(payload) as { type?: string; text?: string; usage?: unknown; error?: string; job?: { id?: string; status?: string } };
      if (event.type === "delta" && typeof event.text === "string") answer += event.text;
      if (event.type === "replace" && typeof event.text === "string") answer = event.text;
      if (event.type === "choice_request") gotClarification = true;
      if (event.type === "memory_candidate") gotMemoryCandidate = true;
      if (event.type === "deep_research_job") deepJob = event.job;
      if (event.type === "usage") usage = event.usage;
      if (event.type === "error") error = event.error || "assistant error event";
    } catch {
      error = "invalid SSE JSON";
    }
  }
  return { answer: answer.trim(), gotClarification, gotMemoryCandidate, usage, error, deepJob, deepJobStatus: deepJob?.status };
}

async function pollDeepResearchJob(id: string) {
  const startedAt = Date.now();
  let latest: { status?: string; resultMessageId?: string } | undefined;
  while (Date.now() - startedAt < perPromptTimeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/assistant/deep-research/${encodeURIComponent(id)}`, {
      headers: { cookie, "cache-control": "no-store" },
    });
    if (!response.ok) throw new Error(`deep research poll failed ${response.status}: ${await response.text()}`);
    const data = await response.json() as { job?: { status?: string; resultMessageId?: string } };
    latest = data.job;
    if (latest?.status === "completed") {
      if (!latest.resultMessageId) throw new Error(`deep research completed without result message ${id}`);
      return latest;
    }
    if (latest?.status === "failed") throw new Error(`deep research failed ${id}`);
  }
  throw new Error(`deep research timeout ${id}; latest=${JSON.stringify(latest)}`);
}

async function latestAssistantContent(resultMessageId?: string) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/assistant/thread`, {
    headers: { cookie, "cache-control": "no-store" },
  });
  if (!response.ok) throw new Error(`thread read failed ${response.status}: ${await response.text()}`);
  const data = await response.json() as { thread?: { messages?: Array<{ id?: string; role?: string; content?: string }> } };
  const messages = data.thread?.messages ?? [];
  const latest = resultMessageId
    ? messages.find((message) => message.id === resultMessageId && message.role === "assistant" && message.content)
    : [...messages].reverse().find((message) => message.role === "assistant" && message.content);
  return latest?.content?.trim() ?? "";
}

function evaluatePromptResult(
  prompt: AssistantQualityPrompt,
  status: number,
  parsed: { answer: string; gotClarification: boolean; gotMemoryCandidate: boolean; error: string; deepJobStatus?: string },
) {
  const issues: string[] = [];
  if (status < 200 || status >= 300) issues.push(`http ${status}`);
  if (parsed.error) issues.push(parsed.error);
  if (prompt.shouldClarify) {
    if (!parsed.gotClarification) issues.push("expected clarification");
    return issues;
  }
  if (parsed.gotClarification) issues.push("unexpected clarification");
  if (prompt.category === "memory") {
    if (!parsed.gotMemoryCandidate) issues.push("expected memory candidate");
    return issues;
  }
  if (parsed.deepJobStatus && parsed.deepJobStatus !== "completed") issues.push(`deep research not completed: ${parsed.deepJobStatus}`);
  if (parsed.answer.length < 160) issues.push("answer too short");
  if (isUnsatisfactoryEvidenceOnlyAnswer(parsed.answer)) issues.push("evidence-only refusal");
  if (/^结构化表格\s*\d*$/im.test(parsed.answer)) issues.push("generic table label leaked");
  if (hasSystemLeak(parsed.answer)) issues.push("system or tool instruction leaked");
  if (hasEmptyMarkdownHeadingLeak(parsed.answer)) issues.push("empty markdown heading leaked");
  if (hasChattyAnswerPreamble(parsed.answer)) issues.push("chatty acknowledgement leaked");
  if (hasUnsupportedPhotovoltaicSubsectorClaim(prompt.prompt, parsed.answer)) issues.push("unsupported photovoltaic subsector claim");
  if (hasUnqualifiedRoboticsMarketingClaim(prompt.prompt, parsed.answer)) issues.push("unqualified robotics marketing claim");
  if (prompt.mustUseEvidence && !hasConcreteEvidence(parsed.answer)) issues.push("missing concrete evidence");
  if (hasUnqualifiedKnownAStockAnomaly(prompt.prompt, parsed.answer)) issues.push("unqualified abnormal A-share financial data");
  if (prompt.category === "chart" && !/\|[^\n]+\|[^\n]+\|\n\|[\s:-]+\|/.test(parsed.answer)) issues.push("missing usable table");
  if (isCompanyFieldTablePrompt(prompt.prompt)) {
    if (!/\|[^\n]+\|[^\n]+\|\n\|[\s:-]+\|/.test(parsed.answer)) issues.push("missing company field table");
    if (/待核验|未确认|待确认|待核实|未核实|公开文件未单列|公开披露未细分|缺数据|未获取|未取得|缺乏|无法确认|N\/A|待发|待财报更新|未单独披露|需以官方公告为准|以官方公告为准|待官方验证|待官方公告|待交叉验证|未经其他来源交叉确认|精确份额需|无独立公开|本次搜索摘要未直接列出|本轮搜索未包含|请参阅|待公司发布|价格日期不明|非实时|需参考/.test(parsed.answer)) issues.push("vague company field placeholder");
    if (countMarkdownTableColumns(parsed.answer) < 12) issues.push("company field table too narrow");
    if (/(^|\n)\s*(?:#{1,6}\s*)?(?:结论|主判断|核心判断|证据等级|反证|我可能错|下一步|后续跟踪|追踪|跟踪指标)[：:]/.test(parsed.answer)) {
      issues.push("company field table has research tail");
    }
    return issues;
  }
  issues.push(...evaluateExplicitCountRequirement(prompt.prompt, parsed.answer));
  issues.push(...evaluateTaskContract(prompt, parsed.answer));
  if (prompt.category === "compare") {
    const compareIssues = evaluateCompareAnswer(prompt.prompt, parsed.answer);
    issues.push(...compareIssues);
  }
  if (prompt.category === "forecast") {
    issues.push(...evaluateForecastAnswer(prompt.prompt, parsed.answer));
  }
  if (prompt.mode !== "chat" || prompt.mustUseEvidence) {
    if (!/(结论|主判断|相对主判断|推荐口径)/.test(parsed.answer)) issues.push("missing conclusion");
    if (!/(反证|我可能错|风险|削弱)/.test(parsed.answer)) issues.push("missing counter-evidence");
    if (!/(跟踪|下一步|验证|关注)/.test(parsed.answer)) issues.push("missing follow-up");
  }
  if (/(无法|不能|不宜)(给出|判断|预测|回答|下结论)/.test(parsed.answer.replace(/\s+/g, "")) && !/(情景|区间|假设|测算|框架|反证|跟踪)/.test(parsed.answer)) {
    issues.push("unhelpful cannot-answer");
  }
  return issues;
}

function evaluateTaskContract(prompt: AssistantQualityPrompt, answer: string) {
  const kind = classifyAssistantDeepResearch(prompt.prompt, prompt.mode);
  if (!kind) return [];
  const validation = validateAssistantTaskAnswer(answer, buildAssistantTaskContract(kind, prompt.prompt));
  return validation.missing.map((item) => `contract missing: ${item}`);
}

function hasConcreteEvidence(answer: string) {
  if (/(?:^|\s)E\d+(?:\s|[：:、,，).）])/i.test(answer)) return true;
  if (/\|[^\n]*(证据|来源|财报|公告|行情|价格|现金流|营收|净利润|PE|PB|TTM)[^\n]*\|/i.test(answer)) return true;
  if (/(财报|公告|行情|价格|批价|合同负债|现金流|营收|净利润|毛利率|PE|PB|TTM|市值|股价)[^\n。；;]{0,30}\d+(?:\.\d+)?\s*(?:%|亿元|亿|元|港元|美元|x|倍)?/i.test(answer)) return true;
  return false;
}

function hasSystemLeak(answer: string) {
  return /(系统补全|developer message|system prompt|assistant-rational-review|cache protocol|JSON schema|工具调用协议|你是 CSTD Alpha|当前应输出低置信判断，而不是停止回答)/i.test(answer);
}

function hasUnqualifiedKnownAStockAnomaly(promptText: string, answer: string) {
  const scope = `${promptText}\n${answer}`;
  if (!/(五粮液|000858)/.test(scope)) return false;
  const suspicious = /(405\.29|89\.54|228\.38|80\.63|82\.57|33\.67|-54\.55|-71\.89|会计差错|追溯调整|前董事长留置|销售费用大增)/;
  if (!suspicious.test(answer)) return false;
  return !/(异常波动待核验|异常波动需原始公告复核|异常需原始公告复核|异常波动按原始公告口径|异常同比按原始公告口径|异常按原始公告口径|单源口径|单源异常|第二硬源|二次核验|不可直接|待核验线索|需原始公告复核线索|原始公告口径线索)/.test(answer);
}

function isCompanyFieldTablePrompt(promptText: string) {
  const normalized = promptText.replace(/\s+/g, "");
  return (
    /表头.*公司.*主分类.*细分位置.*AI弹性标签.*主要市场.*主营业务.*市占率.*成立日期.*上市日期/.test(normalized) ||
    /查询.*主要市场.*主营业务.*市占率.*成立日期.*上市日期.*当前市值/.test(normalized)
  );
}

function countMarkdownTableColumns(answer: string) {
  const header = answer.split(/\r?\n/).find((line) => line.includes("|") && !/^[-|\s:]+$/.test(line.trim()));
  if (!header) return 0;
  return header
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .filter((cell) => cell.trim())
    .length;
}

function evaluateExplicitCountRequirement(promptText: string, answer: string) {
  const issues: string[] = [];
  const countMatches = [...promptText.matchAll(/(\d+|[一二两三四五六七八九十]+)\s*(?:条|个(?!月)|只|支|家|列|项)/g)]
    .map((match) => parseChineseCount(match[1]))
    .filter((value): value is number => Boolean(value && value >= 2 && value <= 20));
  if (!countMatches.length) return issues;
  const required = Math.max(...countMatches);
  if (countAnswerItems(answer) < required) issues.push(`explicit count not satisfied: expected at least ${required}`);
  return issues;
}

function parseChineseCount(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (map[value]) return map[value];
  if (value.startsWith("十")) return 10 + (map[value.slice(1)] ?? 0);
  if (value.endsWith("十")) return (map[value.slice(0, -1)] ?? 1) * 10;
  return 0;
}

function countAnswerItems(answer: string) {
  const listRows = answer.split("\n").filter((line) =>
    /^\s*(?:\d+[.、)]|[-*]\s+|\|\s*\d+\s*\|)/.test(line)
    || (/^\s*\|\s*[^|]+\s*\|\s*[^|]+\s*\|/.test(line) && !/^\s*\|\s*[-: ]+\|/.test(line)),
  );
  return listRows.length;
}

function evaluateCompareAnswer(promptText: string, answer: string) {
  const issues: string[] = [];
  const subjects = expectedCompareSubjects(promptText);
  for (const subject of subjects) {
    if (!subject.aliases.some((alias) => answer.includes(alias))) issues.push(`missing compared subject: ${subject.name}`);
  }
  if (subjects.length >= 2 && !/(\|[^\n]+\|[^\n]+\|\n\|[\s:-]+\||相比|更稳|更强|更弱|优于|弱于|差异|分别|两者|谁更|相对)/.test(answer)) {
    issues.push("missing comparison structure");
  }
  const conclusionLine = answer.split(/\n/).find((line) => /结论/.test(line)) ?? "";
  if (subjects.length >= 2 && /(持有|买入|卖出|加仓|减仓)/.test(conclusionLine) && !/(相比|更稳|更强|更弱|优于|弱于|两者|相对)/.test(conclusionLine)) {
    issues.push("single-stock action verdict in comparison");
  }
  return issues;
}

async function loadPromptSource() {
  if (promptFile) return readPromptFile(promptFile);
  if (suite === "100" || suite === "generated-100") {
    try {
      return await readPromptFile("scripts/assistant-generated-100-prompts.json");
    } catch {
      return ASSISTANT_REGRESSION_100_PROMPTS;
    }
  }
  return ASSISTANT_QUALITY_PROMPTS;
}

function evaluateForecastAnswer(promptText: string, answer: string) {
  return validateAssistantTaskAnswer(answer, buildAssistantTaskContract("forecast", promptText)).missing;
}

function expectedCompareSubjects(promptText: string) {
  const known = [
    { name: "贵州茅台", aliases: ["贵州茅台", "茅台"] },
    { name: "五粮液", aliases: ["五粮液"] },
    { name: "宁德时代", aliases: ["宁德时代"] },
    { name: "比亚迪", aliases: ["比亚迪"] },
    { name: "CXO", aliases: ["CXO"] },
    { name: "创新药", aliases: ["创新药"] },
    { name: "航运", aliases: ["航运"] },
    { name: "航空", aliases: ["航空"] },
    { name: "AI硬件", aliases: ["AI硬件", "硬件"] },
    { name: "AI应用", aliases: ["AI应用", "应用"] },
    { name: "电网设备", aliases: ["电网设备", "电网"] },
    { name: "储能", aliases: ["储能"] },
    { name: "铜", aliases: ["铜"] },
    { name: "铝", aliases: ["铝"] },
    { name: "港股AI", aliases: ["港股AI", "港股"] },
    { name: "美股AI", aliases: ["美股AI", "美股"] },
    { name: "银行", aliases: ["银行"] },
    { name: "地产链", aliases: ["地产链", "地产"] },
    { name: "内需消费", aliases: ["内需消费", "消费"] },
    { name: "出口链", aliases: ["出口链", "出口"] },
  ];
  return known.filter((item) => item.aliases.some((alias) => promptText.includes(alias)));
}

function compactPreview(value: string) {
  return value.replace(/\s+/g, " ").slice(0, 220);
}

function hasEmptyMarkdownHeadingLeak(answer: string) {
  const lines = answer.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^#{1,6}\s*(结论|主判断|核心理由|反驳用户观点|我可能错在哪里|下一步跟踪|证据等级|关键证据表|反证条件|结构化表格\s*\d*)\s*$/i.test(line.trim())) continue;
    const next = lines.slice(index + 1).find((item) => item.trim());
    if (!next || /^#{1,6}\s+/.test(next.trim()) || /^-{3,}$/.test(next.trim())) return true;
  }
  return false;
}

function hasChattyAnswerPreamble(answer: string) {
  return /^好的[，,。]?\s*(?:admin[，,。]?\s*)?(?:收到|明白|我来|你的问题|收到你的问题|以下是)/i.test(answer.trim());
}

function hasUnsupportedPhotovoltaicSubsectorClaim(promptText: string, answer: string) {
  if (!/光伏/.test(promptText)) return false;
  if (/逆变器(?:环节)?[：:]\s*(?:\*{0,2})?看好/.test(answer) && !/(阳光电源|德业股份|固德威|锦浪科技|禾迈股份).{0,80}(财报|公告|订单|出货|销量|营收|净利润|毛利率|经营现金流|价格)/.test(answer)) {
    return true;
  }
  return /(太空数据中心|轨道级市场|万亿级市场)/.test(answer) && !/(远期|待核验|线索)/.test(answer);
}

function hasUnqualifiedRoboticsMarketingClaim(promptText: string, answer: string) {
  const scope = `${promptText}\n${answer}`;
  if (!/(优必选|人形机器人|机器人|宇树|UBTECH|Unitree)/i.test(scope)) return false;
  const normalized = answer.replace(/\s+/g, "");
  const needsQualification = /(待核验|第三方|benchmark|复核|公司公开|公司披露|公开资料|媒体线索|非上市公司|审计财报|统一口径|口径核验|官方披露|官方公告|公司公告|待公告|待官方)/;
  if (/Thinker.{0,20}(九项|9项).{0,20}全球第一/i.test(normalized) && !needsQualification.test(answer)) return true;
  if (/全球唯一.{0,30}(千台|1000台).{0,30}(交付|人形机器人)/.test(normalized) && !needsQualification.test(answer)) return true;
  if (/宇树.{0,20}2025.{0,20}(盈利|利润).{0,10}6亿/.test(normalized) && !needsQualification.test(answer)) return true;
  if (/宇树.{0,24}2025.{0,24}(已实现.{0,8}盈利|实现盈利|盈利|利润|IPO)/.test(normalized) && !needsQualification.test(answer)) return true;
  return false;
}

function parseArgs(values: string[]) {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = "true";
    }
  }
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

export const __test__ = {
  evaluateCompareAnswer,
  evaluateForecastAnswer,
  evaluateExplicitCountRequirement,
  hasConcreteEvidence,
  hasEmptyMarkdownHeadingLeak,
  hasUnqualifiedKnownAStockAnomaly,
  hasChattyAnswerPreamble,
  hasUnsupportedPhotovoltaicSubsectorClaim,
  hasUnqualifiedRoboticsMarketingClaim,
  assertSelectedPrompts,
};
