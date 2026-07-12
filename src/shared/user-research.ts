import type { CompanyCandidate } from "./report";
import { FULL_TEMPLATE_PROMPTS } from "./research-template-source";

export type UserSession = {
  userId: string;
  username: string;
  displayName: string;
  role: string;
};

export type WatchlistItem = {
  id: string;
  userId: string;
  company: CompanyCandidate;
  reportLibraryId?: string;
  addedAt: string;
};

export type WatchlistAddStatus = "created" | "updated";

export type WatchlistAddResult = {
  item: WatchlistItem;
  status: WatchlistAddStatus;
};

export type WatchlistRankingStatus = "pending" | "running" | "completed" | "failed_retryable" | "failed";

export type WatchlistRankingEntry = {
  id?: string;
  watchlistId: string;
  companyName: string;
  ticker: string;
  market: string;
  listingPlace?: string;
  status: WatchlistRankingStatus;
  companyQualityScore?: number;
  investmentAttractivenessScore?: number;
  overallScore?: number;
  verdict?: string;
  summary?: string;
  keyPoints: string[];
  riskFlags: string[];
  evidenceHash?: string;
  updatedAt?: string;
  errorMessage?: string;
};

export type ResearchTemplate = {
  id: string;
  title: string;
  shortTitle: string;
  focus: string;
  prompt: string;
  fullPrompt: string;
  sectionRequirements?: TemplateSectionRequirement[];
  enabled?: boolean;
  sortOrder?: number;
  isSystem?: boolean;
  updatedAt?: string;
};

export type ResearchTemplateCompletion = Pick<ResearchTemplate, "title" | "shortTitle" | "focus" | "prompt" | "fullPrompt" | "sectionRequirements">;

export type TemplateSectionRequirement = {
  id: string;
  title: string;
  minChars: number;
  requiredPoints: string[];
};

export type TemplateAnalysisStatus = "pending" | "running" | "completed" | "failed_retryable" | "failed";
export const TEMPLATE_ANALYSIS_STATUSES = ["pending", "running", "completed", "failed_retryable", "failed"] as const;

export type TemplateAnalysisSection = {
  heading: string;
  body: string;
};

export type TemplateAnalysisResult = {
  id: string;
  userId: string;
  watchlistId: string;
  templateId: string;
  templateTitle: string;
  companyName: string;
  ticker: string;
  market: string;
  model: string;
  status: TemplateAnalysisStatus;
  title: string;
  score?: number;
  verdict: string;
  summary: string;
  markdown?: string;
  objectKey?: string;
  errorMessage?: string;
  keyPoints: string[];
  riskFlags: string[];
  followUps: string[];
  sections: TemplateAnalysisSection[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  fromCache?: boolean;
  templateHash?: string;
  evidenceHash?: string;
  templateSnapshot?: ResearchTemplate;
};

export const FULL_ANALYSIS_TEMPLATE_ID = "full";
export const TEMPLATE_MARKDOWN_MIN_CHARS = 3500;
export const FULL_ANALYSIS_MARKDOWN_MIN_CHARS = 5000;
export const DEFAULT_TEMPLATE_SECTION_MIN_CHARS = 180;
export const TEMPLATE_SECTION_MIN_CHARS_FLOOR = 80;
export const TEMPLATE_SECTION_MIN_CHARS_CEILING = 800;
export const TEMPLATE_SECTION_REQUIREMENTS_LIMIT = 24;
export const TEMPLATE_SECTION_REQUIRED_POINTS_LIMIT = 8;
export const TEMPLATE_SECTION_REQUIRED_POINTS_INPUT_LIMIT = 32;
export const TEMPLATE_SECTION_REQUIRED_POINT_MAX_CHARS = 120;
export const DEFAULT_TEMPLATE_REQUIRED_POINTS = ["结论", "证据依据", "反证条件", "跟踪指标"] as const;

export const RESEARCH_TEMPLATES: ResearchTemplate[] = [
  {
    id: "template-01-company-value",
    title: "模板01：公司价值分析",
    shortTitle: "公司价值",
    focus: "用严格百分制从生命周期、成长、商业模式、财务健康、产业环境、治理、护城河、估值和小股东长期回报等角度综合评分。",
    fullPrompt: FULL_TEMPLATE_PROMPTS["01"],
    prompt:
      "按公司价值分析模板输出：先给综合评分区间和具体分数，再逐项讨论生命周期、成长潜力、收入和扣非利润/自由现金流增长、商业模式、财务风险、产业环境、股东公平、长期竞争优势、公司文化、成本控制、资产轻重、周期性、市场地位、财富积累可能性、奢侈品/顶级科技属性、小股东长期回报、十年历史回报和 DCF/估值判断。",
  },
  {
    id: "template-02-industry-cycle",
    title: "模板02：公司所处细分产业分析",
    shortTitle: "产业周期",
    focus: "判断公司所处细分产业的大周期、小周期、空间、突破点、爆发期和利润爆发潜力。",
    fullPrompt: FULL_TEMPLATE_PROMPTS["02"],
    prompt:
      "按细分产业分析模板输出：定义细分产业，判断产业大周期九阶段和库存/供需小周期四阶段，分析产业空间、突破期、爆发期、利润爆发期、净利润较快增长期，并给出未来收入或净利润爆发式增长潜力百分制评分。",
  },
  {
    id: "template-03-long-term-equity",
    title: "模板03：长期股权投资者重点关注",
    shortTitle: "长期股权",
    focus: "从商业逻辑、产业逻辑、估值逻辑三条主线判断长期股权投资质量。",
    fullPrompt: FULL_TEMPLATE_PROMPTS["03"],
    prompt:
      "按长期股权投资者模板输出：分别分析商业模式、公司文化与治理、核心竞争力；判断产业是爆发型、平稳型还是衰落型；选择合适估值方法判断偏高/合理/偏低；给出三项评分和总评分。",
  },
  {
    id: "template-04-strategy-tactics",
    title: "模板04：投资的战略问题和战术问题",
    shortTitle: "战略战术",
    focus: "判断公司是否属于自由现金流之王、优质股权、困境反转、价值投资或成长型价值投资。",
    fullPrompt: FULL_TEMPLATE_PROMPTS["04"],
    prompt:
      "按投资战略与战术模板输出：从未来自由现金流、长期股权、四个视角、三类优质股权、组合纪律分析战略价值；再从风险投资/困境转型、捡烟头、基本面突变、成长型价值、量化/趋势等战术角度判断适配方式。",
  },
  {
    id: "template-05-integrated-decision",
    title: "模板05：投资哲学、产业赛道、公司质地、估值与决策综合",
    shortTitle: "综合决策",
    focus: "按投资哲学、产业赛道、公司质地、估值与账户决策做带权重的综合判断。",
    fullPrompt: FULL_TEMPLATE_PROMPTS["05"],
    prompt:
      "按综合决策模板输出：检查长期股权投资、能力圈、四个视角和三类优质股权；按产业大周期、小周期、空间格局评估赛道；评估商业模式、护城河、治理和财务质量；结合估值、安全边际、仓位和买卖纪律给出结论。",
  },
  {
    id: "template-06-value-investor-skill",
    title: "模板06：价值投资者的真功夫",
    shortTitle: "识别价值",
    focus: "识别价值、增长和泡沫，重点排查价值陷阱、成长陷阱和耐心要求。",
    fullPrompt: FULL_TEMPLATE_PROMPTS["06"],
    prompt:
      "按价值投资者真功夫模板输出：识别内在价值与伪便宜，排查衰退行业、高杠杆周期底、大存大贷、会计伎俩、管理层变节等价值陷阱；区分扎实增长与增长幻觉；判断泡沫和卖出纪律。",
  },
  {
    id: "template-07-industry-scan",
    title: "模板07：当今所有细分产业及公司扫描",
    shortTitle: "产业扫描",
    focus: "把公司放进当前产业全景，比较扎实增长、泡沫、增长启动和衰退产业中的位置。",
    fullPrompt: FULL_TEMPLATE_PROMPTS["07"],
    prompt:
      "按产业扫描模板输出：讨论当前扎实增长产业、增长可持续性、高增长陷阱与泡沫风险、即将进入增长期的产业和公司、衰退产业识别、代表性公司清单，并给出该公司的专项定位。",
  },
  {
    id: "template-08-one-to-n",
    title: "模板08：投资是“1到N”的公司长期叙事",
    shortTitle: "1到N叙事",
    focus: "判断公司能否存续 40 年、未来成长潜力、商业模式护城河、治理、估值和高低增长/泡沫状态。",
    fullPrompt: FULL_TEMPLATE_PROMPTS["08"],
    prompt:
      "按 1 到 N 长期叙事模板输出：分析公司能否存续 40 年、未来成长空间、商业模式和护城河、文化与治理、当前价值与估值、公司及股价状态，判断属于低增长/高增长和有无泡沫。",
  },
  {
    id: "template-09-moat-margin-circle",
    title: "模板09：护城河、安全边际、能力圈与三大长期投资陷阱",
    shortTitle: "护城河陷阱",
    focus: "用护城河、安全边际、能力圈三支点，同时排查价值陷阱、高增长陷阱和周期陷阱。",
    fullPrompt: FULL_TEMPLATE_PROMPTS["09"],
    prompt:
      "按护城河/安全边际/能力圈模板输出：分析无形资产、转换成本、网络效应、成本优势、规模优势；判断安全边际和最坏情形亏损；界定能力圈；排查价值陷阱、高增长陷阱和周期陷阱。",
  },
  {
    id: "template-10-return-patterns",
    title: "模板10：长期投资者可以期待的五种回报模式",
    shortTitle: "回报模式",
    focus: "把公司归入高分红类固收、成长型股权增值、强周期波段、弱周期困境反转或风险投资标的。",
    fullPrompt: FULL_TEMPLATE_PROMPTS["10"],
    prompt:
      "按五种回报模式模板输出：判断公司更像高分红低增长、成长型股权增值、强周期长波段、弱周期困境反转还是风险投资标的；明确主要回报来源、年化预期区间、核心风险和不投条件。",
  },
  {
    id: "template-11-capital-allocation",
    title: "模板11：资金配置原则与公司配置分析",
    shortTitle: "资金配置",
    focus: "根据产业配置方向、获利模式、机会大小、风险大小、估值状态和红线条件，给出公司配置等级与仓位建议。",
    fullPrompt: `# 第十一模板：资金配置原则与公司配置分析模板

## 资金配置的原则

### 1. 根据产业（细分产业）配置

重点配置以下三大类：

1. 极佳商业模式类；
2. 顶级科技公司类，即拥有创造力强的科学家团队的公司；
3. 优秀自然资源类。

### 2. 根据获利模式配置

对长期投资者而言，重要的五种获利模式分别是：

1. 平稳产业里能够长期稳定分红的公司；
2. 具有超长期增长潜力的公司，即长坡厚雪型公司；
3. 强周期性产业公司之长波段操作；
4. 弱周期性产业公司之困境反转；
5. 具有风险投资标的属性的公司。

通常情况下，应以具有超长期增长潜力的公司为主要配置方向。

### 3. 根据机会大小配置

对已经出现的五种获利模式机会进行比较：

- 确定性越强，配置比例越高；
- 获利空间越大，配置比例越高；
- 确定性强且获利空间大的机会，应重点配置；
- 确定性弱或获利空间有限的机会，应谨慎配置。

### 4. 根据风险大小配置

风险点多的少配，风险点少的多配。

对长期投资者而言，有两个坚决不能投的红线：

1. **产业红线**：根据产业大的生命周期，即初创期、成长期、成熟期、衰落期进行判断。如果公司所处细分产业已经处于衰落期，或者有明确证据证明即将进入衰落期，坚决不能投。
2. **公司经营红线**：如果公司长期管理混乱、经营不善，导致业绩持续低迷甚至下滑，坚决不能投。

### 5. 根据估值配置

以估值合理作为重要参考标准：

- 估值合理时，可以正常配置；
- 严重低估时，可以适量多配；
- 明显高估时，应降低配置比例或暂缓配置；
- 估值泡沫严重时，应考虑回避或减仓。

---

## 分析任务

首先，根据以上资金配置原则进行系统分析。

另外，请按照以上模板分析（       ）公司。

## 输出要求

分析时应至少包括以下内容：

1. 该公司属于哪一类产业配置方向：极佳商业模式类、顶级科技公司类、优秀自然资源类，或其他类型；
2. 该公司更符合哪一种获利模式：高分红低增长、长坡厚雪成长、强周期长波段、弱周期困境反转、风险投资标的；
3. 当前机会大小：确定性、获利空间、长期回报潜力；
4. 当前风险大小：产业风险、经营风险、财务风险、治理风险、估值风险；
5. 是否触碰两个不能投红线：产业衰退红线、长期经营恶化红线；
6. 当前估值是否合理、偏低、偏高或存在泡沫；
7. 建议配置等级：重配、适度配置、观察、回避；
8. 适合的仓位建议与理由；
9. 需要持续跟踪的关键指标；
10. 最终结论。`,
    prompt:
      "按资金配置原则模板输出：判断产业配置方向、五种获利模式、机会大小、风险大小、两条不能投红线、估值状态、建议配置等级、仓位建议、持续跟踪指标和最终结论。",
  },
];

export function researchTemplateById(templateId: string) {
  return RESEARCH_TEMPLATES.find((template) => template.id === templateId);
}

export function isRetryableTemplateStatus(status: TemplateAnalysisStatus) {
  return status === "failed_retryable";
}

export function isTemplateAnalysisStatus(value: unknown): value is TemplateAnalysisStatus {
  return typeof value === "string" && TEMPLATE_ANALYSIS_STATUSES.includes(value as TemplateAnalysisStatus);
}

export function isTemplateSectionRequirement(value: unknown): value is TemplateSectionRequirement {
  if (!isRecord(value)) return false;
  return (
    nonEmptyString(value.id) &&
    nonEmptyString(value.title) &&
    finiteNumber(value.minChars) !== undefined &&
    isStringArray(value.requiredPoints)
  );
}

export function isResearchTemplateCompletion(value: unknown): value is ResearchTemplateCompletion {
  if (!isRecord(value)) return false;
  return (
    nonEmptyString(value.title) &&
    nonEmptyString(value.shortTitle) &&
    typeof value.focus === "string" &&
    nonEmptyString(value.prompt) &&
    nonEmptyString(value.fullPrompt) &&
    (value.sectionRequirements === undefined || (Array.isArray(value.sectionRequirements) && value.sectionRequirements.every(isTemplateSectionRequirement)))
  );
}

export function isResearchTemplate(value: unknown): value is ResearchTemplate {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.id) || !isResearchTemplateCompletion(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.enabled === undefined || typeof record.enabled === "boolean") &&
    (record.sortOrder === undefined || finiteNumber(record.sortOrder) !== undefined) &&
    (record.isSystem === undefined || typeof record.isSystem === "boolean") &&
    (record.updatedAt === undefined || typeof record.updatedAt === "string")
  );
}

export function isTemplateAnalysisSection(value: unknown): value is TemplateAnalysisSection {
  if (!isRecord(value)) return false;
  return typeof value.heading === "string" && typeof value.body === "string";
}

export function isTemplateAnalysisResult(value: unknown): value is TemplateAnalysisResult {
  if (!isRecord(value)) return false;
  return (
    nonEmptyString(value.id) &&
    nonEmptyString(value.userId) &&
    nonEmptyString(value.watchlistId) &&
    nonEmptyString(value.templateId) &&
    nonEmptyString(value.templateTitle) &&
    nonEmptyString(value.companyName) &&
    typeof value.ticker === "string" &&
    typeof value.market === "string" &&
    typeof value.model === "string" &&
    isTemplateAnalysisStatus(value.status) &&
    typeof value.title === "string" &&
    (value.score === undefined || finiteNumber(value.score) !== undefined) &&
    typeof value.verdict === "string" &&
    typeof value.summary === "string" &&
    (value.markdown === undefined || typeof value.markdown === "string") &&
    (value.objectKey === undefined || typeof value.objectKey === "string") &&
    (value.errorMessage === undefined || typeof value.errorMessage === "string") &&
    isStringArray(value.keyPoints) &&
    isStringArray(value.riskFlags) &&
    isStringArray(value.followUps) &&
    Array.isArray(value.sections) &&
    value.sections.every(isTemplateAnalysisSection) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.startedAt === undefined || typeof value.startedAt === "string") &&
    (value.completedAt === undefined || typeof value.completedAt === "string") &&
    (value.fromCache === undefined || typeof value.fromCache === "boolean") &&
    (value.templateHash === undefined || typeof value.templateHash === "string") &&
    (value.evidenceHash === undefined || typeof value.evidenceHash === "string") &&
    (value.templateSnapshot === undefined || isResearchTemplate(value.templateSnapshot))
  );
}

export type TemplateResearchDataHealthNotice = {
  title: string;
  detail: string;
  actionLabel: string;
};

export function describeTemplateResearchDataHealth(
  skippedAnalyses: number | undefined,
  skippedTemplates: number | undefined,
  availableAnalyses: number,
  availableTemplates: number,
): TemplateResearchDataHealthNotice | null {
  const skippedAnalysisCount = safeCount(skippedAnalyses);
  const skippedTemplateCount = safeCount(skippedTemplates);
  const skippedTotal = skippedAnalysisCount + skippedTemplateCount;
  if (!skippedTotal) return null;
  const parts = [
    skippedAnalysisCount ? `${skippedAnalysisCount} 条模板报告` : "",
    skippedTemplateCount ? `${skippedTemplateCount} 个模板` : "",
  ].filter(Boolean).join("、");
  return {
    title: `模板研究已跳过 ${skippedTotal} 条异常记录`,
    detail: `异常范围：${parts}。本次保留 ${availableAnalyses} 条可用模板报告、${availableTemplates} 个可用模板；源数据未被修改，可重新读取检查是否已恢复。`,
    actionLabel: "重新读取",
  };
}

export function minimumResearchMarkdownChars(templateId: string) {
  return templateId === FULL_ANALYSIS_TEMPLATE_ID ? FULL_ANALYSIS_MARKDOWN_MIN_CHARS : TEMPLATE_MARKDOWN_MIN_CHARS;
}

export function normalizeTemplateSectionRequirements(template: Pick<ResearchTemplate, "title" | "fullPrompt" | "sectionRequirements">): TemplateSectionRequirement[] {
  const explicit = Array.isArray(template.sectionRequirements)
    ? template.sectionRequirements
        .slice(0, TEMPLATE_SECTION_REQUIREMENTS_LIMIT)
        .map((item, index) => normalizeTemplateSectionRequirement(item, index))
        .filter((item): item is TemplateSectionRequirement => Boolean(item))
    : [];
  if (explicit.length) return explicit;
  return deriveTemplateSectionRequirements(template.fullPrompt || template.title || "模板分析");
}

function normalizeTemplateSectionRequirement(value: Partial<TemplateSectionRequirement> | undefined, index: number) {
  const title = stringValue(value?.title) || `第 ${index + 1} 项`;
  const id = normalizeTemplateRequirementId(value?.id) || `section-${index + 1}`;
  const minChars = clampNumber(value?.minChars, TEMPLATE_SECTION_MIN_CHARS_FLOOR, TEMPLATE_SECTION_MIN_CHARS_CEILING, DEFAULT_TEMPLATE_SECTION_MIN_CHARS);
  const requiredPoints = normalizeRequiredPoints(value?.requiredPoints);
  return { id, title: title.slice(0, 80), minChars, requiredPoints };
}

function deriveTemplateSectionRequirements(fullPrompt: string) {
  const lines = fullPrompt.split(/\r?\n/).map((line) => line.trim());
  const titles: string[] = [];
  const headingPattern = /^(?:#{1,4}\s*)?(?:(?:\d{1,2}|[一二三四五六七八九十]{1,3})[.、．:：]\s*|第[一二三四五六七八九十]{1,3}(?:部分|项|条|模板)?[.、．:：]?\s*)(.{3,80})$/;
  for (const line of lines) {
    const normalized = line.replace(/\*\*/g, "").trim();
    const match = normalized.match(headingPattern);
    if (!match) continue;
    const title = match[1].replace(/[`#*_>-]/g, "").trim();
    if (!title || /输出要求|分析任务|请按照|最终结论/.test(title)) continue;
    if (!titles.includes(title)) titles.push(title);
    if (titles.length >= 12) break;
  }
  const picked = titles.length ? titles : ["完整模板分析"];
  return picked.map((title, index) => ({
    id: `section-${index + 1}`,
    title: title.slice(0, 80),
    minChars: DEFAULT_TEMPLATE_SECTION_MIN_CHARS,
    requiredPoints: [...DEFAULT_TEMPLATE_REQUIRED_POINTS],
  }));
}

function normalizeRequiredPoints(value: unknown) {
  const points = Array.isArray(value)
    ? value
        .slice(0, TEMPLATE_SECTION_REQUIRED_POINTS_INPUT_LIMIT)
        .map((item) => stringValue(item).slice(0, TEMPLATE_SECTION_REQUIRED_POINT_MAX_CHARS))
        .filter(Boolean)
    : [];
  return Array.from(new Set([...DEFAULT_TEMPLATE_REQUIRED_POINTS, ...points])).slice(0, TEMPLATE_SECTION_REQUIRED_POINTS_LIMIT);
}

function normalizeTemplateRequirementId(value: unknown) {
  const raw = stringValue(value).toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,80}$/.test(raw) ? raw : "";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function activeResearchTemplates(templates: ResearchTemplate[]) {
  return templates.filter((template) => template.enabled !== false);
}

export function completedTemplateAnalysesForFull(analyses: TemplateAnalysisResult[], templates: ResearchTemplate[] = RESEARCH_TEMPLATES) {
  const completedByTemplate = new Map(
    analyses.filter((analysis) => analysis.status === "completed").map((analysis) => [analysis.templateId, analysis]),
  );
  return activeResearchTemplates(templates).map((template) => completedByTemplate.get(template.id)).filter((analysis): analysis is TemplateAnalysisResult => Boolean(analysis));
}

export function missingTemplateIdsForFull(analyses: TemplateAnalysisResult[], templates: ResearchTemplate[] = RESEARCH_TEMPLATES) {
  const completedIds = new Set(completedTemplateAnalysesForFull(analyses, templates).map((analysis) => analysis.templateId));
  return activeResearchTemplates(templates)
    .map((template) => template.id)
    .filter((templateId) => !completedIds.has(templateId));
}

export function isFullAnalysisReady(analyses: TemplateAnalysisResult[], templates: ResearchTemplate[] = RESEARCH_TEMPLATES) {
  return missingTemplateIdsForFull(analyses, templates).length === 0;
}
