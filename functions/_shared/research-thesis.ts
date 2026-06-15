import { jsonrepair } from "jsonrepair";
import type { ResearchWorkbenchItem } from "../../src/shared/research-workbench";
import { buildDeepSeekRequestInit, cacheStableUserContent, withCacheProtocol } from "./deepseek-cache";
import { buildDeepSeekFallbackRoutes, type DeepSeekFallbackEnv, type DeepSeekFallbackRoute } from "./opencode-go";

export type ResearchThesisCitation = {
  id: string;
  title: string;
  sourceType: string;
  summary: string;
  url?: string;
  publishedAt?: string;
};

export type ResearchThesisEvidence = {
  evidenceHash: string;
  asOf: string;
  summary: string;
  citations: ResearchThesisCitation[];
};

export type ResearchThesisDraft = {
  thesisMarkdown: string;
  coreCitations: string[];
  counterEvidence: string[];
};

type ResearchThesisInput = {
  item: ResearchWorkbenchItem;
  evidence: ResearchThesisEvidence;
};

const RESEARCH_THESIS_TIMEOUT_MS = 240_000;

export async function requestResearchThesis(env: DeepSeekFallbackEnv, input: ResearchThesisInput, signal: AbortSignal) {
  const messages = buildResearchThesisMessages(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("research-thesis-timeout"), RESEARCH_THESIS_TIMEOUT_MS);
  signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  let lastError: unknown;
  try {
    for (const route of buildDeepSeekFallbackRoutes(env)) {
      try {
        const response = await fetch(route.url, buildResearchThesisRequest(route, messages, controller.signal));
        if (!response.ok) {
          lastError = new Error(`论点生成失败：${route.model} ${response.status} ${(await response.text()).slice(0, 300)}`);
          continue;
        }
        const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = payload.choices?.[0]?.message?.content;
        if (!content?.trim()) {
          lastError = new Error(`${route.model} 未返回研究论点。`);
          continue;
        }
        return normalizeResearchThesis(JSON.parse(jsonrepair(content)));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("论点生成失败。");
  } finally {
    clearTimeout(timeout);
  }
}

export function buildResearchThesisMessages({ item, evidence }: ResearchThesisInput) {
  return [
    {
      role: "system" as const,
      content: withCacheProtocol(
        [
          "你是 CSTD Alpha 的投资论点编辑器。只基于给定证据，为一个研究对象形成可迭代、可证伪的中文投资论点。",
          "不要复述新闻，不要因品牌知名度补齐事实，不要把搜索线索写成已确认财务事实。",
          "输出必须是 JSON，不要输出 JSON 之外的文字。",
        ].join("\n"),
        "research-thesis",
      ),
    },
    {
      role: "user" as const,
      content: cacheStableUserContent({
        kind: "research-thesis",
        stable: {
          task: "根据研究对象和证据生成版本化投资论点。",
          requirements: [
            "thesisMarkdown 必须依次包含：主判断、核心逻辑、关键催化剂、反证与失效条件、跟踪清单。",
            "主判断必须明确，允许看好、中性观察、谨慎回避或反对，不得只写资料不足。",
            "核心事实必须用 [E1] 形式引用给定证据；不可引用不存在的编号。",
            "证据薄弱时仍给低置信判断，但必须清楚区分事实、推理与关键缺口。",
            "counterEvidence 必须列出至少一条真正可能推翻当前论点的条件。",
            "coreCitations 只返回实际用于核心判断的证据编号，去重后不超过 8 条。",
          ],
          expectedJsonShape: {
            thesisMarkdown: "# 主判断\n...\n\n## 核心逻辑\n...\n\n## 关键催化剂\n...\n\n## 反证与失效条件\n...\n\n## 跟踪清单\n...",
            coreCitations: ["E1", "E2"],
            counterEvidence: ["会推翻当前判断的条件"],
          },
        },
        volatile: {
          researchItem: {
            entityType: item.entityType,
            entityId: item.entityId,
            title: item.title,
            subtitle: item.subtitle,
            stage: item.stage,
          },
          evidence,
        },
      }),
    },
  ];
}

export function buildResearchThesisRequest(
  route: DeepSeekFallbackRoute,
  messages: ReturnType<typeof buildResearchThesisMessages>,
  signal: AbortSignal,
) {
  return buildDeepSeekRequestInit({
    apiKey: route.apiKey,
    signal,
    model: route.model,
    reasoningEffort: "max",
    thinking: { type: "enabled" },
    maxTokens: 5000,
    messages,
  });
}

export function normalizeResearchThesis(value: unknown): ResearchThesisDraft {
  const record = isRecord(value) ? value : {};
  const thesisMarkdown = stringValue(record.thesisMarkdown);
  const coreCitations = uniqueStrings(record.coreCitations).filter((item) => /^E\d+$/i.test(item)).slice(0, 8);
  const counterEvidence = uniqueStrings(record.counterEvidence).slice(0, 8);
  if (!thesisMarkdown) throw new Error("论点生成结果缺少正文。");
  if (!/#\s*主判断|##\s*主判断/.test(thesisMarkdown)) throw new Error("论点生成结果缺少主判断。");
  if (!counterEvidence.length) throw new Error("论点生成结果缺少反证条件。");
  return { thesisMarkdown, coreCitations, counterEvidence };
}

function uniqueStrings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(stringValue).filter(Boolean))];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
