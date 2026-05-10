export type ReportLanguage = "zh-CN" | "en";

export type CompanyIdentity = {
  name: string;
  ticker?: string;
  market?: string;
  industry?: string;
  sector?: string;
};

export type ModuleWeight = {
  id: string;
  name: string;
  weight: number;
};

export type ModuleScore = ModuleWeight & {
  score: number;
  weightedScore: number;
  summary: string;
  evidence: string[];
  concerns: string[];
};

export type RedFlag = {
  label: string;
  cap: number;
  severity: "critical" | "warning";
  evidence?: string;
};

export type EvidenceItem = {
  title: string;
  source: string;
  url: string;
  retrievedAt: string;
  freshness: "latest-public" | "stale" | "unavailable";
  notes: string;
};

export type ReportSections = {
  companyOverview: string;
  industry: string;
  businessModel: string;
  moat: string;
  governance: string;
  financialQuality: string;
  growth: string;
  valuation: string;
  risks: string;
  finalConclusion: string;
};

export type InvestmentReport = {
  company: CompanyIdentity;
  asOf: string;
  conclusion: "买入" | "加仓" | "持有" | "观察" | "减仓" | "卖出" | "回避";
  oneSentence: string;
  cqs: number;
  ias: number;
  moduleScores: ModuleScore[];
  redFlags: RedFlag[];
  evidence: EvidenceItem[];
  sections: ReportSections;
  disclaimer: string;
};

export const MODULE_WEIGHTS: ModuleWeight[] = [
  { id: "industry", name: "行业与生命周期", weight: 10 },
  { id: "businessModel", name: "商业模式与价值链", weight: 12 },
  { id: "moat", name: "竞争优势与护城河", weight: 14 },
  { id: "growth", name: "成长性与重大转折期", weight: 10 },
  { id: "financialQuality", name: "财务质量与现金流", weight: 16 },
  { id: "governance", name: "管理层与治理结构", weight: 10 },
  { id: "capitalAllocation", name: "股东回报与资本配置", weight: 8 },
  { id: "valuation", name: "估值合理性与安全边际", weight: 12 },
  { id: "riskResilience", name: "风险韧性与反证条件", weight: 6 },
  { id: "minorityShareholder", name: "小股东友好度与所有者视角", weight: 2 },
];

export const REQUIRED_SECTION_KEYS: Array<keyof ReportSections> = [
  "companyOverview",
  "industry",
  "businessModel",
  "moat",
  "governance",
  "financialQuality",
  "growth",
  "valuation",
  "risks",
  "finalConclusion",
];

export function calculateWeightedScore(scores: ModuleScore[]) {
  const modules = scores.map((score) => ({
    ...score,
    weightedScore: roundScore((score.score * score.weight) / 100),
  }));
  const total = roundScore(modules.reduce((sum, module) => sum + module.weightedScore, 0));

  return { modules, total };
}

export function applyRiskCaps(score: number, redFlags: RedFlag[]) {
  const caps = redFlags.map((flag) => flag.cap).filter((cap) => Number.isFinite(cap));
  if (!caps.length) return roundScore(score);

  return roundScore(Math.min(score, ...caps));
}

export function validateReportPayload(value: unknown): InvestmentReport {
  if (!isRecord(value)) throw new Error("Report payload must be an object");
  if (!isRecord(value.company) || !isNonEmptyString(value.company.name)) {
    throw new Error("Report payload missing company name");
  }
  if (!isRecord(value.sections)) throw new Error("Report payload missing sections");

  for (const key of REQUIRED_SECTION_KEYS) {
    if (!isNonEmptyString(value.sections[key])) {
      throw new Error(`Missing required report section: ${key}`);
    }
  }

  return {
    company: {
      name: String(value.company.name),
      ticker: optionalString(value.company.ticker),
      market: optionalString(value.company.market),
      industry: optionalString(value.company.industry),
      sector: optionalString(value.company.sector),
    },
    asOf: isNonEmptyString(value.asOf) ? value.asOf : new Date().toISOString(),
    conclusion: normalizeConclusion(value.conclusion),
    oneSentence: isNonEmptyString(value.oneSentence) ? value.oneSentence : "暂无一句话结论。",
    cqs: clampScore(value.cqs),
    ias: clampScore(value.ias),
    moduleScores: normalizeModuleScores(value.moduleScores),
    redFlags: normalizeRedFlags(value.redFlags),
    evidence: normalizeEvidence(value.evidence),
    sections: Object.fromEntries(
      REQUIRED_SECTION_KEYS.map((key) => [key, String((value.sections as Record<string, unknown>)[key])]),
    ) as ReportSections,
    disclaimer: isNonEmptyString(value.disclaimer)
      ? value.disclaimer
      : "本报告仅用于学习、研究和个人复盘，不构成任何买卖建议。",
  };
}

export function emptyReport(companyName: string, message: string): InvestmentReport {
  const now = new Date().toISOString();
  const moduleScores = calculateWeightedScore(
    MODULE_WEIGHTS.map((module) => ({
      ...module,
      score: 0,
      weightedScore: 0,
      summary: "数据不足，无法评分。",
      evidence: [],
      concerns: [message],
    })),
  ).modules;

  return {
    company: { name: companyName },
    asOf: now,
    conclusion: "观察",
    oneSentence: message,
    cqs: 0,
    ias: 0,
    moduleScores,
    redFlags: [{ label: "公开数据不足", cap: 50, severity: "warning", evidence: message }],
    evidence: [],
    sections: {
      companyOverview: message,
      industry: message,
      businessModel: message,
      moat: message,
      governance: message,
      financialQuality: message,
      growth: message,
      valuation: message,
      risks: message,
      finalConclusion: message,
    },
    disclaimer: "本报告仅用于学习、研究和个人复盘，不构成任何买卖建议。",
  };
}

function normalizeModuleScores(value: unknown): ModuleScore[] {
  if (!Array.isArray(value) || value.length === 0) {
    return MODULE_WEIGHTS.map((module) => ({
      ...module,
      score: 0,
      weightedScore: 0,
      summary: "模型未提供该模块评分。",
      evidence: [],
      concerns: ["缺少模型输出。"],
    }));
  }

  const normalized = MODULE_WEIGHTS.map((weight) => {
    const raw = value.find((item) => isRecord(item) && item.id === weight.id);
    return {
      ...weight,
      score: clampScore(isRecord(raw) ? raw.score : 0),
      weightedScore: 0,
      summary: isRecord(raw) && isNonEmptyString(raw.summary) ? raw.summary : "暂无摘要。",
      evidence: isRecord(raw) ? stringArray(raw.evidence) : [],
      concerns: isRecord(raw) ? stringArray(raw.concerns) : [],
    };
  });

  return calculateWeightedScore(normalized).modules;
}

function normalizeRedFlags(value: unknown): RedFlag[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((flag) => ({
    label: isNonEmptyString(flag.label) ? flag.label : "未命名风险",
    cap: clampScore(flag.cap),
    severity: flag.severity === "critical" ? "critical" : "warning",
    evidence: optionalString(flag.evidence),
  }));
}

function normalizeEvidence(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    title: isNonEmptyString(item.title) ? item.title : "Untitled evidence",
    source: isNonEmptyString(item.source) ? item.source : "Unknown",
    url: isNonEmptyString(item.url) ? item.url : "",
    retrievedAt: isNonEmptyString(item.retrievedAt) ? item.retrievedAt : new Date().toISOString(),
    freshness:
      item.freshness === "latest-public" || item.freshness === "stale" || item.freshness === "unavailable"
        ? item.freshness
        : "unavailable",
    notes: isNonEmptyString(item.notes) ? item.notes : "",
  }));
}

function normalizeConclusion(value: unknown): InvestmentReport["conclusion"] {
  const allowed: InvestmentReport["conclusion"][] = ["买入", "加仓", "持有", "观察", "减仓", "卖出", "回避"];
  return allowed.includes(value as InvestmentReport["conclusion"]) ? (value as InvestmentReport["conclusion"]) : "观察";
}

function clampScore(value: unknown) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return roundScore(Math.max(0, Math.min(100, number)));
}

function roundScore(value: number) {
  return Math.round(value * 100) / 100;
}

function optionalString(value: unknown) {
  return isNonEmptyString(value) ? value : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isNonEmptyString).map(String) : [];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
