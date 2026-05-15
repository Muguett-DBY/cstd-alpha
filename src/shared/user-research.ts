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

export type ResearchTemplate = {
  id: string;
  title: string;
  shortTitle: string;
  focus: string;
  prompt: string;
  fullPrompt: string;
};

export type TemplateAnalysisStatus = "pending" | "running" | "completed" | "failed_retryable" | "failed";

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
};

export const FULL_ANALYSIS_TEMPLATE_ID = "full";
export const TEMPLATE_MARKDOWN_MIN_CHARS = 3500;
export const FULL_ANALYSIS_MARKDOWN_MIN_CHARS = 5000;

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
];

export function researchTemplateById(templateId: string) {
  return RESEARCH_TEMPLATES.find((template) => template.id === templateId);
}

export function isRetryableTemplateStatus(status: TemplateAnalysisStatus) {
  return status === "failed_retryable";
}

export function minimumResearchMarkdownChars(templateId: string) {
  return templateId === FULL_ANALYSIS_TEMPLATE_ID ? FULL_ANALYSIS_MARKDOWN_MIN_CHARS : TEMPLATE_MARKDOWN_MIN_CHARS;
}

export function completedTemplateAnalysesForFull(analyses: TemplateAnalysisResult[]) {
  const completedByTemplate = new Map(
    analyses.filter((analysis) => analysis.status === "completed").map((analysis) => [analysis.templateId, analysis]),
  );
  return RESEARCH_TEMPLATES.map((template) => completedByTemplate.get(template.id)).filter((analysis): analysis is TemplateAnalysisResult => Boolean(analysis));
}

export function missingTemplateIdsForFull(analyses: TemplateAnalysisResult[]) {
  const completedIds = new Set(completedTemplateAnalysesForFull(analyses).map((analysis) => analysis.templateId));
  return RESEARCH_TEMPLATES.map((template) => template.id).filter((templateId) => !completedIds.has(templateId));
}

export function isFullAnalysisReady(analyses: TemplateAnalysisResult[]) {
  return missingTemplateIdsForFull(analyses).length === 0;
}
