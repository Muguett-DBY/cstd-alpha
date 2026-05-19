import type { RadarCitation, RadarEvidenceType, RadarItem } from "./shared/radar";

export function radarRefreshFallbackMessage(hasExistingRadar: boolean, error: unknown) {
  if (hasExistingRadar) return "本次刷新失败，已保留上次扫描。请稍后重试。";
  return error instanceof Error ? error.message : "雷达扫描失败。";
}

export type RadarChangeBuckets = {
  added: string[];
  upgraded: string[];
  downgraded: string[];
  maintained: string[];
};

export function radarChangeBuckets(changeLog: string[]): RadarChangeBuckets {
  return changeLog.reduce(
    (groups, item) => {
      if (/升级|上调|转强|高置信/.test(item)) groups.upgraded.push(item);
      else if (/未延续|删除|降级|下调|转弱/.test(item)) groups.downgraded.push(item);
      else if (/延续|维持|保留/.test(item)) groups.maintained.push(item);
      else groups.added.push(item);
      return groups;
    },
    { added: [] as string[], upgraded: [] as string[], downgraded: [] as string[], maintained: [] as string[] },
  );
}

export type RadarCardInsights = {
  strengthLabel: string;
  strengthDetail: string;
  evidenceGaps: string[];
  counterSignals: string[];
  changeExplanation: string;
};

export type RadarSourceLibraryFilters = {
  industry?: string;
  evidenceType?: RadarEvidenceType | "all";
};

export type RadarSourceLibraryEntry = {
  source: RadarCitation;
  industries: string[];
  itemTitles: string[];
};

export function buildRadarSourceLibrary(sources: RadarCitation[], items: RadarItem[], filters: RadarSourceLibraryFilters = {}) {
  const contextBySourceId = new Map<string, { industries: Set<string>; itemTitles: Set<string> }>();
  const itemIndustries = uniqueStrings(items.flatMap((item) => item.industries));
  for (const item of items) {
    for (const sourceId of item.sourceIds ?? []) {
      const context = contextBySourceId.get(sourceId) ?? { industries: new Set<string>(), itemTitles: new Set<string>() };
      for (const industry of item.industries) context.industries.add(industry);
      if (item.title) context.itemTitles.add(item.title);
      contextBySourceId.set(sourceId, context);
    }
  }

  const allEntries = sources.map((source) => {
    const context = contextBySourceId.get(source.id);
    const industries = [...(context?.industries ?? new Set<string>())];
    if (!industries.length && source.query && itemIndustries.includes(source.query)) industries.push(source.query);
    return {
      source,
      industries,
      itemTitles: [...(context?.itemTitles ?? new Set<string>())],
    };
  });
  const industry = filters.industry && filters.industry !== "all" ? filters.industry : "";
  const evidenceType = filters.evidenceType && filters.evidenceType !== "all" ? filters.evidenceType : "";
  const entries = allEntries.filter((entry) => (!industry || entry.industries.includes(industry)) && (!evidenceType || entry.source.sourceType === evidenceType));

  return {
    entries,
    industries: uniqueStrings([...itemIndustries, ...sources.map((source) => source.query)]),
    evidenceTypes: uniqueEvidenceTypes(sources.map((source) => source.sourceType)),
  };
}

export function radarCardInsights(item: RadarItem & Record<string, unknown>): RadarCardInsights {
  const sourceCount = item.supportingSourceCount ?? item.sourceIds?.length ?? 0;
  const confidence = item.confidence || "中";
  const evidenceTypes = item.evidenceTypes ?? [];
  const hasPrimaryEvidence = evidenceTypes.some((type) => type === "hard_data" || type === "official" || type === "announcement");
  const strengthLabel = confidence === "高" && sourceCount >= 2 ? "高强度结论" : confidence === "低" || sourceCount <= 1 ? "低强度观察" : "中强度判断";
  const sourceDetail = sourceCount ? `${sourceCount} 条证据` : "证据待确认";
  const strengthDetail = [`${confidence}置信`, item.durability, sourceDetail, evidenceTypes.map(radarEvidenceTypeLabel).join("、")].filter(Boolean).join(" / ");

  const explicitGaps = firstStringArray(item.evidenceGaps, item.evidenceGap, item.evidenceWeaknesses);
  const evidenceGaps = explicitGaps.length ? explicitGaps : inferredEvidenceGaps(sourceCount, confidence, hasPrimaryEvidence);
  const counterSignals = [...firstStringArray(item.counterEvidence, item.counterpoints, item.counterSignals, item.contraryEvidence), ...item.turningPoints].slice(0, 5);

  return {
    strengthLabel,
    strengthDetail,
    evidenceGaps,
    counterSignals: counterSignals.length ? counterSignals : ["暂无明确反证，继续跟踪价格、订单和政策拐点。"],
    changeExplanation: item.changeReason || "本轮未提供单项变化说明。",
  };
}

function inferredEvidenceGaps(sourceCount: number, confidence: NonNullable<RadarItem["confidence"]>, hasPrimaryEvidence: boolean) {
  const gaps: string[] = [];
  if (sourceCount < 3) gaps.push("公开来源不足 3 条，需要补充交叉验证。");
  if (!hasPrimaryEvidence) gaps.push("缺少硬数据、官方/协会或公告/财报交叉验证。");
  if (confidence === "低") gaps.push("模型置信度偏低，暂不宜视为正式产业结论。");
  return gaps.length ? gaps : ["暂无明显证据缺口，继续跟踪后续硬数据和公告验证。"];
}

function firstStringArray(...values: unknown[]) {
  for (const value of values) {
    const result = stringArray(value);
    if (result.length) return result;
  }
  return [];
}

function stringArray(value: unknown) {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function uniqueEvidenceTypes(values: RadarEvidenceType[]) {
  return [...new Set(values)];
}

function radarEvidenceTypeLabel(type: RadarEvidenceType) {
  return {
    hard_data: "硬数据",
    official: "官方/协会",
    announcement: "公告/财报",
    market: "市场数据",
    news: "新闻线索",
    research: "研报摘要",
  }[type];
}
