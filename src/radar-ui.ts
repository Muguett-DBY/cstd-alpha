import type { RadarCitation, RadarEvidenceType, RadarIndustryPacket, RadarIndustryStage, RadarItem } from "./shared/radar";

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
  const strengthLabel = confidence === "高" && sourceCount >= 2 ? "高强度结论" : confidence === "低" || sourceCount <= 1 ? "低强度观察" : "中强度判断";
  const sourceDetail = sourceCount ? `${sourceCount} 条证据` : "证据待确认";
  const strengthDetail = [`${confidence}置信`, item.durability, sourceDetail, evidenceTypes.map(radarEvidenceTypeLabel).join("、")].filter(Boolean).join(" / ");

  const explicitGaps = firstStringArray(item.evidenceGaps, item.evidenceGap, item.evidenceWeaknesses);
  const counterSignals = [...firstStringArray(item.counterEvidence, item.counterpoints, item.counterSignals, item.contraryEvidence), ...item.turningPoints].slice(0, 5);

  return {
    strengthLabel,
    strengthDetail,
    evidenceGaps: explicitGaps,
    counterSignals: counterSignals.length ? counterSignals : ["暂无明确反证，继续跟踪价格、订单和政策拐点。"],
    changeExplanation: item.changeReason || "本轮未提供单项变化说明。",
  };
}

export type RadarPacketDisplayFilters = {
  query?: string;
  stage?: RadarIndustryStage | "all" | "";
  expanded?: boolean;
  defaultVisibleCount?: number;
};

export function radarPacketDisplayPlan(packets: RadarIndustryPacket[], filters: RadarPacketDisplayFilters = {}) {
  const normalizedQuery = (filters.query ?? "").trim().toLowerCase();
  const stage = filters.stage && filters.stage !== "all" ? filters.stage : "";
  const allRows = [...packets]
    .filter((packet) => {
      const packetStage = packet.stage ?? "证据不足";
      const text = `${packet.group} ${packet.industry} ${(packet.themes ?? []).join(" ")}`.toLowerCase();
      return (!stage || packetStage === stage) && (!normalizedQuery || text.includes(normalizedQuery));
    })
    .sort((left, right) => radarPacketDisplayPriority(right) - radarPacketDisplayPriority(left));
  const defaultVisibleCount = filters.defaultVisibleCount ?? 10;
  const hasActiveFilter = Boolean(stage || normalizedQuery);
  const defaultRows = allRows.filter((packet) => !isWeakRadarPacket(packet)).slice(0, defaultVisibleCount);
  const visibleRows = hasActiveFilter || filters.expanded ? allRows.slice(0, 160) : fillDefaultRadarRows(defaultRows, allRows, defaultVisibleCount);

  return { allRows, defaultRows: fillDefaultRadarRows(defaultRows, allRows, defaultVisibleCount), visibleRows, hasActiveFilter };
}

export function radarPacketDisplayPriority(packet: RadarIndustryPacket) {
  const scores = packet.scores ?? emptyRadarScores();
  const stageWeight = {
    扎实增长: 90,
    泡沫风险: 86,
    衰退: 82,
    即将增长: 76,
    平稳现金流: 68,
    继续观察: 56,
    证据不足: 10,
  }[packet.stage ?? "证据不足"];
  const evidence = typeof scores.evidence === "number" ? scores.evidence : Math.min(100, Math.sqrt(packet.sourceCount || 0) * 14 + packet.evidenceTypes.length * 8);
  const riskOrGrowth = Math.max(scores.growth ?? 0, scores.momentum ?? 0, scores.bubbleRisk ?? 0, scores.declineRisk ?? 0);
  const weakPenalty = isWeakRadarPacket(packet) ? 120 : 0;
  return stageWeight * 2 + evidence * 1.2 + riskOrGrowth * 0.7 + Math.sqrt(packet.sourceCount || 0) * 8 - weakPenalty - packet.evidenceGaps.length * 6;
}

export function isWeakRadarPacket(packet: RadarIndustryPacket) {
  const stage = packet.stage ?? "证据不足";
  const evidence = packet.scores?.evidence ?? 0;
  return stage === "证据不足" || (packet.sourceCount <= 1 && evidence < 35) || (packet.evidenceGaps.includes("缺多源验证") && packet.evidenceGaps.length >= 2);
}

export function radarPacketGapExplanation(packet: RadarIndustryPacket) {
  const gaps = packet.evidenceGaps ?? [];
  const compact = gaps.length ? gaps.join("、") : "暂无明显缺口";
  const nextEvidence = gaps.length ? uniqueStrings(gaps.flatMap(nextEvidenceForGap)).join("；") : "继续跟踪下一轮财报、价格、销量和公告是否出现方向变化。";
  const stage = packet.stage ?? "证据不足";
  const reason =
    stage === "证据不足"
      ? `证据强度不足，暂未进入正式结论。`
      : stage === "继续观察"
        ? `线索已扫描到，但关键硬证据仍不完整，暂未升级为正式结论。`
        : `已进入${stage}，仍需跟踪反证和缺口。`;
  return { compact, reason, nextEvidence };
}

function nextEvidenceForGap(gap: string) {
  return (
    {
      缺财报: ["补最新季报、业绩快报、业绩预告、经营现金流"],
      缺价格: ["补现货/期货价格、库存、价差或批价"],
      缺销量: ["补销量、出口、装机、客流或销售面积"],
      缺订单: ["补订单、合同、在手订单、中标公告"],
      缺库存: ["补库存、去库/累库、渠道库存或产能利用率"],
      缺产能: ["补产能、开工率、出清进度"],
      缺现金流: ["补经营现金流、自由现金流、分红覆盖"],
      缺政策细则: ["补正式政策文件、监管口径和实施细则"],
      缺公司公告: ["补交易所公告、公司披露和投资者关系记录"],
      缺多源验证: ["补第二来源交叉验证"],
    }[gap] ?? [`补${gap.replace(/^缺/, "")}相关硬证据`]
  );
}

function fillDefaultRadarRows(defaultRows: RadarIndustryPacket[], allRows: RadarIndustryPacket[], defaultVisibleCount: number) {
  if (defaultRows.length >= defaultVisibleCount) return defaultRows;
  const selected = new Set(defaultRows.map((packet) => packet.industry));
  const fillers = allRows.filter((packet) => !selected.has(packet.industry)).slice(0, defaultVisibleCount - defaultRows.length);
  return [...defaultRows, ...fillers];
}

function emptyRadarScores() {
  return { growth: 0, momentum: 0, evidence: 0, valuationRisk: 0, bubbleRisk: 0, declineRisk: 0, confidence: 0, change: 0 };
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
