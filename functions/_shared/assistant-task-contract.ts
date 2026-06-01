import type { AssistantDeepResearchKind } from "../../src/shared/assistant";

export type AssistantTaskContract = {
  kind: AssistantDeepResearchKind;
  query: string;
  requestedMarkets: Array<"A股" | "港股" | "美股">;
  requestedCounts: Partial<Record<"A股" | "港股" | "美股", number>>;
  requestedTotalCount?: number;
  comparedSubjects: string[];
  needsDirectRecommendations: boolean;
  needsCurrentPrice: boolean;
  needsForecastRange: boolean;
};

export type AssistantTaskValidation = {
  valid: boolean;
  missing: string[];
};

const MARKET_PATTERNS: Array<{ market: "A股" | "港股" | "美股"; pattern: RegExp }> = [
  { market: "A股", pattern: /A\s*股/i },
  { market: "港股", pattern: /港\s*股/i },
  { market: "美股", pattern: /美\s*股/i },
];

const CHINESE_COUNTS: Record<string, number> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

export function buildAssistantTaskContract(kind: AssistantDeepResearchKind, query: string): AssistantTaskContract {
  const requestedMarkets = MARKET_PATTERNS.filter(({ pattern }) => pattern.test(query)).map(({ market }) => market);
  const requestedCounts = Object.fromEntries(
    requestedMarkets
      .map((market) => [market, extractMarketCount(query, market)] as const)
      .filter((entry): entry is readonly ["A股" | "港股" | "美股", number] => Boolean(entry[1])),
  );
  return {
    kind,
    query,
    requestedMarkets,
    requestedCounts,
    ...(kind === "selection" ? { requestedTotalCount: extractTotalRecommendationCount(query) } : {}),
    comparedSubjects: kind === "comparison" ? extractComparedSubjects(query) : [],
    needsDirectRecommendations: kind === "selection",
    needsCurrentPrice: /(当前|现在|现时|实时|最新).{0,5}(股价|价格)|股价.{0,5}(多少|是多少|现价)/.test(query),
    needsForecastRange: kind === "forecast",
  };
}

export function validateAssistantTaskAnswer(text: string, contract: AssistantTaskContract): AssistantTaskValidation {
  const missing: string[] = [];
  if (!text.trim()) return { valid: false, missing: ["回答正文"] };

  if (contract.needsDirectRecommendations) {
    if (!/(推荐口径|筛选口径|推荐结论|排序结论|名单口径)[：:]/.test(text)) missing.push("推荐口径");
    if (contract.requestedMarkets.length) {
      for (const market of contract.requestedMarkets) {
        const required = contract.requestedCounts[market] ?? 1;
        if (countMarketRecommendations(text, market) < required) missing.push(`${market}推荐名单至少 ${required} 家`);
      }
    } else {
      const required = contract.requestedTotalCount ?? 1;
      if (countAllRecommendations(text) < required) missing.push(`推荐名单至少 ${required} 家`);
    }
  } else if (!/(主判断|结论)[：:]\s*(?:\*{1,2})?\s*(看好|中性观察|谨慎回避|反对)/.test(text)) {
    missing.push("四档主判断");
  }

  if (contract.needsForecastRange && !/(区间|保守|中性|乐观|情景|场景)/.test(text)) missing.push("预测区间或情景");
  if (contract.needsCurrentPrice && !hasCurrentPriceValue(text)) missing.push("当前股价口径和数值");
  for (const subject of contract.comparedSubjects) {
    if (!text.includes(subject)) missing.push(`覆盖对比对象：${subject}`);
  }
  if (contract.kind === "comparison" && !/(排序|排名|优先级|更稳|更优|优于|胜负|主判断)/.test(text)) missing.push("对比结论");
  if (!/(反证|我可能错在哪里|证伪|主要风险)/.test(text)) missing.push("反证条件");
  if (!/(下一步跟踪|跟踪指标|后续跟踪)/.test(text)) missing.push("下一步跟踪");
  if (!hasEvidenceTable(text)) missing.push("关键证据表");
  return { valid: missing.length === 0, missing };
}

export function formatAssistantTaskContract(contract: AssistantTaskContract) {
  return JSON.stringify({
    kind: contract.kind,
    requestedMarkets: contract.requestedMarkets,
    requestedCounts: contract.requestedCounts,
    requestedTotalCount: contract.requestedTotalCount,
    comparedSubjects: contract.comparedSubjects,
    needsDirectRecommendations: contract.needsDirectRecommendations,
    needsCurrentPrice: contract.needsCurrentPrice,
    needsForecastRange: contract.needsForecastRange,
  });
}

function extractMarketCount(query: string, market: "A股" | "港股" | "美股") {
  const escaped = market === "A股" ? "A\\s*股" : market === "港股" ? "港\\s*股" : "美\\s*股";
  const before = query.match(new RegExp(`(\\d+|[一二两三四五六七八九十]+)\\s*(?:支|只|家)?\\s*${escaped}`, "i"))?.[1];
  const after = query.match(new RegExp(`${escaped}\\s*(?:Top\\s*)?(\\d+|[一二两三四五六七八九十]+)`, "i"))?.[1];
  return parseCount(before ?? after);
}

function extractTotalRecommendationCount(query: string) {
  const explicit = query.match(/(?:推荐|给我|列出|选出)\s*(\d+|[一二两三四五六七八九十]+)\s*(?:支|只|家|个)/)?.[1];
  return parseCount(explicit);
}

function parseCount(value: string | undefined) {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(50, Math.max(1, Number(value)));
  if (CHINESE_COUNTS[value]) return CHINESE_COUNTS[value];
  if (value.startsWith("十")) return 10 + (CHINESE_COUNTS[value.slice(1)] ?? 0);
  if (value.endsWith("十")) return (CHINESE_COUNTS[value.slice(0, -1)] ?? 1) * 10;
  return undefined;
}

function countMarketRecommendations(text: string, market: "A股" | "港股" | "美股") {
  const marketPattern = market === "A股" ? "A\\s*股" : market === "港股" ? "港\\s*股" : "美\\s*股";
  const header = new RegExp(`(?:^|\\n)\\s*(?:#{1,4}\\s*)?(?:\\*{1,2})?${marketPattern}\\s*(?:Top\\s*\\d+|\\d+\\s*支|推荐|名单|清单|按推荐序|排序)`, "i");
  const match = header.exec(text);
  if (!match) return 0;
  const start = match.index + match[0].length;
  const remaining = text.slice(start);
  const nextHeader = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*{1,2})?(?:A\s*股|港\s*股|美\s*股)\s*(?:Top\s*\d+|\d+\s*支|推荐|名单|清单|按推荐序|排序)/i.exec(remaining);
  return countAllRecommendations(nextHeader ? remaining.slice(0, nextHeader.index) : remaining);
}

function countAllRecommendations(text: string) {
  const rows = text.split("\n").filter((line) =>
    /^\s*\|\s*\d+\s*\|/.test(line)
    || /^\s*\d+\s*[.、)]\s*\S+/.test(line)
    || /^\s*[-*]\s*\d+\s*[.、)]\s*\S+/.test(line),
  );
  return rows.length;
}

function hasCurrentPriceValue(text: string) {
  return /(?:当前|现在|现时|实时|最新).{0,12}(?:股价|价格|现价).{0,12}(?:为|是|[:：])?\s*(?:人民币|港币|美元|HKD|USD|CNY|¥|\$)?\s*\d+(?:\.\d+)?/i.test(text)
    || /(?:股价|现价).{0,6}(?:人民币|港币|美元|HKD|USD|CNY|¥|\$)\s*\d+(?:\.\d+)?/i.test(text);
}

function hasEvidenceTable(text: string) {
  return /\|[^\n]+\|/.test(text) && /(证据|来源|依据|核心理由|主要风险)/.test(text);
}

function extractComparedSubjects(query: string) {
  const match = query.match(/(?:把|比较|对比)?\s*([^，。？！?\n]{1,24}?)\s*(?:和|与|vs\.?|VS\.?)\s*([^，。？！?\n]{1,24}?)(?:做|进行|谁|哪个|哪家|比较|对比|，|。|？|\?|$)/);
  if (!match) return [];
  return [cleanComparedSubject(match[1]), cleanComparedSubject(match[2])].filter((item) => item.length >= 2);
}

function cleanComparedSubject(value: string) {
  return value.replace(/^(?:把|请|帮我|比较|对比)\s*/, "").replace(/\s*(?:股票|公司|做一个|进行一个)$/, "").trim();
}
