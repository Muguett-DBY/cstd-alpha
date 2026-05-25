import { mkdir, writeFile } from "node:fs/promises";
import { ASSISTANT_QUALITY_PROMPTS, isUnsatisfactoryEvidenceOnlyAnswer, type AssistantQualityPrompt } from "../functions/_shared/assistant-quality";

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
  usage?: unknown;
  issues: string[];
  answerPreview: string;
  answer: string;
  attempt?: number;
};

const args = parseArgs(process.argv.slice(2));
const baseUrl = args["base-url"] || "https://alpha.custard.top";
const cookie = args.cookie || process.env.ASSISTANT_REGRESSION_COOKIE || "";
const promptsPerCategory = Number(args["prompts-per-category"] || 1);
const limit = Number(args.limit || 0);
const onlyCategory = args.category;
const onlyIds = new Set((args.ids || "").split(",").map((value) => value.trim()).filter(Boolean));
const delayMs = Number(args["delay-ms"] || 600);
const perPromptTimeoutMs = Number(args["timeout-ms"] || 90_000);
const retryCount = Number(args.retries || 2);
const retryDelayMs = Number(args["retry-delay-ms"] || 20_000);

if (!cookie) {
  throw new Error("Missing cookie. Pass --cookie \"cstd_alpha_session=...\" or set ASSISTANT_REGRESSION_COOKIE.");
}

const selectedPrompts = selectPrompts(ASSISTANT_QUALITY_PROMPTS);
const results: RunResult[] = [];

for (const prompt of selectedPrompts) {
  const result = await runPrompt(prompt);
  results.push(result);
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`${status} ${prompt.category}/${prompt.id} ${result.elapsedMs}ms issues=${result.issues.join(";") || "-"}`);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

await mkdir(".tmp", { recursive: true });
const outputPath = `.tmp/assistant-regression-${new Date().toISOString().replaceAll(":", "-")}.json`;
await writeFile(outputPath, JSON.stringify({ baseUrl, prompts: selectedPrompts.length, results }, null, 2), "utf8");

const failed = results.filter((result) => !result.ok);
console.log(`\nAssistant regression: ${results.length - failed.length}/${results.length} passed. Output: ${outputPath}`);
if (failed.length) {
  console.log("Failures:");
  for (const item of failed) {
    console.log(`- ${item.category}/${item.id}: ${item.issues.join("; ")} | ${item.answerPreview}`);
  }
  process.exitCode = 1;
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
  const selected = Array.from(byCategory.values()).flatMap((list) => list.slice(0, Math.max(1, promptsPerCategory)));
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
    const parsed = parseAssistantSse(raw);
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

function shouldRetryPromptResult(result: RunResult) {
  return result.issues.some((issue) => issue.startsWith("http 503") || issue.includes("timeout") || issue.includes("network") || issue.includes("fetch failed"));
}

function parseAssistantSse(raw: string) {
  let answer = "";
  let gotClarification = false;
  let gotMemoryCandidate = false;
  let usage: unknown;
  let error = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const event = JSON.parse(payload) as { type?: string; text?: string; usage?: unknown; error?: string };
      if (event.type === "delta" && typeof event.text === "string") answer += event.text;
      if (event.type === "choice_request") gotClarification = true;
      if (event.type === "memory_candidate") gotMemoryCandidate = true;
      if (event.type === "usage") usage = event.usage;
      if (event.type === "error") error = event.error || "assistant error event";
    } catch {
      error = "invalid SSE JSON";
    }
  }
  return { answer: answer.trim(), gotClarification, gotMemoryCandidate, usage, error };
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
  if (/^#{1,6}\s*(核心理由|反驳用户观点|我可能错在哪里|下一步跟踪|证据等级)\s*$/im.test(parsed.answer)) issues.push("empty markdown heading leaked");
  if (prompt.mustUseEvidence && !/(证据|来源|财报|公告|数据|口径|线索|E\d+|反证|跟踪)/.test(parsed.answer)) issues.push("missing evidence language");
  if (prompt.category === "chart" && !/\|[^\n]+\|[^\n]+\|\n\|[\s:-]+\|/.test(parsed.answer)) issues.push("missing usable table");
  if (prompt.mode !== "chat" || prompt.mustUseEvidence) {
    if (!/结论/.test(parsed.answer)) issues.push("missing conclusion");
    if (!/(反证|我可能错|风险|削弱)/.test(parsed.answer)) issues.push("missing counter-evidence");
    if (!/(跟踪|下一步|验证|关注)/.test(parsed.answer)) issues.push("missing follow-up");
  }
  if (/(无法|不能|不宜)(给出|判断|预测|回答|下结论)/.test(parsed.answer.replace(/\s+/g, "")) && !/(情景|区间|假设|测算|框架|反证|跟踪)/.test(parsed.answer)) {
    issues.push("unhelpful cannot-answer");
  }
  return issues;
}

function compactPreview(value: string) {
  return value.replace(/\s+/g, " ").slice(0, 220);
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
