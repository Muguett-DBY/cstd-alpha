import { jsonrepair } from "jsonrepair";
import { json, requireUserSession } from "../_shared/user-research-db";
import { buildDeepSeekRequestInit, cacheStableUserContent, withCacheProtocol } from "../_shared/deepseek-cache";
import { buildDeepSeekFallbackRoutes, type DeepSeekFallbackRoute } from "../_shared/opencode-go";
import { normalizeTemplateSectionRequirements, type ResearchTemplate } from "../../src/shared/user-research";

type Env = {
  AUTH_SECRET: string;
  OPENCODE_ZEN_API_KEY?: string;
  OPENCODE_GO_API_KEY?: string;
};

type TemplateCompletionDraft = Pick<ResearchTemplate, "title" | "shortTitle" | "focus" | "prompt" | "fullPrompt" | "sectionRequirements">;
type TemplateCompletionRoute = DeepSeekFallbackRoute;

const TEMPLATE_COMPLETION_TIMEOUT_MS = 240_000;
const TEMPLATE_COMPLETION_FULL_PROMPT_MAX_CHARS = 12_000;
const TEMPLATE_COMPLETION_DRAFT_MAX_CHARS = 16_000;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const session = await requireUserSession(request, env);
  if (!session) return json({ error: "Unauthorized." }, 401);
  const body = (await request.json().catch(() => null)) as { draft?: Partial<TemplateCompletionDraft> } | null;
  const draft = normalizeDraftInput(body?.draft);
  if (!draft.fullPrompt.trim()) return json({ error: "请先填写完整模板正文，再进行 AI 补全。" }, 400);
  if (draft.fullPrompt.length > TEMPLATE_COMPLETION_FULL_PROMPT_MAX_CHARS) {
    return json({ error: `模板正文过长，请控制在 ${TEMPLATE_COMPLETION_FULL_PROMPT_MAX_CHARS} 字以内后再补全。` }, 400);
  }
  if (draftTextLength(draft) > TEMPLATE_COMPLETION_DRAFT_MAX_CHARS) {
    return json({ error: `模板草稿过长，请控制在 ${TEMPLATE_COMPLETION_DRAFT_MAX_CHARS} 字以内后再补全。` }, 400);
  }
  const completion = await requestTemplateCompletion(env, draft, request.signal);
  return json({ completion });
};

export async function requestTemplateCompletion(env: Pick<Env, "OPENCODE_ZEN_API_KEY" | "OPENCODE_GO_API_KEY">, draft: TemplateCompletionDraft, signal: AbortSignal) {
  const messages = buildTemplateCompletionMessages(draft);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("template-completion-timeout"), TEMPLATE_COMPLETION_TIMEOUT_MS);
  signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  let lastError: unknown;
  try {
    for (const route of templateCompletionModelRoutes(env)) {
      try {
        const response = await fetch(route.url, buildTemplateCompletionRequest(route, messages, controller.signal));
        if (!response.ok) {
          lastError = new Error(`模板补全失败：${route.model} ${response.status} ${(await response.text()).slice(0, 500)}`);
          continue;
        }
        const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = payload.choices?.[0]?.message?.content;
        if (!content?.trim()) {
          lastError = new Error(`${route.model} 未返回模板补全内容。`);
          continue;
        }
        return normalizeTemplateCompletion(JSON.parse(jsonrepair(content)));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("模板补全失败。");
  } finally {
    clearTimeout(timeout);
  }
}

export function buildTemplateCompletionMessages(draft: TemplateCompletionDraft) {
  return [
    {
      role: "system" as const,
      content: withCacheProtocol(
        "你是严谨的中文投资研究模板设计器。任务是把用户草拟的投资方法论整理成可复用的公司分析模板，不输出公司分析结果，只输出 JSON。",
        "research-template-completion",
      ),
    },
    {
      role: "user" as const,
      content: cacheStableUserContent({
        kind: "research-template-completion",
        stable: {
          task:
            "请基于 volatileContext.rawDraft.fullPrompt 的原始正文，补齐并优化模板标题、短标题、卡片说明、模型提示词、完整模板正文。完整模板正文必须保留用户核心思想，修正错别字和重复表达，整理为清晰 Markdown，最后保留“请按照以上模板分析（      ）公司”这一类公司占位任务。",
          requirements: [
            "title 使用“模板XX：主题”或清晰中文标题。",
            "shortTitle 控制在 2-8 个中文字符，适合卡片显示。",
            "focus 用一到两句话说明这个模板分析什么，不要写操作说明。",
            "prompt 是给模型的短指令，要求基于公开证据、按完整模板输出深度公司分析。",
            "fullPrompt 是优化后的完整 Markdown 模板正文，结构清晰、可执行、避免口语化重复，不能删除用户核心投资思想。",
            "fullPrompt 必须要求后续报告引用证据包中的证据编号或来源类型，区分事实、推理、反证和待复核项。",
            "fullPrompt 必须包含反幻觉约束：缺少财报、公告、价格、销量或现金流证据时，要明确写数据不足，不能用猜测补齐。",
            "必须输出 sectionRequirements：把模板拆成 1-12 个可检查的模板项，每项包含 id、title、minChars、requiredPoints。",
            "sectionRequirements 中每个模板项的 minChars 是该项最少实质内容长度，而不是整篇凑字；requiredPoints 至少包含结论、证据依据、反证条件、跟踪指标。",
            "不要编造公司名称、行情或财务数据。",
          ],
          expectedJsonShape: {
            title: "模板标题",
            shortTitle: "短标题",
            focus: "卡片说明",
            prompt: "模型提示词",
            fullPrompt: "完整模板正文",
            sectionRequirements: [
              {
                id: "stable-lowercase-id",
                title: "模板项标题",
                minChars: 180,
                requiredPoints: ["结论", "证据依据", "反证条件", "跟踪指标"],
              },
            ],
          },
        },
        volatile: { rawDraft: draft },
      }),
    },
  ];
}

export function buildTemplateCompletionRequest(route: TemplateCompletionRoute, messages: ReturnType<typeof buildTemplateCompletionMessages>, signal: AbortSignal): RequestInit {
  return buildDeepSeekRequestInit({
    apiKey: route.apiKey,
    signal,
    model: route.model,
    reasoningEffort: "max",
    thinking: { type: "enabled" },
    maxTokens: 8000,
    messages,
  });
}

export function normalizeTemplateCompletion(value: unknown): TemplateCompletionDraft {
  const record = isRecord(value) ? value : {};
  const completion = {
    title: stringValue(record.title),
    shortTitle: stringValue(record.shortTitle),
    focus: stringValue(record.focus),
    prompt: stringValue(record.prompt),
    fullPrompt: stringValue(record.fullPrompt),
    sectionRequirements: normalizeTemplateSectionRequirements({
      title: stringValue(record.title),
      fullPrompt: stringValue(record.fullPrompt),
      sectionRequirements: Array.isArray(record.sectionRequirements) ? record.sectionRequirements : undefined,
    }),
  };
  const missing = Object.entries(completion)
    .filter(([, item]) => !item)
    .map(([key]) => key);
  if (missing.length) throw new Error(`模板补全结果缺少字段：${missing.join(", ")}。`);
  return completion;
}

function normalizeDraftInput(value: Partial<TemplateCompletionDraft> | undefined): TemplateCompletionDraft {
  const record = isRecord(value) ? value : {};
  return {
    title: stringValue(record.title),
    shortTitle: stringValue(record.shortTitle),
    focus: stringValue(record.focus),
    prompt: stringValue(record.prompt),
    fullPrompt: stringValue(record.fullPrompt),
    sectionRequirements: normalizeTemplateSectionRequirements({
      title: stringValue(record.title),
      fullPrompt: stringValue(record.fullPrompt),
      sectionRequirements: Array.isArray(record.sectionRequirements) ? record.sectionRequirements : undefined,
    }),
  };
}

function templateCompletionModelRoutes(env: Pick<Env, "OPENCODE_ZEN_API_KEY" | "OPENCODE_GO_API_KEY">): TemplateCompletionRoute[] {
  return buildDeepSeekFallbackRoutes(env);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function draftTextLength(draft: TemplateCompletionDraft) {
  return draft.title.length + draft.shortTitle.length + draft.focus.length + draft.prompt.length + draft.fullPrompt.length + sectionRequirementsTextLength(draft.sectionRequirements);
}

function sectionRequirementsTextLength(sectionRequirements: TemplateCompletionDraft["sectionRequirements"]) {
  return (sectionRequirements ?? []).reduce(
    (sum, item) => sum + item.id.length + item.title.length + item.requiredPoints.reduce((pointSum, point) => pointSum + point.length, 0),
    0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
