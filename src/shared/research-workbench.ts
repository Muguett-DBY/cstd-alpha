import type { RadarIndustryPacket, RadarIndustryStage } from "./radar";
import type { ResearchTemplate, WatchlistRankingEntry } from "./user-research";

export const RESEARCH_STAGES = ["screening", "deepResearch", "awaitingCatalyst", "opinionFormed", "archived"] as const;

export type ResearchStage = (typeof RESEARCH_STAGES)[number];

export const RESEARCH_STAGE_LABELS: Record<ResearchStage, string> = {
  screening: "待初筛",
  deepResearch: "深入研究",
  awaitingCatalyst: "等待催化",
  opinionFormed: "已形成观点",
  archived: "归档/否决",
};

export type ResearchEntityType = "company" | "industry";

export type ResearchOpportunitySignal = {
  id: string;
  entityType: ResearchEntityType;
  entityId: string;
  title: string;
  subtitle: string;
  stage: ResearchStage;
  opportunityScore: number;
  riskScore: number;
  evidenceScore: number;
  catalystScore: number;
  valuationMismatchScore: number;
  upsideScore: number;
  sourceCount: number;
  reasons: string[];
  source: "radar" | "watchlist" | "hybrid";
};

export type ResearchWorkbenchItem = {
  id: string;
  userKey: string;
  entityType: ResearchEntityType;
  entityId: string;
  title: string;
  subtitle?: string;
  stage: ResearchStage;
  status: string;
  source: string;
  evidenceHash?: string;
  currentThesisVersionId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type ResearchThesisVersion = {
  id: string;
  itemId: string;
  version: number;
  thesisMarkdown: string;
  coreCitations: string[];
  counterEvidence: string[];
  evidenceHash?: string;
  createdBy: string;
  createdAt: string;
};

export type ResearchCatalyst = {
  id: string;
  itemId: string;
  title: string;
  description?: string;
  dueAt?: string;
  status: ResearchCatalystStatus;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
};

export const RESEARCH_CATALYST_STATUSES = ["open", "confirmed", "invalid"] as const;

export type ResearchCatalystStatus = (typeof RESEARCH_CATALYST_STATUSES)[number];

export const RESEARCH_CATALYST_STATUS_LABELS: Record<ResearchCatalystStatus, string> = {
  open: "跟踪中",
  confirmed: "已确认",
  invalid: "已失效",
};

export type ResearchCatalystStatusFilter = ResearchCatalystStatus | "all";

export type ResearchCatalystStatusSummary = Record<ResearchCatalystStatusFilter, number>;

export type ResearchCatalystDraft = {
  title: string;
  description?: string;
  evidenceRefs: string[];
};

export type ResearchOpportunityInput = {
  evidenceChange: number;
  catalystProximity: number;
  valuationMismatch: number;
  potentialUpside: number;
  downsideRisk: number;
};

export type TemplateGroupId = "quality" | "financial" | "moat" | "valuation" | "risk" | "return";

export type ResearchTemplateGroup = {
  id: TemplateGroupId;
  label: string;
  templates: ResearchTemplate[];
};

const TEMPLATE_GROUP_LABELS: Record<TemplateGroupId, string> = {
  quality: "公司质量",
  financial: "财务",
  moat: "竞争优势",
  valuation: "估值",
  risk: "风险",
  return: "回报模式",
};

export function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function calculateResearchOpportunityScore(input: ResearchOpportunityInput) {
  const evidenceChange = clampScore(input.evidenceChange);
  const catalystProximity = clampScore(input.catalystProximity);
  const valuationMismatch = clampScore(input.valuationMismatch);
  const potentialUpside = clampScore(input.potentialUpside);
  const downsideRisk = clampScore(input.downsideRisk);
  return clampScore(
    evidenceChange * 0.22
    + catalystProximity * 0.18
    + valuationMismatch * 0.22
    + potentialUpside * 0.22
    + (100 - downsideRisk) * 0.16,
  );
}

export function mapRadarStageToResearchStage(stage?: RadarIndustryStage): ResearchStage {
  switch (stage) {
    case "扎实增长":
    case "即将增长":
      return "deepResearch";
    case "泡沫风险":
    case "衰退":
      return "awaitingCatalyst";
    case "平稳现金流":
      return "opinionFormed";
    case "证据不足":
      return "screening";
    case "继续观察":
    default:
      return "screening";
  }
}

export function opportunityFromRadarPacket(packet: RadarIndustryPacket): ResearchOpportunitySignal {
  const scores = packet.scores;
  const evidenceScore = clampScore(scores?.evidence ?? Math.min(100, packet.sourceCount * 2));
  const riskScore = clampScore(Math.max(scores?.bubbleRisk ?? 0, scores?.declineRisk ?? 0, scores?.valuationRisk ?? 0));
  const catalystScore = clampScore((scores?.change ?? 0) * 0.6 + (packet.changeStatus === "new" ? 30 : packet.changeStatus === "changed" ? 18 : 0));
  const valuationMismatchScore = clampScore(100 - (scores?.valuationRisk ?? riskScore * 0.6));
  const upsideScore = clampScore((scores?.growth ?? 0) * 0.65 + (scores?.momentum ?? 0) * 0.35);
  const opportunityScore = calculateResearchOpportunityScore({
    evidenceChange: evidenceScore,
    catalystProximity: catalystScore,
    valuationMismatch: valuationMismatchScore,
    potentialUpside: upsideScore,
    downsideRisk: riskScore,
  });
  const reasons = [
    packet.changeStatus === "new" ? "本轮新增信号" : packet.changeStatus === "changed" ? "本轮证据变化" : "",
    packet.stage ? `阶段：${packet.stage}` : "",
    packet.evidenceGaps.length ? `缺口：${packet.evidenceGaps.slice(0, 2).join("、")}` : "核心证据暂无显著缺口",
  ].filter(Boolean);

  return {
    id: `radar:${packet.industry}`,
    entityType: "industry",
    entityId: packet.industry,
    title: packet.industry,
    subtitle: packet.themes?.slice(0, 2).join(" / ") || packet.group,
    stage: mapRadarStageToResearchStage(packet.stage),
    opportunityScore,
    riskScore,
    evidenceScore,
    catalystScore,
    valuationMismatchScore,
    upsideScore,
    sourceCount: packet.sourceCount,
    reasons,
    source: "radar",
  };
}

export function opportunityFromWatchlistRanking(entry: WatchlistRankingEntry): ResearchOpportunitySignal {
  const quality = clampScore(entry.companyQualityScore ?? entry.overallScore ?? 0);
  const attractiveness = clampScore(entry.investmentAttractivenessScore ?? entry.overallScore ?? 0);
  const riskScore = clampScore(100 - quality + entry.riskFlags.length * 8);
  const evidenceScore = entry.status === "completed" ? 72 : entry.status === "running" ? 45 : 25;
  const catalystScore = /看好|买入|加仓|高弹性|拐点|反转|催化/.test(`${entry.verdict ?? ""} ${entry.summary ?? ""}`) ? 72 : 38;
  const opportunityScore = calculateResearchOpportunityScore({
    evidenceChange: evidenceScore,
    catalystProximity: catalystScore,
    valuationMismatch: attractiveness,
    potentialUpside: (quality + attractiveness) / 2,
    downsideRisk: riskScore,
  });
  return {
    id: `watchlist:${entry.watchlistId}`,
    entityType: "company",
    entityId: entry.watchlistId,
    title: entry.companyName,
    subtitle: `${entry.ticker} / ${entry.market}`,
    stage: entry.status === "completed" && opportunityScore >= 70 ? "deepResearch" : "screening",
    opportunityScore,
    riskScore,
    evidenceScore,
    catalystScore,
    valuationMismatchScore: attractiveness,
    upsideScore: quality,
    sourceCount: entry.keyPoints.length + entry.riskFlags.length,
    reasons: [
      entry.summary || entry.verdict || "自选股评分待补充",
      ...entry.keyPoints.slice(0, 2),
      ...entry.riskFlags.slice(0, 1).map((flag) => `风险：${flag}`),
    ].filter(Boolean),
    source: "watchlist",
  };
}

export function groupResearchTemplates(templates: ResearchTemplate[]): ResearchTemplateGroup[] {
  const groups: Record<TemplateGroupId, ResearchTemplate[]> = {
    quality: [],
    financial: [],
    moat: [],
    valuation: [],
    risk: [],
    return: [],
  };
  for (const template of templates) {
    const text = `${template.title} ${template.shortTitle} ${template.focus} ${template.prompt}`;
    const group = templateGroupForText(text);
    groups[group].push(template);
  }
  return (Object.keys(groups) as TemplateGroupId[])
    .map((id) => ({ id, label: TEMPLATE_GROUP_LABELS[id], templates: groups[id] }))
    .filter((group) => group.templates.length > 0);
}

export function extractCatalystDraftsFromThesis(markdown: string, fallbackEvidenceRefs: string[] = [], limit = 8): ResearchCatalystDraft[] {
  const drafts: ResearchCatalystDraft[] = [];
  let activeSection: "catalyst" | "counter" | "tracking" | null = null;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.replace(/^#{1,6}\s*/, "");
    if (/^(关键)?催化剂|正向确认|确认信号/.test(heading)) {
      activeSection = "catalyst";
      continue;
    }
    if (/反证|失效条件|下调条件/.test(heading)) {
      activeSection = "counter";
      continue;
    }
    if (/跟踪清单|下一步跟踪|跟踪指标/.test(heading)) {
      activeSection = "tracking";
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      activeSection = null;
      continue;
    }
    if (!activeSection) continue;
    const cleaned = line
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+[.)、]\s*/, "")
      .replace(/^>\s*/, "")
      .trim();
    if (!cleaned || cleaned.length < 4) continue;
    const title = catalystTitle(cleaned, activeSection);
    if (!title || drafts.some((entry) => entry.title === title)) continue;
    const refs = uniqueEvidenceRefs([...evidenceRefsFromText(cleaned), ...fallbackEvidenceRefs]).slice(0, 5);
    drafts.push({ title, description: cleaned, evidenceRefs: refs });
    if (drafts.length >= limit) break;
  }
  return drafts;
}

export function summarizeResearchCatalystStatuses(catalysts: ResearchCatalyst[]): ResearchCatalystStatusSummary {
  const summary: ResearchCatalystStatusSummary = {
    all: catalysts.length,
    open: 0,
    confirmed: 0,
    invalid: 0,
  };
  for (const catalyst of catalysts) {
    summary[catalyst.status] += 1;
  }
  return summary;
}

export function filterResearchCatalystsByStatus(catalysts: ResearchCatalyst[], status: ResearchCatalystStatusFilter) {
  if (status === "all") return catalysts;
  return catalysts.filter((catalyst) => catalyst.status === status);
}

export function filterResearchWorkbenchItems(items: ResearchWorkbenchItem[], query: string) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return items;
  return items.filter((item) => normalizeSearchText([
    item.title,
    item.subtitle,
    item.entityId,
    item.entityType,
    item.source,
  ].filter(Boolean).join(" ")).includes(normalizedQuery));
}

function templateGroupForText(text: string): TemplateGroupId {
  if (/估值|DCF|安全边际|价格|配置/.test(text)) return "valuation";
  if (/财务|现金流|利润|ROE|负债|资本/.test(text)) return "financial";
  if (/风险|陷阱|衰退|泡沫|反证|红线/.test(text)) return "risk";
  if (/回报|分红|收益|股东/.test(text)) return "return";
  if (/护城河|竞争|商业模式|市场地位|优势/.test(text)) return "moat";
  return "quality";
}

function catalystTitle(text: string, section: "catalyst" | "counter" | "tracking") {
  const normalized = text
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .replace(/（?E\d+[^）\s]*）?/gi, "")
    .trim();
  const firstClause = normalized.split(/[。；;，,]/)[0]?.trim() || normalized;
  const prefix = section === "counter" ? "反证：" : section === "tracking" ? "跟踪：" : "催化：";
  const compact = firstClause.slice(0, 42);
  return compact ? `${prefix}${compact}` : "";
}

function evidenceRefsFromText(text: string) {
  return text.match(/\bE\d+\b/g) ?? [];
}

function uniqueEvidenceRefs(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase();
}
