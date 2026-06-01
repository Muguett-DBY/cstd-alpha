import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ASSISTANT_QUALITY_PROMPTS, ASSISTANT_REGRESSION_100_PROMPTS, isUnsatisfactoryEvidenceOnlyAnswer, type AssistantQualityPrompt } from "../functions/_shared/assistant-quality";
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

  const selectedPrompts = selectPrompts(promptFile ? await readPromptFile(promptFile) : suite === "100" ? ASSISTANT_REGRESSION_100_PROMPTS : ASSISTANT_QUALITY_PROMPTS);
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
      const finalAnswer = await latestAssistantContent();
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
  let latest: { status?: string } | undefined;
  while (Date.now() - startedAt < perPromptTimeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/assistant/deep-research/${encodeURIComponent(id)}`, {
      headers: { cookie, "cache-control": "no-store" },
    });
    if (!response.ok) throw new Error(`deep research poll failed ${response.status}: ${await response.text()}`);
    const data = await response.json() as { job?: { status?: string } };
    latest = data.job;
    if (latest?.status === "completed" || latest?.status === "failed") return latest;
  }
  throw new Error(`deep research timeout ${id}; latest=${JSON.stringify(latest)}`);
}

async function latestAssistantContent() {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/assistant/thread`, {
    headers: { cookie, "cache-control": "no-store" },
  });
  if (!response.ok) throw new Error(`thread read failed ${response.status}: ${await response.text()}`);
  const data = await response.json() as { thread?: { messages?: Array<{ role?: string; content?: string }> } };
  const latest = [...(data.thread?.messages ?? [])].reverse().find((message) => message.role === "assistant" && message.content);
  return latest?.content?.trim() ?? "";
}

function evaluatePromptResult(
  prompt: AssistantQualityPrompt,
  status: number,
  parsed: { answer: string; gotClarification: boolean; gotMemoryCandidate: boolean; error: string },
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
  if (parsed.answer.length < 160) issues.push("answer too short");
  if (isUnsatisfactoryEvidenceOnlyAnswer(parsed.answer)) issues.push("evidence-only refusal");
  if (/^结构化表格\s*\d*$/im.test(parsed.answer)) issues.push("generic table label leaked");
  if (hasEmptyMarkdownHeadingLeak(parsed.answer)) issues.push("empty markdown heading leaked");
  if (prompt.mustUseEvidence && !/(证据|来源|财报|公告|数据|口径|线索|E\d+|反证|跟踪)/.test(parsed.answer)) issues.push("missing evidence language");
  if (prompt.category === "chart" && !/\|[^\n]+\|[^\n]+\|\n\|[\s:-]+\|/.test(parsed.answer)) issues.push("missing usable table");
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
    if (!/^#{1,6}\s*(核心理由|反驳用户观点|我可能错在哪里|下一步跟踪|证据等级)\s*$/i.test(line.trim())) continue;
    const next = lines.slice(index + 1).find((item) => item.trim());
    if (!next || /^#{1,6}\s+/.test(next.trim()) || /^-{3,}$/.test(next.trim())) return true;
  }
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

export const __test__ = { evaluateCompareAnswer, evaluateForecastAnswer, hasEmptyMarkdownHeadingLeak };
