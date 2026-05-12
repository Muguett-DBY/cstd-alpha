export type ReportLanguage = "zh-CN" | "en";

export type CompanyIdentity = {
  name: string;
  ticker?: string;
  market?: string;
  industry?: string;
  sector?: string;
};

export type CompanyCandidate = {
  id: string;
  name: string;
  code: string;
  exchange: string;
  listingPlace: string;
  marketType: string;
  quoteId?: string;
  secid?: string;
  yahooSymbol?: string;
  source: "eastmoney" | "yahoo";
};

export type ModuleWeight = {
  id: string;
  name: string;
  weight: number;
};

export type ModuleScore = ModuleWeight & {
  score: number;
  weightedScore: number;
  label: ScoreLabel;
  summary: string;
  evidence: string[];
  concerns: string[];
};

export type ScoreLabel = "极好" | "好" | "一般" | "差";

export type ScoreItemDefinition = {
  id: string;
  title: string;
  moduleId: string;
  moduleName: string;
  weight: number;
  question: string;
};

export type ScoreItem = ScoreItemDefinition & {
  score: number;
  label: ScoreLabel;
  evidence: string[];
  deductions: string[];
  recentChange: string;
  reason: string;
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

export type FullReportSections = {
  onePageConclusion: string;
  companyOverview: string;
  industryTrack: string;
  businessModel: string;
  moat: string;
  governance: string;
  financialQuality: string;
  growthInflection: string;
  valuation: string;
  risks: string;
  finalConclusion: string;
  accountRules: string;
};

export type SummaryDashboard = {
  valuationView: string;
  positionAdvice: string;
  investmentHorizon: string;
  keyReasons: string[];
  keyRisks: string[];
  trackingMetrics: string[];
};

export type QualitativeAnalysis = {
  companyHistory: string;
  lifecycle: string;
  businessStructure: string;
  shareholderPosition: string;
};

export type FinancialRow = {
  metric: string;
  values: Record<string, string>;
  trend: string;
  interpretation: string;
};

export type FinancialTenYear = {
  rows: FinancialRow[];
  interpretation: string;
};

export type ValuationScenario = {
  name: string;
  assumptions: string;
  value: string;
  expectedReturn: string;
  probability: string;
};

export type ValuationAnalysis = {
  currentPrice: string;
  fairValueRange: string;
  buyRange: string;
  sellReduceRange: string;
  methods: string[];
  scenarios: ValuationScenario[];
  conclusion: string;
};

export type RiskMatrixItem = {
  type: string;
  risk: string;
  probability: string;
  impact: string;
  warningMetric: string;
  response: string;
};

export type AccountRules = {
  companyGrade: string;
  maxPosition: string;
  addCondition: string;
  reduceCondition: string;
  reviewTiming: string;
};

export type InvestmentReport = {
  company: CompanyIdentity;
  asOf: string;
  conclusion: "买入" | "加仓" | "持有" | "观察" | "减仓" | "卖出" | "回避";
  oneSentence: string;
  cqs: number;
  ias: number;
  qualitativeBand: string;
  summaryDashboard: SummaryDashboard;
  moduleScores: ModuleScore[];
  scoreItems20: ScoreItem[];
  redFlags: RedFlag[];
  evidence: EvidenceItem[];
  sections: ReportSections;
  qualitativeAnalysis: QualitativeAnalysis;
  financialTenYear: FinancialTenYear;
  valuationAnalysis: ValuationAnalysis;
  riskMatrix: RiskMatrixItem[];
  accountRules: AccountRules;
  fullSections: FullReportSections;
  disclaimer: string;
};

export type ReportGenerationMetrics = {
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  modelCalls: number;
  cacheMode: "prefer-cache" | "refresh";
  cacheHit?: boolean;
  cachedAt?: string;
  sourceElapsedMs?: number;
  tokenUsage?: ReportTokenUsage[];
};

export type ReportTokenUsage = {
  model: string;
  calls: number;
  promptTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type ScoreScale = 1 | 10;

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

export const SCORE_ITEMS_20: ScoreItemDefinition[] = [
  { id: "industryLifecycle", title: "行业生命周期与产业状态", moduleId: "industry", moduleName: "行业与生命周期", weight: 6, question: "行业处于成长/成熟/衰退？产业利润池是否扩大？" },
  { id: "industryCyclicality", title: "行业周期性与需求稳定性", moduleId: "industry", moduleName: "行业与生命周期", weight: 4, question: "强周期/弱周期/非周期？需求受宏观影响多大？" },
  { id: "businessModelQuality", title: "商业模式质量", moduleId: "businessModel", moduleName: "商业模式与价值链", weight: 7, question: "是否高毛利、高复购、高粘性、低资本开支、现金流好？" },
  { id: "bargainingAndCashConversion", title: "价值链议价能力与现金转换", moduleId: "businessModel", moduleName: "商业模式与价值链", weight: 3, question: "上下游谁更强？收入确认、回款、应收账款是否健康？" },
  { id: "assetAndCostStructure", title: "运营成本/资产轻重/资本开支", moduleId: "businessModel", moduleName: "商业模式与价值链", weight: 2, question: "劳动密集/资金密集/技术密集/营销密集？扩张代价高不高？" },
  { id: "durableMoat", title: "长期竞争优势/护城河", moduleId: "moat", moduleName: "竞争优势与护城河", weight: 8, question: "品牌、技术、成本、渠道、规模、牌照、网络效应是否可持续？" },
  { id: "marketPosition", title: "市场地位/垄断性/竞争格局", moduleId: "moat", moduleName: "竞争优势与护城河", weight: 4, question: "国内外地位、份额、CR3/CR5、价格战程度。" },
  { id: "innovationRisk", title: "技术创新/产品迭代/替代风险", moduleId: "moat", moduleName: "竞争优势与护城河", weight: 2, question: "研发有效性、产品生命周期、被替代风险。" },
  { id: "revenueGrowthQuality", title: "收入增长质量", moduleId: "growth", moduleName: "成长性与重大转折期", weight: 5, question: "增长来自需求/份额/价格/并购？是否可持续？" },
  { id: "profitAndFcfGrowth", title: "扣非净利与自由现金流增长", moduleId: "growth", moduleName: "成长性与重大转折期", weight: 5, question: "利润增长是否能变成自由现金流？" },
  { id: "roeRoicMargins", title: "ROE/ROIC 与利润率", moduleId: "financialQuality", moduleName: "财务质量与现金流", weight: 6, question: "高 ROE 是否来自经营能力而不是高杠杆？利润率趋势如何？" },
  { id: "cashFlowConsistency", title: "现金流质量与三表一致性", moduleId: "financialQuality", moduleName: "财务质量与现金流", weight: 5, question: "经营现金流、扣非净利、FCF 是否长期匹配？" },
  { id: "balanceSheetHealth", title: "资产负债/财务健康/商誉", moduleId: "financialQuality", moduleName: "财务质量与现金流", weight: 5, question: "短债、有息负债、商誉、存货、应收是否有风险？" },
  { id: "managementExecution", title: "管理层战略与执行", moduleId: "governance", moduleName: "管理层与治理结构", weight: 5, question: "战略是否聚焦主业？过去承诺兑现度如何？" },
  { id: "governanceFairness", title: "治理结构/大小股东公平", moduleId: "governance", moduleName: "管理层与治理结构", weight: 5, question: "关联交易、质押、激励、审计、信息披露是否友好？" },
  { id: "capitalReturn", title: "股东回报/分红回购/资本配置", moduleId: "capitalAllocation", moduleName: "股东回报与资本配置", weight: 8, question: "分红、回购注销、再投资回报、并购质量。" },
  { id: "relativeValuation", title: "估值合理性/历史与同业", moduleId: "valuation", moduleName: "估值合理性与安全边际", weight: 6, question: "PE/PB/PS/EV/EBITDA 历史分位与同业对比。" },
  { id: "tenYearReturnSafety", title: "十年回报反推/安全边际", moduleId: "valuation", moduleName: "估值合理性与安全边际", weight: 6, question: "按十年后利润和合理 PE 反推，预期回报够不够？" },
  { id: "riskAndDisconfirmingEvidence", title: "风险清单与反证条件", moduleId: "riskResilience", moduleName: "风险韧性与反证条件", weight: 6, question: "风险是否可监控？反证条件是否明确？" },
  { id: "ownerPerspective", title: "小股东长期回报预期/所有者视角", moduleId: "minorityShareholder", moduleName: "小股东友好度与所有者视角", weight: 2, question: "站在散户长期持有者角度，是否值得做股权所有者？" },
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

export const REQUIRED_FULL_SECTION_KEYS: Array<keyof FullReportSections> = [
  "onePageConclusion",
  "companyOverview",
  "industryTrack",
  "businessModel",
  "moat",
  "governance",
  "financialQuality",
  "growthInflection",
  "valuation",
  "risks",
  "finalConclusion",
  "accountRules",
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

export function scoreLabel(score: number): ScoreLabel {
  if (score >= 85) return "极好";
  if (score >= 70) return "好";
  if (score >= 50) return "一般";
  return "差";
}

const SAME_COMPANY_REFRESH_MAX_ITEM_DRIFT = 12;

export function stabilizeReportScores(report: InvestmentReport, previousReport: InvestmentReport | undefined | null): InvestmentReport {
  if (!previousReport || !isSameCompanyIdentity(report.company, previousReport.company)) return report;
  if (report.redFlags.some((flag) => flag.severity === "critical")) return report;

  const previousScores = new Map(previousReport.scoreItems20.map((item) => [item.id, item]));
  const usablePreviousScores = previousReport.scoreItems20.filter((item) => item.score > 0).length;
  if (usablePreviousScores < 15) return report;

  let changed = false;
  const scoreItems20 = report.scoreItems20.map((item) => {
    const previous = previousScores.get(item.id);
    if (!previous) return item;
    const lower = previous.score - SAME_COMPANY_REFRESH_MAX_ITEM_DRIFT;
    const upper = previous.score + SAME_COMPANY_REFRESH_MAX_ITEM_DRIFT;
    const score = clampScore(Math.max(lower, Math.min(upper, item.score)));
    if (score === item.score) return item;
    changed = true;
    return {
      ...item,
      score,
      label: scoreLabel(score),
    };
  });

  return changed ? validateReportPayload({ ...report, scoreItems20 }) : report;
}

export function qualitativeBand(score: number) {
  if (score <= 30) return "高风险垃圾股";
  if (score <= 50) return "平庸";
  if (score <= 70) return "中规中矩";
  if (score <= 85) return "优质";
  return "卓越复合成长股";
}

export function validateReportPayload(value: unknown): InvestmentReport {
  if (!isRecord(value)) throw new Error("Report payload must be an object");
  if (!isRecord(value.company) || !isNonEmptyString(value.company.name)) {
    throw new Error("Report payload missing company name");
  }

  const evidence = normalizeEvidence(value.evidence);
  const redFlags = normalizeRedFlags(value.redFlags);
  const scoreScale = detectScoreScale(value);
  const scoreItems20 = normalizeScoreItems(value.scoreItems20, scoreScale);
  const computed = computeScores(scoreItems20, redFlags, evidence);
  const cqs = Array.isArray(value.scoreItems20) ? computed.cqs : clampScore(value.cqs);
  const ias = Array.isArray(value.scoreItems20) ? computed.ias : applyEvidenceCaps(clampScore(value.ias), evidence, redFlags);
  const sections = normalizeSections(value.sections, value.fullSections, value.company.name);
  const fullSections = normalizeFullSections(value.fullSections, sections, value.company.name);
  const valuationAnalysis = normalizeValuationAnalysis(value.valuationAnalysis);
  const decision = deriveInvestmentDecision(value.conclusion, cqs, ias, redFlags, valuationAnalysis);

  return {
    company: {
      name: String(value.company.name),
      ticker: optionalString(value.company.ticker),
      market: optionalString(value.company.market),
      industry: optionalString(value.company.industry),
      sector: optionalString(value.company.sector),
    },
    asOf: isNonEmptyString(value.asOf) ? value.asOf : new Date().toISOString(),
    conclusion: decision.conclusion,
    oneSentence: isNonEmptyString(value.oneSentence) ? value.oneSentence : fallbackText(value.company.name, "核心一句话"),
    cqs,
    ias,
    qualitativeBand: qualitativeBand(ias),
    summaryDashboard: normalizeSummaryDashboard(value.summaryDashboard, valuationAnalysis, decision),
    moduleScores: Array.isArray(value.scoreItems20) ? computed.modules : normalizeModuleScores(value.moduleScores),
    scoreItems20,
    redFlags,
    evidence,
    sections,
    qualitativeAnalysis: normalizeQualitativeAnalysis(value.qualitativeAnalysis, value.company.name),
    financialTenYear: normalizeFinancialTenYear(value.financialTenYear),
    valuationAnalysis,
    riskMatrix: normalizeRiskMatrix(value.riskMatrix),
    accountRules: normalizeAccountRules(value.accountRules, cqs, decision),
    fullSections,
    disclaimer: isNonEmptyString(value.disclaimer)
      ? value.disclaimer
      : "本报告仅用于学习、研究和个人复盘，不构成任何买卖建议。",
  };
}

export function emptyReport(companyName: string, message: string): InvestmentReport {
  const now = new Date().toISOString();
  return validateReportPayload({
    company: { name: companyName },
    asOf: now,
    conclusion: "观察",
    oneSentence: message,
    cqs: 0,
    ias: 0,
    scoreItems20: SCORE_ITEMS_20.map((item) => ({
      ...item,
      score: 0,
      label: "差",
      evidence: [],
      deductions: [message],
      recentChange: "数据不足；对分数影响：无法判断",
      reason: message,
    })),
    redFlags: [{ label: "公开数据不足", cap: 50, severity: "warning", evidence: message }],
    evidence: [],
    sections: Object.fromEntries(REQUIRED_SECTION_KEYS.map((key) => [key, message])),
    fullSections: Object.fromEntries(REQUIRED_FULL_SECTION_KEYS.map((key) => [key, message])),
    disclaimer: "本报告仅用于学习、研究和个人复盘，不构成任何买卖建议。",
  });
}

function computeScores(scoreItems20: ScoreItem[], redFlags: RedFlag[], evidence: EvidenceItem[]) {
  const modules = MODULE_WEIGHTS.map((module) => {
    const items = scoreItems20.filter((item) => item.moduleId === module.id);
    const weightedScore = roundScore(items.reduce((sum, item) => sum + (item.score * item.weight) / 100, 0));
    const score = module.weight ? roundScore((weightedScore / module.weight) * 100) : 0;
    return {
      ...module,
      score,
      weightedScore,
      label: scoreLabel(score),
      summary: summarizeItems(items),
      evidence: items.flatMap((item) => item.evidence).slice(0, 4),
      concerns: items.flatMap((item) => item.deductions).slice(0, 4),
    };
  });

  const qualityItems = scoreItems20.filter((item) => item.moduleId !== "valuation");
  const qualityWeight = qualityItems.reduce((sum, item) => sum + item.weight, 0);
  const cqs = roundScore((qualityItems.reduce((sum, item) => sum + (item.score * item.weight) / 100, 0) / qualityWeight) * 100);
  const rawIas = roundScore(scoreItems20.reduce((sum, item) => sum + (item.score * item.weight) / 100, 0));

  return { cqs, ias: applyEvidenceCaps(rawIas, evidence, redFlags), modules };
}

function applyEvidenceCaps(score: number, evidence: EvidenceItem[], redFlags: RedFlag[]) {
  const latestPublicCount = evidence.filter((item) => item.freshness === "latest-public").length;
  const caps = latestPublicCount < 2 ? [...redFlags, { label: "公开证据不足", cap: 50, severity: "warning" as const }] : redFlags;
  return applyRiskCaps(score, caps);
}

function normalizeScoreItems(value: unknown, scoreScale: ScoreScale = 1): ScoreItem[] {
  const rawItems = Array.isArray(value) ? value.filter(isRecord) : [];
  return SCORE_ITEMS_20.map((definition) => {
    const raw = rawItems.find((item) => item.id === definition.id || item.title === definition.title);
    const score = normalizeModelScore(raw?.score, scoreScale);
    const reason = cleanScoreDetailText(raw?.reason) || "数据不足：模型未提供该项完整评分理由。";
    const deductions = stringArray(raw?.deductions).filter((text) => !isPlaceholderScoreDetailText(text));
    const evidence = stringArray(raw?.evidence).filter((text) => !isPlaceholderScoreDetailText(text));
    return {
      ...definition,
      score,
      label: scoreLabel(score),
      evidence: evidence.length ? evidence : [`公开财务、行情和业务证据支持该项${scoreLabel(score)}评分。`],
      deductions: deductions.length ? deductions : [`该项缺少足够强的正面证据，按保守口径扣分：${reason}`],
      recentChange: cleanScoreDetailText(raw?.recentChange) || "最近 12 个月变化需结合公开财务和行情证据复核；本项暂不额外调整分数。",
      reason,
    };
  });
}

function normalizeModuleScores(value: unknown): ModuleScore[] {
  if (!Array.isArray(value) || value.length === 0) {
    return calculateWeightedScore(
      MODULE_WEIGHTS.map((module) => ({
        ...module,
        score: 0,
        weightedScore: 0,
        label: "差" as const,
        summary: "模型未提供该模块评分。",
        evidence: [],
        concerns: ["缺少模型输出。"],
      })),
    ).modules;
  }

  const normalized = MODULE_WEIGHTS.map((weight) => {
    const raw = value.find((item) => isRecord(item) && item.id === weight.id);
    const score = clampScore(isRecord(raw) ? raw.score : 0);
    return {
      ...weight,
      score,
      weightedScore: 0,
      label: scoreLabel(score),
      summary: isRecord(raw) && isNonEmptyString(raw.summary) ? raw.summary : "暂无摘要。",
      evidence: isRecord(raw) ? stringArray(raw.evidence) : [],
      concerns: isRecord(raw) ? stringArray(raw.concerns) : [],
    };
  });

  return calculateWeightedScore(normalized).modules;
}

function detectScoreScale(value: Record<string, unknown>): ScoreScale {
  const rawItems = Array.isArray(value.scoreItems20) ? value.scoreItems20.filter(isRecord) : [];
  const scores = rawItems
    .map((item) => (typeof item.score === "number" && Number.isFinite(item.score) ? item.score : undefined))
    .filter((score): score is number => score !== undefined);
  if (!scores.length) return 1;

  const withinTenths = scores.filter((score) => score >= 0 && score <= 10).length;
  const looksLikeTenths = withinTenths >= Math.max(10, Math.ceil(scores.length * 0.7)) && Math.max(...scores) <= 10;
  if (!looksLikeTenths) return 1;

  const topLevelHighSignal = [numberValue(value.cqs), numberValue(value.ias)].some((score) => score !== undefined && score >= 50);
  const labels = rawItems.map((item) => optionalString(item.label));
  const badLabels = labels.filter((label) => label === "差").length;
  const mostlyBadLabels = badLabels >= Math.max(10, Math.ceil(rawItems.length * 0.7));
  const qualityTextSignal = hasQualityScaleSignal(value);

  return topLevelHighSignal || (qualityTextSignal && !mostlyBadLabels) ? 10 : 1;
}

function hasQualityScaleSignal(value: Record<string, unknown>) {
  const accountRules = isRecord(value.accountRules) ? value.accountRules : {};
  const summaryDashboard = isRecord(value.summaryDashboard) ? value.summaryDashboard : {};
  const fullSections = isRecord(value.fullSections) ? value.fullSections : {};
  const text = [
    value.oneSentence,
    value.conclusion,
    accountRules.companyGrade,
    summaryDashboard.companyGrade,
    fullSections.onePageConclusion,
    fullSections.finalConclusion,
  ]
    .filter((item) => typeof item === "string")
    .join(" ");
  return /CQS\s*[约≈:]?\s*[5-9]\d|公司等级\s*[：:]?\s*A|A级|优质公司|优质|极好|卓越|顶级/.test(text);
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

function normalizeSections(value: unknown, fullValue: unknown, companyName: unknown): ReportSections {
  const sections = isRecord(value) ? value : {};
  const fullSections = isRecord(fullValue) ? fullValue : {};
  const name = isNonEmptyString(companyName) ? companyName : "目标公司";
  return {
    companyOverview: sectionText(sections.companyOverview ?? fullSections.companyOverview, name, "公司概况"),
    industry: sectionText(sections.industry ?? fullSections.industryTrack, name, "行业与细分赛道"),
    businessModel: sectionText(sections.businessModel ?? fullSections.businessModel, name, "商业模式与价值链"),
    moat: sectionText(sections.moat ?? fullSections.moat, name, "核心竞争力与长期竞争优势"),
    governance: sectionText(sections.governance ?? fullSections.governance, name, "管理层、治理结构与股东文化"),
    financialQuality: sectionText(sections.financialQuality ?? fullSections.financialQuality, name, "财务质量与现金流"),
    growth: sectionText(sections.growth ?? fullSections.growthInflection, name, "成长空间与重大转折期"),
    valuation: sectionText(sections.valuation ?? fullSections.valuation, name, "估值与安全边际"),
    risks: sectionText(sections.risks ?? fullSections.risks, name, "风险清单与反证条件"),
    finalConclusion: sectionText(sections.finalConclusion ?? fullSections.finalConclusion, name, "最终投资结论"),
  };
}

function normalizeFullSections(value: unknown, sections: ReportSections, companyName: unknown): FullReportSections {
  const raw = isRecord(value) ? value : {};
  const name = isNonEmptyString(companyName) ? companyName : "目标公司";
  return {
    onePageConclusion: sectionText(raw.onePageConclusion, name, "一页结论与评分仪表盘"),
    companyOverview: sectionText(raw.companyOverview ?? sections.companyOverview, name, "公司概况与发展史"),
    industryTrack: sectionText(raw.industryTrack ?? sections.industry, name, "行业与细分赛道分析"),
    businessModel: sectionText(raw.businessModel ?? sections.businessModel, name, "商业模式与价值链"),
    moat: sectionText(raw.moat ?? sections.moat, name, "核心竞争力与长期竞争优势"),
    governance: sectionText(raw.governance ?? sections.governance, name, "管理层、治理结构与股东文化"),
    financialQuality: sectionText(raw.financialQuality ?? sections.financialQuality, name, "十年财务数据与现金流分析"),
    growthInflection: sectionText(raw.growthInflection ?? sections.growth, name, "成长空间与重大转折期判断"),
    valuation: sectionText(raw.valuation ?? sections.valuation, name, "估值分析：好公司是否有好价格"),
    risks: sectionText(raw.risks ?? sections.risks, name, "风险清单与反证条件"),
    finalConclusion: sectionText(raw.finalConclusion ?? sections.finalConclusion, name, "最终投资结论"),
    accountRules: sectionText(raw.accountRules, name, "账户管理与仓位规则"),
  };
}

type DerivedInvestmentDecision = {
  conclusion: InvestmentReport["conclusion"];
  positionAdvice: string;
};

function normalizeSummaryDashboard(value: unknown, valuationAnalysis: ValuationAnalysis | undefined, decision: DerivedInvestmentDecision): SummaryDashboard {
  const raw = isRecord(value) ? value : {};
  return {
    valuationView: meaningfulValuationView(raw.valuationView) ?? deriveValuationView(valuationAnalysis) ?? "待验证",
    positionAdvice: decision.positionAdvice,
    investmentHorizon: optionalString(raw.investmentHorizon) ?? "至少 5 年",
    keyReasons: stringArray(raw.keyReasons),
    keyRisks: stringArray(raw.keyRisks),
    trackingMetrics: stringArray(raw.trackingMetrics),
  };
}

function normalizeQualitativeAnalysis(value: unknown, companyName: unknown): QualitativeAnalysis {
  const raw = isRecord(value) ? value : {};
  const name = isNonEmptyString(companyName) ? companyName : "目标公司";
  return {
    companyHistory: sectionText(raw.companyHistory, name, "公司发展史"),
    lifecycle: sectionText(raw.lifecycle, name, "生命周期阶段"),
    businessStructure: sectionText(raw.businessStructure, name, "业务结构"),
    shareholderPosition: sectionText(raw.shareholderPosition, name, "四方博弈中的股东地位"),
  };
}

function normalizeFinancialTenYear(value: unknown): FinancialTenYear {
  const raw = isRecord(value) ? value : {};
  const rows = Array.isArray(raw.rows)
    ? raw.rows
        .filter(isRecord)
        .map((row) => ({
          metric: optionalString(row.metric),
          values: isRecord(row.values)
            ? Object.fromEntries(Object.entries(row.values).flatMap(([key, item]) => (item === undefined || item === null || String(item).trim() === "" ? [] : [[key, String(item)]])))
            : {},
          trend: optionalString(row.trend) ?? "待验证",
          interpretation: optionalString(row.interpretation) ?? "数据不足：该指标需要人工复核。",
        }))
        .filter((row): row is FinancialRow => Boolean(row.metric && Object.keys(row.values).length))
    : [];
  return {
    rows,
    interpretation: optionalString(raw.interpretation) ?? "数据不足：模型未提供完整十年财务解读。",
  };
}

function meaningfulValuationView(value: unknown) {
  const text = optionalString(value);
  return text && text !== "待验证" ? text : undefined;
}

function deriveValuationView(valuation: ValuationAnalysis | undefined) {
  if (!valuation) return undefined;
  const current = parseFirstNumber(valuation.currentPrice);
  const fair = parseNumbers(valuation.fairValueRange);
  const buy = parseNumbers(valuation.buyRange);
  const sell = parseNumbers(valuation.sellReduceRange);
  if (current !== undefined && buy.length && current <= Math.min(...buy)) return "低估";
  if (current !== undefined && sell.length && current >= Math.min(...sell)) return "高估";
  if (current !== undefined && fair.length >= 2) {
    const [low, high] = [Math.min(...fair), Math.max(...fair)];
    if (current < low) return "合理偏低";
    if (current > high) return "偏高";
    return "合理";
  }
  const conclusion = valuation.conclusion;
  if (conclusion.includes("低估")) return "低估";
  if (conclusion.includes("高估") || conclusion.includes("偏高")) return "偏高";
  if (conclusion.includes("合理")) return "合理";
  return undefined;
}

function parseFirstNumber(value: string) {
  return parseNumbers(value)[0];
}

function parseNumbers(value: string) {
  return Array.from(value.replace(/[,，]/g, "").replace(/(\d)\s*[-–—~至到]\s*(\d)/g, "$1 $2").matchAll(/-?\d+(?:\.\d+)?/g))
    .map((match) => Number(match[0]))
    .filter((number) => Number.isFinite(number));
}

function normalizeValuationAnalysis(value: unknown): ValuationAnalysis {
  const raw = isRecord(value) ? value : {};
  const scenarios = Array.isArray(raw.scenarios)
    ? raw.scenarios
        .filter(isRecord)
        .filter(isMeaningfulValuationScenario)
        .map((item, index) => ({
          name: optionalString(item.name) ?? `估值情景 ${index + 1}`,
          assumptions: optionalString(item.assumptions) ?? "待验证",
          value: optionalString(item.value) ?? "待验证",
          expectedReturn: optionalString(item.expectedReturn) ?? "待验证",
          probability: optionalString(item.probability) ?? "待验证",
        }))
    : [];
  return {
    currentPrice: optionalString(raw.currentPrice) ?? "待验证",
    fairValueRange: optionalString(raw.fairValueRange) ?? "待验证",
    buyRange: optionalString(raw.buyRange) ?? "待验证",
    sellReduceRange: optionalString(raw.sellReduceRange) ?? "待验证",
    methods: stringArray(raw.methods),
    scenarios,
    conclusion: optionalString(raw.conclusion) ?? "数据不足：模型未提供完整估值结论。",
  };
}

function normalizeRiskMatrix(value: unknown): RiskMatrixItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter(isMeaningfulRiskMatrixItem)
    .map((item) => ({
      type: meaningfulOptionalString(item.type) ?? "核心风险",
      risk: optionalString(item.risk) ?? "待验证",
      probability: meaningfulOptionalString(item.probability) ?? "需结合财报和公告复核",
      impact: meaningfulOptionalString(item.impact) ?? "可能压制估值、盈利或现金流",
      warningMetric: meaningfulOptionalString(item.warningMetric) ?? fallbackWarningMetric(item.risk),
      response: meaningfulOptionalString(item.response) ?? "暂不新增仓位，等待财报或公告确认。",
    }));
}

function fallbackWarningMetric(risk: unknown) {
  const text = optionalString(risk) ?? "";
  if (/负债|偿债|流动性|债务|杠杆/.test(text)) return "资产负债率、货币资金/短期债务、经营现金流";
  if (/需求|行业|收入|订单|萎缩|下滑/.test(text)) return "营业收入同比、新签订单、毛利率";
  if (/利润|亏损|盈利|减值/.test(text)) return "扣非净利润、净利率、资产减值损失";
  if (/估值|股价|回调|高估|安全边际/.test(text)) return "PE/PB、股价相对合理价值区间、成交量";
  return "营业收入同比、扣非净利润、经营现金流";
}

function isMeaningfulValuationScenario(item: Record<string, unknown>) {
  return [item.name, item.assumptions, item.value, item.expectedReturn, item.probability].filter((value) => !isPlaceholderText(value)).length >= 2;
}

function isMeaningfulRiskMatrixItem(item: Record<string, unknown>) {
  return !isPlaceholderText(item.risk);
}

function meaningfulOptionalString(value: unknown) {
  return isPlaceholderText(value) ? undefined : optionalString(value);
}

function isPlaceholderText(value: unknown) {
  const text = optionalString(value)?.trim();
  if (!text) return true;
  return (
    text === "待验证" ||
    text === "待验证观察" ||
    text === "数据不足" ||
    text === "无法计算" ||
    text === "不可用" ||
    text === "无" ||
    text === "N/A" ||
    text === "-" ||
    text === "未分类风险" ||
    text.startsWith("未命名")
  );
}

function normalizeAccountRules(value: unknown, cqs: number, decision: DerivedInvestmentDecision): AccountRules {
  const raw = isRecord(value) ? value : {};
  return {
    companyGrade: companyGradeFromCqs(cqs),
    maxPosition: decision.positionAdvice,
    addCondition: optionalString(raw.addCondition) ?? "基本面未恶化且估值更有吸引力时再考虑。",
    reduceCondition: optionalString(raw.reduceCondition) ?? "估值明显偏高、基本面恶化或风险暴露时减仓。",
    reviewTiming: optionalString(raw.reviewTiming) ?? "下一次财报或重大公告后复盘。",
  };
}

function deriveInvestmentDecision(
  value: unknown,
  cqs: number,
  ias: number,
  redFlags: RedFlag[],
  valuationAnalysis: ValuationAnalysis,
): DerivedInvestmentDecision {
  const criticalRedFlag = redFlags.some((flag) => flag.severity === "critical" || flag.cap <= 30);
  if (criticalRedFlag || ias <= 30) return { conclusion: "回避", positionAdvice: "0%" };
  if (ias <= 40) return { conclusion: "回避", positionAdvice: "0%" };
  if (ias <= 50) return { conclusion: "观察", positionAdvice: "0-3% 观察上限" };

  const valuationView = deriveValuationView(valuationAnalysis);
  const priceAvailable = hasReliableCurrentPrice(valuationAnalysis.currentPrice);
  if (!priceAvailable) return { conclusion: "观察", positionAdvice: "观察仓（报价缺失，暂不建仓）" };

  if (ias > 85 && cqs > 85 && valuationView === "低估") return { conclusion: "加仓", positionAdvice: "15-20% 上限" };
  if (ias >= 76 && cqs >= 70 && (valuationView === "低估" || valuationView === "合理偏低")) {
    return { conclusion: "买入", positionAdvice: "标准仓 8-15%" };
  }
  if (ias >= 66 && cqs >= 70 && (valuationView === "低估" || valuationView === "合理偏低" || valuationView === "合理")) {
    return { conclusion: "持有", positionAdvice: "小仓 3-8%" };
  }
  if (ias >= 51) return { conclusion: "观察", positionAdvice: "观察仓" };

  return { conclusion: normalizeModelConclusion(value), positionAdvice: "观察仓" };
}

function normalizeModelConclusion(value: unknown): InvestmentReport["conclusion"] {
  const allowed: InvestmentReport["conclusion"][] = ["买入", "加仓", "持有", "观察", "减仓", "卖出", "回避"];
  return allowed.includes(value as InvestmentReport["conclusion"]) ? (value as InvestmentReport["conclusion"]) : "观察";
}

function hasReliableCurrentPrice(value: string) {
  if (parseFirstNumber(value) === undefined) return false;
  return !/数据不足|待验证|不可用|缺失|无法|未获取|假设|估算|推算/.test(value);
}

function summarizeItems(items: ScoreItem[]) {
  const strongest = items
    .filter((item) => item.score >= 70)
    .map((item) => item.title)
    .slice(0, 2)
    .join("、");
  const weakest = items
    .filter((item) => item.score < 50)
    .map((item) => item.title)
    .slice(0, 2)
    .join("、");
  if (strongest && weakest) return `优势在${strongest}，主要扣分来自${weakest}。`;
  if (strongest) return `相对优势在${strongest}。`;
  if (weakest) return `主要扣分来自${weakest}。`;
  return "整体表现中性，仍需更多证据验证。";
}

function sectionText(value: unknown, companyName: string, sectionName: string) {
  return isNonEmptyString(value) ? value : fallbackText(companyName, sectionName);
}

function fallbackText(companyName: string, sectionName: string) {
  return `数据不足：${companyName} 的「${sectionName}」未获得足够可靠证据或模型未按模板提供完整内容，需要继续人工复核。`;
}

function clampScore(value: unknown) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return roundScore(Math.max(0, Math.min(100, number)));
}

function normalizeModelScore(value: unknown, scoreScale: ScoreScale) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return clampScore(number * scoreScale);
}

function roundScore(value: number) {
  return Math.round(value * 100) / 100;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function companyGradeFromCqs(cqs: number) {
  if (cqs >= 86) return `A+（卓越复合成长股，CQS ${formatScoreForGrade(cqs)}）`;
  if (cqs >= 70) return `A（优质公司，CQS ${formatScoreForGrade(cqs)}）`;
  if (cqs >= 50) return `B（中规中矩，CQS ${formatScoreForGrade(cqs)}）`;
  if (cqs >= 31) return `C（平庸，CQS ${formatScoreForGrade(cqs)}）`;
  return `D（高风险，CQS ${formatScoreForGrade(cqs)}）`;
}

function formatScoreForGrade(score: number) {
  return score.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function isSameCompanyIdentity(a: CompanyIdentity, b: CompanyIdentity) {
  const aTicker = normalizeIdentityText(a.ticker);
  const bTicker = normalizeIdentityText(b.ticker);
  if (aTicker && bTicker && aTicker === bTicker) return true;

  const aName = normalizeIdentityText(a.name);
  const bName = normalizeIdentityText(b.name);
  return Boolean(aName && bName && aName === bName);
}

function normalizeIdentityText(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function optionalString(value: unknown) {
  return isNonEmptyString(value) ? value : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isNonEmptyString).map(String) : [];
}

function cleanScoreDetailText(value: unknown) {
  return isPlaceholderScoreDetailText(value) ? "" : String(value);
}

function isPlaceholderScoreDetailText(value: unknown) {
  if (!isNonEmptyString(value)) return true;
  return /未提供最近 12 个月变化判断|需在后续复核中补充更细的扣分依据|数据不足：模型未提供该项完整评分理由|待验证|(?:数据|资料|信息|证据)(?:不足|不充分|不完整)/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
