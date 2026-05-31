import type { AnySearchEvidence, AnySearchQuery } from "./anysearch";
import type { AssistantMode, AssistantUsage } from "../../src/shared/assistant";

export type AssistantSearchToolName = "search_anysearch" | "search_searxng" | "search_exa" | "search_tavily" | "search_brave" | "search_gdelt" | "search_arxiv" | "search_semantic_scholar";
export type AssistantInternalToolName = "read_company_evidence" | "read_watchlist_ranking" | "read_template_reports" | "read_radar_result" | "read_tushare_indicators" | "python_repl" | "compute_financial" | "compare_stocks" | "read_tencent_quote" | "read_ths_hot_stocks" | "read_ths_consensus_eps" | "read_market_data" | "read_capital_analysis" | "read_filings_news" | "read_financial_statements" | "read_reports_concepts";
export type AssistantToolName = AssistantSearchToolName | AssistantInternalToolName;

export type AssistantSearchToolCall = {
  id: string;
  name: AssistantToolName;
  query?: string;
  code?: string;
  reason?: string;
  freshness?: "day" | "week" | "month" | "year";
  maxResults?: number;
  rawArgs?: Record<string, unknown>;
};

export type ExternalEvidenceResult = {
  triggered: boolean;
  query?: string;
  items: AnySearchEvidence[];
  exa: { used: boolean; count: number; reason?: string; dailyCount?: number };
  routerUsage?: AssistantUsage;
  toolCalls?: AssistantSearchToolCall[];
  toolSummary?: string;
};

export const A_STOCK_TOOL_NAMES = new Set<AssistantToolName>(["read_tencent_quote", "read_ths_hot_stocks", "read_ths_consensus_eps", "read_market_data", "read_capital_analysis", "read_filings_news", "read_financial_statements", "read_reports_concepts", "compare_stocks"]);

export const COMMON_FINANCIAL_ACRONYMS = new Set(["ROE", "ROIC", "FCF", "DCF", "EPS", "PE", "PB", "PS", "PEG", "EBIT", "EBITDA", "CAPEX", "OPEX", "WACC", "CAGR", "TAM", "GDP", "CPI", "PMI", "IPO", "ETF", "REIT"]);

export const ASSISTANT_EXA_DAILY_AUTO_LIMIT = 80;
export const ASSISTANT_AGENT_MAX_ROUNDS = 6;
export const ASSISTANT_AGENT_MAX_TOOLS_PER_ROUND = 5;
export const ASSISTANT_AGENT_MAX_MS = 90_000;
export const PYTHON_REPL_POLL_TIMEOUT_MS = 90_000;
export const PYTHON_REPL_POLL_INTERVAL_MS = 3_000;

export function isAssistantToolName(name: string): name is AssistantToolName {
  return (
    name === "search_anysearch" || name === "search_searxng" || name === "search_exa" || name === "search_tavily" || name === "search_brave" || name === "search_gdelt" || name === "search_arxiv" || name === "search_semantic_scholar" ||
    name === "read_company_evidence" || name === "read_watchlist_ranking" || name === "read_template_reports" || name === "read_radar_result" || name === "read_tushare_indicators" ||
    name === "python_repl" || name === "compute_financial" || name === "compare_stocks" ||
    name === "read_tencent_quote" || name === "read_ths_hot_stocks" || name === "read_ths_consensus_eps" ||
    name === "read_market_data" || name === "read_capital_analysis" || name === "read_filings_news" || name === "read_financial_statements" || name === "read_reports_concepts"
  );
}

export function internalToolLabel(name: AssistantToolName) {
  const labels: Record<string, string> = {
    read_company_evidence: "公司证据包",
    read_watchlist_ranking: "自选股排行",
    read_template_reports: "模板报告",
    read_radar_result: "行业雷达",
    read_tushare_indicators: "A股结构化指标",
    python_repl: "Python 计算",
    compute_financial: "金融计算",
    compare_stocks: "横向对比",
    read_tencent_quote: "实时行情",
    read_ths_hot_stocks: "同花顺热点题材",
    read_ths_consensus_eps: "同花顺一致预期",
    read_market_data: "市场数据",
    read_capital_analysis: "资金筹码分析",
    read_filings_news: "公告新闻",
    read_financial_statements: "财务报表",
    read_reports_concepts: "研报概念",
  };
  return labels[name] || "站内证据";
}

export function naturalToolStatusLabel(call: AssistantSearchToolCall) {
  if (call.name.startsWith("read_")) return `正在读取${internalToolLabel(call.name)}...`;
  if (call.name === "python_repl") return "正在用 Python 计算...";
  if (call.name === "compute_financial") return "正在执行金融计算...";
  if (call.name === "compare_stocks") return "正在横向对比...";
  if (call.name === "search_arxiv" || call.name === "search_semantic_scholar") return "正在查技术和论文线索...";
  if (call.name === "search_gdelt") return "正在查全球新闻和风险线索...";
  return `正在查${(call.query ?? "").slice(0, 32)}...`;
}

export function summarizeToolResult(call: AssistantSearchToolCall, evidenceCount: number) {
  if (call.name.startsWith("read_")) return `${internalToolLabel(call.name)}已读取，形成 ${evidenceCount} 条可用摘要。`;
  if (call.name === "python_repl") return "Python 计算完成，结果已并入上下文。";
  if (call.name === "compute_financial") return "金融计算完成，结果已并入上下文。";
  return evidenceCount ? `已找到 ${evidenceCount} 条相关线索。` : "这个来源没有返回可用线索。";
}

export function assistantToolRunSummary(externalEvidence: ExternalEvidenceResult) {
  if (!externalEvidence.triggered) return `模型工具路由判断无需外部搜索。${externalEvidence.exa.reason ? ` ${externalEvidence.exa.reason}。` : ""}`;
  const base = externalEvidence.toolSummary || `外部搜索返回 ${externalEvidence.items.length} 条，已并入助手上下文。`;
  if (externalEvidence.exa.used) return base;
  if (externalEvidence.exa.reason) return `${base} Exa未用：${externalEvidence.exa.reason}。`;
  return base;
}

export function assistantSearchTools() {
  const parameters = {
    type: "object" as const,
    required: ["query"],
    properties: {
      query: { type: "string" as const, description: "具体搜索查询，包含研究对象、年份/最新口径和关键指标。" },
      reason: { type: "string" as const, description: "为什么需要这个搜索。" },
      freshness: { type: "string" as const, enum: ["day", "week", "month", "year"], description: "证据新鲜度，默认 month。" },
      maxResults: { type: "number" as const, description: "返回结果上限，1-10。" },
    },
  };
  return [
    { type: "function" as const, function: { name: "search_anysearch" as const, description: "中文财经、公司公告、行业变化、政策风险的高质量搜索。", parameters } },
    { type: "function" as const, function: { name: "search_searxng" as const, description: "免费元搜索补充召回，用于发现新闻、网页和遗漏来源。", parameters } },
    { type: "function" as const, function: { name: "search_brave" as const, description: "Brave Search 独立网页索引，适合补充通用网页、新闻、官方页面和遗漏来源。", parameters } },
    { type: "function" as const, function: { name: "search_tavily" as const, description: "Tavily AI 搜索，适合快速补充财经网页摘要、新闻线索和跨来源投研证据。", parameters } },
    { type: "function" as const, function: { name: "search_gdelt" as const, description: "免费 GDELT 全球新闻搜索，用于补充海外、政策、风险、产业链新闻线索。", parameters } },
    { type: "function" as const, function: { name: "search_arxiv" as const, description: "免费 arXiv 学术论文搜索，用于技术路线、机器人、AI、半导体、控制算法等学术线索。", parameters } },
    { type: "function" as const, function: { name: "search_semantic_scholar" as const, description: "免费 Semantic Scholar 学术搜索，用于技术/论文/专利前沿的补充线索。", parameters } },
    { type: "function" as const, function: { name: "search_exa" as const, description: "高价值外部检索，适合全球/英文/技术/产业链/深度研究线索。", parameters } },
  ];
}

export function assistantAgentTools() {
  const nameConfigs: Array<{ name: AssistantInternalToolName; description: string }> = [
    { name: "read_company_evidence", description: "读取公司站内证据包（财务数据、评分、历史分析）。当用户询问某公司基本面、自选股评分、或需要查已有投研证据时使用。" },
    { name: "read_watchlist_ranking", description: "读取自选股排行评分。当用户需要查看自选股列表、排名对比、评分排序时使用。" },
    { name: "read_template_reports", description: "读取模板分析报告。当用户需要查看已有标的/行业模板报告时使用。" },
    { name: "read_radar_result", description: "读取行业雷达结果。当用户需要行业全景扫描、雷达图、行业主题结论时使用。" },
    { name: "read_tushare_indicators", description: "读取A股结构化指标（Tushare数据）。当需要A股的PE、PB、ROE、营收、利润等结构化财务指标时使用。" },
  ];
  return [
    ...assistantSearchTools(),
    ...nameConfigs.map(({ name, description }) => ({
      type: "function" as const,
      function: {
        name,
        description,
        parameters: { type: "object" as const, required: ["query"], properties: { query: { type: "string" as const, description: "要读取的公司、行业、主题或指标口径。" }, reason: { type: "string" as const, description: "为什么需要这个站内工具。" } } },
      },
    })),
    {
      type: "function" as const, function: {
        name: "read_tencent_quote" as const,
        description: "A股/港股/指数/ETF实时行情数据，包括当前价、PE(TTM)、PB、总市值、换手率、涨停价、跌停价。一次最多查5只。支持A股代码(600519)、港股代码(00700.HK或0700)、指数(000001上证、000300沪深300、399006创业板)、ETF(510050)。",
        parameters: { type: "object" as const, required: ["query"], properties: { query: { type: "string" as const, description: "股票代码或名称，多个用逗号分隔。例：600519,000858" }, reason: { type: "string" as const, description: "为什么需要查询实时行情。" } } },
      },
    },
    {
      type: "function" as const, function: {
        name: "compare_stocks" as const,
        description: "横向对比多只股票的实时估值数据。返回并排对比表，包含现价、涨跌幅、PE、PB、市值、换手率。支持A股、港股、指数。",
        parameters: { type: "object" as const, required: ["query"], properties: { query: { type: "string" as const, description: "股票代码列表，逗号分隔。例：600519,000858,00700.HK" }, reason: { type: "string" as const, description: "为什么需要对比。" } } },
      },
    },
    {
      type: "function" as const, function: {
        name: "read_ths_hot_stocks" as const,
        description: "同花顺当日强势股和题材归因。返回今日走强股票名单及每只股票的题材标签（reason tags，如算力租赁+AI政务）。",
        parameters: { type: "object" as const, required: ["query"], properties: { query: { type: "string" as const, description: "固定填 today 即可。" }, reason: { type: "string" as const, description: "为什么需要查热点题材。" } } },
      },
    },
    {
      type: "function" as const, function: {
        name: "read_ths_consensus_eps" as const,
        description: "同花顺机构一致预期EPS。返回未来几年机构预测的每股收益（最小值/均值/最大值）及参与预测的机构数。",
        parameters: { type: "object" as const, required: ["query"], properties: { query: { type: "string" as const, description: "6位股票代码，例如 600519" }, reason: { type: "string" as const, description: "为什么需要一致预期数据。" } } },
      },
    },
    {
      type: "function" as const, function: {
        name: "read_market_data" as const,
        description: "综合市场数据查询。可查：龙虎榜(个股上榜+全市场净买排名)、限售解禁日历、行业板块涨跌排名。输入股票代码或'market'或'industry'。",
        parameters: { type: "object" as const, required: ["query"], properties: { query: { type: "string" as const, description: "股票代码6位、'market'(全市场龙虎榜)、'industry'(行业排名)、'lockup:600519'(解禁)" }, reason: { type: "string" as const } } },
      },
    },
    {
      type: "function" as const, function: {
        name: "read_capital_analysis" as const,
        description: "资金筹码分析。可查：融资融券余额、大宗交易、个股资金流120日、股东户数变化、分红送转历史、北向资金流向。输入股票代码或'northbound'。",
        parameters: { type: "object" as const, required: ["query"], properties: { query: { type: "string" as const, description: "股票代码6位、'northbound'(北向)、'margin:600519'(融资融券)、'block:600519'(大宗)、'fundflow:600519'(资金流)、'holder:600519'(股东户数)、'dividend:600519'(分红)" }, reason: { type: "string" as const } } },
      },
    },
    {
      type: "function" as const, function: {
        name: "read_filings_news" as const,
        description: "公告和新闻查询。可查：巨潮官方公告、东财个股新闻、东财全球财经资讯。输入股票代码或'global'。",
        parameters: { type: "object" as const, required: ["query"], properties: { query: { type: "string" as const, description: "股票代码6位、'global'(全球资讯)" }, reason: { type: "string" as const } } },
      },
    },
    {
      type: "function" as const, function: {
        name: "read_financial_statements" as const,
        description: "财务报表查询。返回新浪财经三表(资产负债表/利润表/现金流量表)和东财个股基本信息。",
        parameters: { type: "object" as const, required: ["query"], properties: { query: { type: "string" as const, description: "6位股票代码" }, reason: { type: "string" as const } } },
      },
    },
    {
      type: "function" as const, function: {
        name: "read_reports_concepts" as const,
        description: "研报和概念板块查询。可查：东财研报列表(含评级+预测EPS)、百度概念板块归属、百度K线(带MA5/10/20)。",
        parameters: { type: "object" as const, required: ["query"], properties: { query: { type: "string" as const, description: "股票代码6位, 或 'kline:688017'(K线)" }, reason: { type: "string" as const } } },
      },
    },
    {
      type: "function" as const, function: {
        name: "python_repl" as const,
        description: "用 Python 执行数学计算、统计、数据分析和图表绘制。当你需要精确计算（CAGR、估值、回归、指标计算等）或画图（柱状图、折线图、散点图等）时使用。把计算逻辑写完整、自包含的 Python 代码。",
        parameters: { type: "object" as const, required: ["code", "reason"], properties: { code: { type: "string" as const, description: "完整自包含的 Python 代码，使用 print() 输出结果。支持 numpy、pandas、matplotlib。" }, reason: { type: "string" as const, description: "为什么需要 Python 计算。" } } },
      },
    },
    {
      type: "function" as const, function: {
        name: "compute_financial" as const,
        description: "用服务端 TypeScript 直接执行金融计算，无需客户端 Python。支持：cagr（复合年增长率）、dcf（估值）、stats（描述性统计）、ratios（财务比率）、technical（技术指标RSI/MACD/布林带/均线）。DCF 的 discountRate 和 terminalGrowthRate 可使用 10 或 0.10 表示 10%。结果自动保留在上下文中。",
        parameters: { type: "object" as const, required: ["operation", "params", "reason"], properties: { operation: { type: "string" as const, enum: ["cagr", "dcf", "stats", "ratios", "technical"], description: "计算类型" }, params: { type: "object" as const, description: "计算参数" }, reason: { type: "string" as const, description: "为什么需要这个计算。" } } },
      },
    },
  ];
}

export function formatCollectedEvidenceForAgent(items: AnySearchEvidence[]) {
  if (!items.length) return "尚未收集工具证据。";
  return items.slice(0, 16).map((item, index) => `E${index + 1} ${item.title}（${item.source}/${item.sourceType}）：${item.summary}`).join("\n");
}

export function dedupeExternalEvidence(items: AnySearchEvidence[]) {
  const seen = new Set<string>();
  const result: AnySearchEvidence[] = [];
  for (const item of items) {
    const key = item.url || `${item.source}:${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function stringOrFallback(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try { const parsed = JSON.parse(value) as unknown; return isRecord(parsed) ? parsed : {}; } catch { return {}; }
}

export function normalizeComputeToolCall(value: unknown, name: AssistantToolName, args: Record<string, unknown>): AssistantSearchToolCall | null {
  return {
    id: stringOrFallback(isRecord(value) ? value.id : undefined, crypto.randomUUID()),
    name,
    reason: stringOrFallback(args.reason, "").slice(0, 180) || undefined,
    rawArgs: args,
    query: args.operation ? String(args.operation) : undefined,
  };
}

export function normalizeSearchToolCall(value: unknown): AssistantSearchToolCall | null {
  if (!isRecord(value)) return null;
  const fn = isRecord(value.function) ? value.function : {};
  const name = typeof fn.name === "string" ? fn.name : "";
  if (!isAssistantToolName(name)) return null;
  const args = parseToolArguments(fn.arguments);
  const freshness = args.freshness === "day" || args.freshness === "week" || args.freshness === "month" || args.freshness === "year" ? args.freshness : "month";
  const maxResults = typeof args.maxResults === "number" && Number.isFinite(args.maxResults) ? Math.min(Math.max(Math.round(args.maxResults), 1), 10) : undefined;
  if (name === "python_repl") {
    const code = stringOrFallback(args.code, "");
    if (!code) return null;
    return { id: stringOrFallback(value.id, crypto.randomUUID()), name, code, reason: stringOrFallback(args.reason, "").slice(0, 180) || undefined };
  }
  if (name === "compute_financial") return normalizeComputeToolCall(value, name, args);
  const query = stringOrFallback(args.query, "").slice(0, 220);
  if (!query) return null;
  return { id: stringOrFallback(value.id, crypto.randomUUID()), name, query, reason: stringOrFallback(args.reason, "").slice(0, 180) || undefined, freshness, maxResults };
}

export function normalizeSearchToolCalls(data: Record<string, unknown>): AssistantSearchToolCall[] {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return toolCalls.map(normalizeSearchToolCall).filter((call): call is AssistantSearchToolCall => Boolean(call)).slice(0, 5);
}

export function hostLabel(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "unknown"; }
}

export function rowsFromFact(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord).slice(0, 3) : [];
}

export function companyAliases(name: string) {
  const cleaned = name.replace(/股份有限公司|控股有限公司|集团股份|集团|股份|控股|科技|有限|公司|-W|Ｈ股|H股|A股/g, "").trim();
  const aliases = new Set<string>([name, cleaned]);
  if (cleaned.length >= 4) aliases.add(cleaned.slice(-2));
  if (cleaned.length >= 5) aliases.add(cleaned.slice(-3));
  return [...aliases].filter((alias) => !["时代", "科技", "集团", "股份", "公司"].includes(alias));
}

export function isExplicitMemoryOnlyMessage(message: string) {
  const normalized = message.trim();
  return (
    /^(记住|请记住|帮我记住|以后|纠正一下|我的投资框架|我的偏好|我的规则|不要忘了)[:：]/.test(normalized) ||
    /^(记住|请记住|帮我记住|我的投资框架是|我的偏好是|我的规则是|以后评分|以后回答|以后分析|以后遇到|纠正一下)/.test(normalized)
  );
}

export function containsLikelyResearchSubject(message: string) {
  const hasTickerLikeToken = (message.match(/\b[A-Z]{1,5}\b/g) ?? []).some((token) => !COMMON_FINANCIAL_ACRONYMS.has(token.toUpperCase()));
  return hasTickerLikeToken || /\d{5,6}|自选股|茅台|宁德时代|优必选|腾讯|阿里|美团|小米|比亚迪|万科|英伟达|Nvidia|NVDA|苹果|Apple|中芯国际|港交所|紫金矿业|药明康德|泡泡玛特|中远海能|海底捞|拼多多|中国移动|中国电信|中国联通|光伏|白酒|航运|银行|高股息|机器人|AI算力|算力|港股互联网|互联网平台|低空经济|消费电子|地产|半导体|电网|储能|锂电|创新药|CXO|煤炭|水泥|钢铁|铜矿|固态电池|核电/i.test(message);
}

export function isHighValueResearchQuestion(message: string) {
  return /(今年|业绩|预估|预测|净利润|营收|利润|增长|估值|现金流|财报|公告|技术|优势|人形机器人|大脑|小脑|协调|竞争|风险|订单|库存|价格|批价|行业|公司|股票|自选股|质量|证据强度|对比表|能买吗|持有|买入|卖出|最值得|一只|单票|梭哈|翻倍|预算|影响|周期|反转|修复|出清|到底|框架|反证|反驳|泡沫|区分|高股息|平稳现金流|产业链|投资价值|AI|硬件|换机|智能驾驶)/.test(message);
}

export function isHighConvictionStockPickingQuestion(message: string) {
  return /(只想买|只买|买一只|一只股票|单票|唯一标的|最值得|最有赔率|最有可能|梭哈|满仓|全仓|翻倍|十倍|10倍|预算|本金|人民币|港币|美元)/.test(message) && /(股票|标的|公司|A股|港股|美股|自选股|买入|买|投|配置|梭哈|翻倍)/.test(message);
}

export function isFollowUpResearchQuestion(message: string) {
  return /(根据现有|继续|那|这个|它|该公司|这家公司|上述|前面|进行预测|预测|预估|怎么看|大脑|小脑|协调)/.test(message);
}

export function shouldIncludeRecentAssistantContext(message: string) {
  if (/(继续|接着|刚才|上次|之前|前面|上述|上面|这个|这些|它|该公司|这家公司|前一个|上一条|你刚才|你上面)/.test(message)) return true;
  return !containsLikelyResearchSubject(message) && isFollowUpResearchQuestion(message);
}

export function inferAssistantEvidenceMode(message: string): AssistantMode {
  if (/(行业|产业|产业链|环节|赛道|板块|半导体|AI算力|算力|光模块|PCB|存储芯片|HBM|光伏|白酒|航运|银行|机器人|创新药|CXO|电网|储能|锂电|水泥|钢铁|铜|地产链|港股互联网)/i.test(message)) return "industry";
  return "target";
}

export function shouldAutoUseResearchEvidence(message: string) {
  return containsLikelyResearchSubject(message) && isHighValueResearchQuestion(message);
}

export function isMandatoryDirectSafetyQuestion(message: string) {
  return /(期权|合约|永续|杠杆|融资|借钱|贷款|百倍币|十倍|下注|一定涨|必涨|稳赚|保证收益|别跟我说风险|避税|税务规划|税压到最低|大胆的合法)/.test(message);
}

export function isGeneralInvestmentFrameworkQuestion(message: string) {
  return /(技术分析|技术指标|买卖点|胜率最高|均线|RSI|MACD|盘口|复盘|回测|策略|交易系统|杠杆ETF|3倍ETF|倍ETF|ETF涨得快|结构化产品|希腊值|Delta|Gamma|Theta|Vega|空投|撸毛|稳定币|MEME|MEME币|NFT|抄底|翻身|降息|汇率|换汇|人民币|澳元|美元|经济衰退|衰退交易|战争风险|地缘|宏观轮动|投资组合|股票|债券|黄金|现金|应急金|生命周期|最大回撤|压力测试|FIRE|退休|贷款|房贷|投资房|消费贷|信用卡债|车贷|债务|跨境资金|跨境配置|税务居民|少交税|现金收入|移民资产|移民前|并购套利|做空机构|管理层|画饼|理财顾问|名额有限|忽略你的规则|满仓|梭哈翻身|人生完了|绕过券商限制|诱导确定性)/i.test(message);
}

export function isBroadInvestmentFrameworkQuestion(message: string) {
  return /(逆向抄底|反共识|最值得.*资产类别|资产类别|便宜.*更便宜|连续涨.*怕错过|怕错过.*追|追进去|追涨|FOMO|高波动成长股|最可能暴涨|十倍股|筛选模型)/i.test(message);
}

export function shouldAnswerDirectlyWithoutClarification(message: string) {
  if (isMandatoryDirectSafetyQuestion(message)) return true;
  if (isGeneralInvestmentFrameworkQuestion(message)) return true;
  if (isBroadInvestmentFrameworkQuestion(message)) return true;
  if (!containsLikelyResearchSubject(message)) return false;
  if (/(反驳|你反驳|根据我的自选股|自选股|排雷|还能涨|还能不能涨|继续涨|会不会涨)/.test(message)) return true;
  if (/(能买吗|买不买|该不该|怎么操作|怎么样\??$|如何操作)/.test(message)) return false;
  return /(今年|业绩|预估|预测|净利润|营收|利润|估值|现金流|财报|风险|技术|优势|人形机器人|大脑|小脑|协调|竞争|订单|库存|价格|批价|行业|影响|周期|反转|修复|出清|到底|框架|反证|反驳|泡沫|区分|平稳现金流|高股息|投资价值|涨跌|上涨|下跌|PE|PB|ROE|EPS|市值|估值多少|PE多少|PB多少)/.test(message);
}

export function shouldTreatAsSimpleGeneralChat(message: string, mode: AssistantMode) {
  if (mode !== "chat") return false;
  if (containsLikelyResearchSubject(message)) return false;
  if (/(最新|联网|查一下|搜索|新闻|今天|刚刚|实时|全球|海外|英文|Exa|深搜)/i.test(message)) return false;
  if (/^(你好|您好|哈喽|hello|hi)([，,。.!！?\s]*(你是|你是谁|你能做什么|介绍一下|是谁|在吗))?[？?！!。.\s]*$/i.test(message.trim())) return true;
  return /(解释|什么是|为什么|区别|用.*句话|一句话|两句话|概念|定义|怎么算|含义|属于|怎么样|分类|组成部分|环节|角色|前景|趋势|展望|做什么|是做什么|什么样|计算|算一下|算|标准差|均值|CAGR|增长率|统计|回归|相关性)/.test(message);
}

export function shouldTriggerExternalEvidence(message: string, mode: AssistantMode, evidenceSummary: string) {
  if (/(最新|联网|查一下|搜索|新闻|今天|刚刚|实时|全球|海外|英文|Exa|深搜)/i.test(message)) return true;
  if (isHighConvictionStockPickingQuestion(message)) return true;
  if (mode !== "chat" && isHighValueResearchQuestion(message)) return true;
  if (shouldAutoUseResearchEvidence(message)) return true;
  return containsLikelyResearchSubject(message) && /(未命中|不足|暂无|缺少|缺|必须依赖|外部搜索|证据包为空|无法)/.test(evidenceSummary) && isHighValueResearchQuestion(message);
}

export function resolveAssistantResearchContext(userMessage: string, recentMessages: Array<{ role: "user" | "assistant"; content: string }>) {
  if (containsLikelyResearchSubject(userMessage)) return { message: userMessage, promptMessage: userMessage };
  if (!isFollowUpResearchQuestion(userMessage)) return { message: userMessage, promptMessage: userMessage };
  const lastUserSubject = [...recentMessages].reverse().find((message) => message.role === "user" && containsLikelyResearchSubject(message.content))?.content;
  if (!lastUserSubject) return { message: userMessage, promptMessage: userMessage };
  return { message: `${lastUserSubject}\n${userMessage}`, promptMessage: `${userMessage}\n\n[对话承接]\n本轮问题延续上一轮研究对象：${lastUserSubject}` };
}

export function formatExternalEvidence(items: AnySearchEvidence[], exa: { used: boolean; count: number; reason?: string }) {
  const exaStatus = exa.used && exa.count === 0 ? "Exa状态：本轮已尝试 Exa，但没有返回可用结果；禁止把其他搜索源说成 Exa。" : "";
  if (!items.length) return exaStatus;
  return [exaStatus, `外部搜索线索（仅用于发现和补充，不是财报/公告/价格/销量硬数据；检索服务不等于原始发布方）：${items.map((item, index) => `E${index + 1} ${item.title}（检索=${item.source}，类型=${item.sourceType}，来源域名=${hostLabel(item.url)}，日期=${item.publishedAt || "unknown"}）：${item.summary}`).join("；")}`].filter(Boolean).join("\n");
}

export function shouldUseExaForAssistant(message: string, mode: AssistantMode, evidenceSummary: string) {
  if (/Exa|exa|深搜|高质量来源|英文来源|全球来源/.test(message)) return { use: true, reason: "用户明确要求高质量外部检索" };
  const highValue = (mode !== "chat" || isHighConvictionStockPickingQuestion(message)) && /(最新|全球|海外|英文|竞争|产业链|政策|监管|风险|财报|估值|对比|数据|订单|库存|价格|出海|海外|今年|业绩|预估|预测|净利润|营收|利润|技术|优势|人形机器人|大脑|小脑|协调|影响|周期|反转|修复|出清|到底|框架|反证|反驳|泡沫|区分|高股息|平稳现金流|投资价值|AI|硬件|换机|智能驾驶|消费电子|光伏|白酒|银行|航运|机器人|低空经济|股票|标的|梭哈|翻倍|单票|最值得)/.test(message);
  const evidenceWeak = /(未命中|不足|暂无|缺少|缺|必须依赖|外部搜索|证据包为空|无法)/.test(evidenceSummary);
  if (highValue && evidenceWeak) return { use: true, reason: "研究问题高价值且站内证据不足" };
  if (highValue) return { use: true, reason: "研究问题高价值，补充Exa外部线索交叉验证" };
  return { use: false, reason: "不是Exa高价值触发场景" };
}

export function shouldUseTavilyForAssistant(message: string, mode: AssistantMode, evidenceSummary: string) {
  if (/Tavily|tavily|联网|搜索|查一下|最新/.test(message)) return true;
  if (!shouldTriggerExternalEvidence(message, mode, evidenceSummary)) return false;
  return /(今年|业绩|预估|预测|净利润|营收|利润|估值|回购|股价|风险|财报|公告|行业|公司|竞争|政策|监管|价格|库存|订单|现金流|港股|美股|A股)/i.test(message);
}

export function shouldUseFreeGlobalSearch(message: string, mode: AssistantMode, evidenceSummary: string) {
  if (mode === "chat" && !/(最新|今年|预测|预估|全球|海外|政策|监管|风险|业绩|财报|行业|公司|技术|竞争|联网|搜索|查一下)/.test(message)) return false;
  return shouldTriggerExternalEvidence(message, mode, evidenceSummary) || /(最新|今年|预测|预估|全球|海外|政策|监管|风险|业绩|财报|行业|公司|技术|竞争|联网|搜索|查一下)/.test(message);
}

export function shouldUseAcademicSearch(message: string) {
  return /(技术|优势|人形机器人|机器人|大脑|小脑|协调|算法|控制|模型|AI|人工智能|芯片|半导体|存储|HBM|光模块|创新药|靶点|临床|专利|论文|学术|材料|固态电池|低空|商业航天)/i.test(message);
}

export function shouldUseKeylessFreeSearch(message: string) {
  return shouldUseAcademicSearch(message) || /(最新|全球|海外|英文|新闻|今天|刚刚|实时|政策|监管|供应链|出口|制裁|关税|地缘|GDELT|arXiv|论文|学术)/i.test(message);
}

export function buildAssistantEvidenceQueries(message: string, mode: AssistantMode): AnySearchQuery[] {
  const subject = message.slice(0, 120);
  const common = { topic: "assistant" as const, sourceType: "news" as const, maxResults: 4, domains: ["finance" as const, "business" as const], contentTypes: ["news" as const, "web" as const], freshness: "month" as const };
  if (mode === "industry") {
    return [
      { ...common, query: `${subject} 行业硬数据 价格 库存 产能 销量 开工率 景气` },
      { ...common, query: `${subject} 政策 监管 文件 出口管制 集采 补贴` },
      { ...common, query: `${subject} 风险 亏损 过剩 需求下滑 价格下跌 泡沫` },
    ];
  }
  const targetQueries = [
    { ...common, query: `${subject} 财报 业绩预告 业绩快报 经营现金流 毛利率 净利润` },
    { ...common, query: `${subject} 行业 价格 销量 库存 订单 批价 竞争格局` },
    { ...common, query: `${subject} 风险 监管 政策 负面事件 估值 下调` },
  ];
  if (/(技术|优势|人形机器人|大脑|小脑|协调|产品|专利|算法|控制|模型)/.test(message)) targetQueries.push({ ...common, query: `${subject} 技术 产品 专利 运动控制 大模型 协调性 商业化` });
  return targetQueries;
}
