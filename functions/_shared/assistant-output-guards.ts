export type AssistantGuardExternalEvidence = {
  exa: { used: boolean; count: number };
};

type AssistantOutputGuardOptions = {
  isSimpleGeneralChat?: (message: string) => boolean;
  fetchImpl?: typeof fetch;
};

export async function guardAssistantOutputLanguage(
  text: string,
  message: string,
  externalEvidence?: AssistantGuardExternalEvidence,
  options?: AssistantOutputGuardOptions,
): Promise<string> {
  const chartFixed = await guardChartRefusalLanguage(text, message, options?.fetchImpl);
  if (chartFixed !== text) return chartFixed;
  return cleanAssistantFormatting(
    guardWeakEvidenceSuperlatives(
      guardExternalEvidenceConsistency(
        guardExternalEvidenceLevel(
          guardCrisisDeEscalationLanguage(
            guardRiskBudgetLanguage(
              guardOnchainCopyTradeBoundary(
                guardLegalBoundaryLanguage(
                  guardUnauditedStrongFactLanguage(guardStaleHistoryLanguage(guardCertaintyPromiseLanguage(guardForecastLanguage(text, message, options)))),
                  message,
                ),
                message,
              ),
              message,
            ),
            message,
          ),
          message,
          externalEvidence,
        ),
        externalEvidence,
      ),
    ),
  );
}

const CHART_REQUEST_RE = /(画图|图表|趋势图|柱状图|折线图|散点图|气泡图|可视化|chart|table|表格|对比表)/i;

const CHART_REFUSAL_RE = /无法[在聊]?[^。\n]{0,30}?(?:画图|生成图片|生成图表|绘制图表|直接显示[^。\n]{0,10}(?:图片|图表)|在聊天框|直接生成图片|直接出图|文字描述[^。\n]{0,10}(?:图片|图表|ASCII|趋势|走势))/i;

/** 公司名称到 Yahoo Finance 代码的映射。 */
const COMPANY_SYMBOL_MAP: Record<string, string> = {
  "小米": "1810.HK",
  "苹果": "AAPL",
  "腾讯": "0700.HK",
  "阿里": "9988.HK",
  "阿里巴巴": "9988.HK",
  "茅台": "600519.SS",
  "贵州茅台": "600519.SS",
  "宁德时代": "300750.SZ",
  "比亚迪": "1211.HK",
  "美团": "3690.HK",
  "英伟达": "NVDA",
  "特斯拉": "TSLA",
  "谷歌": "GOOGL",
  "微软": "MSFT",
  "亚马逊": "AMZN",
  "拼多多": "PDD",
  "百度": "BIDU",
  "京东": "JD",
  "药明康德": "2359.HK",
  "中芯国际": "0981.HK",
  "万科": "000002.SZ",
  "招商银行": "600036.SS",
  "工商银行": "1398.HK",
  "中国移动": "0941.HK",
  "中国联通": "0762.HK",
  "中国电信": "0728.HK",
  "紫金矿业": "2899.HK",
  "港交所": "0388.HK",
  "海底捞": "6862.HK",
  "泡泡玛特": "9992.HK",
  "优必选": "UBXG",
  "理想汽车": "LI",
  "小鹏汽车": "XPEV",
  "蔚来": "NIO",
};

/** 从用户消息中提取公司名称，返回对应的 Yahoo Symbol。 */
function extractSymbol(message: string): string | null {
  for (const [name, symbol] of Object.entries(COMPANY_SYMBOL_MAP)) {
    if (message.includes(name)) return symbol;
  }
  return null;
}

/** 从 Yahoo Finance 获取十年月度股价数据，返回 Markdown 表格字符串。 */
async function fetchYahooChartTable(symbol: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1mo&includeAdjustedClose=true`;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const json: Record<string, unknown> = await response.json();
    const chart = json.chart as Record<string, unknown> | undefined;
    const resultArr = Array.isArray(chart?.result) ? chart.result as unknown[] : null;
    const result = resultArr?.[0] as Record<string, unknown> | undefined;
    if (!result || !Array.isArray(result.timestamp)) return null;
    const timestamps = result.timestamp as number[];
    const indicators = result.indicators as Record<string, unknown> | undefined;
    const quoteArr = Array.isArray(indicators?.quote) ? indicators.quote as unknown[] : null;
    const quote = quoteArr?.[0] as Record<string, unknown> | undefined;
    const closes = Array.isArray(quote?.close) ? quote.close as (number | null)[] : [];
    const adjcloseArr = Array.isArray(indicators?.adjclose) ? indicators.adjclose as unknown[] : null;
    const adjResult = adjcloseArr?.[0] as Record<string, unknown> | undefined;
    const adjCloses = Array.isArray(adjResult?.adjclose) ? adjResult.adjclose as (number | null)[] : [];
    const rows: string[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
      const rawClose = typeof closes[i] === "number" ? closes[i] as number : undefined;
      const adjClose = typeof adjCloses[i] === "number" ? adjCloses[i] as number : rawClose;
      if (!date || adjClose === undefined) continue;
      rows.push(`| ${date} | ${adjClose.toFixed(2)} |`);
    }
    if (rows.length < 3) return null;
    const sampled = rows.length > 200 ? rows.filter((_, i) => i % Math.ceil(rows.length / 200) === 0) : rows;
    return ["| 日期 | 收盘价 |", "| --- | --- |", ...sampled].join("\n");
  } catch {
    return null;
  }
}

/** 检测助手拒绝画图的回复，先尝试提取代码块/内联数据，失败则回退 Yahoo Finance 查询。 */
async function guardChartRefusalLanguage(text: string, message: string, fetchImpl?: typeof fetch): Promise<string> {
  if (!CHART_REQUEST_RE.test(message)) return text;
  if (!CHART_REFUSAL_RE.test(text)) return text;

  const table = extractChartDataAsTable(text);
  if (table) {
    const subject = message.replace(/画.*$/u, "").replace(/[了给请把的]/gu, "").trim() || "当前标的";
    return [
      `结论：${subject}数据已整理为下表，系统会自动渲染为折线图。`,
      "",
      table,
      "",
      "证据等级：中（基于外部搜索线索中的历史价格数据，具体数值请以交易所官方数据为准）。",
    ].join("\n");
  }

  const symbol = extractSymbol(message);
  if (!symbol) return text;

  const yahooTable = await fetchYahooChartTable(symbol, fetchImpl);
  if (!yahooTable) return text;

  const subject = message.replace(/画.*$/u, "").replace(/[了给请把的]/gu, "").trim() || "当前标的";
  return [
    `结论：${subject}股价数据已从 Yahoo Finance 获取，系统会自动渲染为折线图。`,
    "",
    yahooTable,
    "",
    "证据等级：高（数据来源：Yahoo Finance 公开行情 API）。",
  ].join("\n");
}

/** 从助手的回复中提取时序数据并转换为 Markdown 表格。 */
function extractChartDataAsTable(text: string): string | null {
  const lines = extractDataLines(text);
  if (lines.length < 3) return null;

  const result = parseDataLines(lines);
  if (!result || result.rows.length < 3) return null;

  const sampled = result.rows.length > 200
    ? result.rows.filter((_, i) => i % Math.ceil(result.rows.length / 200) === 0)
    : result.rows;

  const colCount = Math.max(...sampled.map((r) => r.length));
  const headers = colCount <= 2 ? ["日期", "数值"] : Array.from({ length: colCount }, (_, i) => (i === 0 ? "日期" : `指标${i}`));
  const separator = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const rows = sampled.map((parts) => `| ${parts.join(" | ")} |`);

  return [separator, divider, ...rows].join("\n");
}

/** 从文本中提取数据行（先尝试代码块，再尝试内联日期行）。 */
function extractDataLines(text: string): string[] {
  const codeBlockData = extractCodeBlockLines(text);
  if (codeBlockData.length >= 3) return codeBlockData;
  return extractInlineDateLines(text);
}

/** 提取所有代码块内容，找到含日期行的那个。 */
function extractCodeBlockLines(text: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:\w+)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const content = match[1].trim();
    if (content) blocks.push(content);
  }
  if (blocks.length === 0) return [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const dateLines = lines.filter((l) => /^\d{4}[-/]\d{2}[-/]\d{2}/.test(l));
    if (dateLines.length >= 3) return dateLines;
  }
  return blocks[0].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** 提取不以 ``` 包裹的日期开头的数据行。 */
function extractInlineDateLines(text: string): string[] {
  const allLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return allLines.filter((l) => /^\d{4}[-/]\d{2}[-/]\d{2}/.test(l));
}

/** 解析数据行，检测分隔符，返回行列结构。 */
function parseDataLines(lines: string[]): { rows: string[][] } | null {
  const dateLineRE = /^\d{4}[-/]\d{2}[-/]\d{2}/;
  const dataLines = lines.filter((l) => dateLineRE.test(l.trim()));
  if (dataLines.length < 3) return null;

  const commaCount = dataLines.filter((l) => l.includes(",")).length;
  const tabCount = dataLines.filter((l) => l.includes("\t")).length;

  let delimiter: string | RegExp = ",";
  if (tabCount >= dataLines.length * 0.5) delimiter = "\t";
  else if (commaCount < dataLines.length * 0.5 && /^\S+\s+\S+/.test(dataLines[0])) delimiter = /\s+/;

  const rows: string[][] = [];
  for (const line of dataLines) {
    const parts = line.split(delimiter).map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length >= 2) rows.push(parts);
  }
  return rows.length >= 3 ? { rows } : null;
}

function guardCertaintyPromiseLanguage(text: string) {
  return text
    .replace(/无风险、免税、零波动/g, "确定性省息、税后口径清晰、低波动")
    .replace(/无风险、免税/g, "确定性省息、税后口径清晰")
    .replace(/完全确定、无风险、税后/g, "较确定、税后")
    .replace(/无风险、税后/g, "较确定、税后")
    .replace(/无风险[、，,]?\s*免税[、，,]?\s*零波动/g, "确定性省息、税后口径清晰、低波动")
    .replace(/无风险[、，,]?\s*税后收益率/g, "较确定的税后收益率")
    .replace(/接近无风险/g, "接近低风险但非零风险")
    .replace(/获得“?无风险[^”"\n。]*回报”?/g, "获得较确定的省息收益")
    .replace(/无风险获益/g, "较确定的省息收益")
    .replace(/无风险收益/g, "较确定的收益")
    .replace(/无风险回报/g, "较确定的回报")
    .replace(/无风险利差/g, "低风险利差")
    .replace(/若该博主为持牌机构或已披露历史收益率曲线（如连续3年跑赢大盘），则“?必涨”?可能代表选股能力而非操纵/g, "即使该博主有持牌资质或历史业绩，“必涨”也只能视为未经验证的营销话术，不能作为确定承诺")
    .replace(/该博主若为持牌机构或已披露历史收益率曲线（如连续3年跑赢大盘），则“?必涨”?可能代表选股能力而非操纵/g, "即使该博主有持牌资质或历史业绩，“必涨”也只能视为未经验证的营销话术，不能作为确定承诺")
    .replace(/若该博主为持牌机构或已披露历史收益率曲线[^。\n]*“?必涨”?[^。\n]*选股能力[^。\n]*/g, "即使该博主有持牌资质或历史业绩，“必涨”也只能视为未经验证的营销话术，不能作为确定承诺")
    .replace(/该博主若为持牌机构或已披露历史收益率曲线[^。\n]*“?必涨”?[^。\n]*选股能力[^。\n]*/g, "即使该博主有持牌资质或历史业绩，“必涨”也只能视为未经验证的营销话术，不能作为确定承诺")
    .replace(/“?必涨”?可信/g, "“必涨”不可信")
    .replace(/稳赚可信/g, "“稳赚”不可信")
    .replace(/保证收益可信/g, "“保证收益”不可信");
}

function guardRiskBudgetLanguage(text: string, message: string) {
  if (!/(梭哈|翻倍|暴涨|最猛|追|赌|日内|月收益|高频|补仓|加倍|期权|杠杆|融资|期货|永续|20倍|3倍|合约|满仓|百倍|MEME|高收益|借钱|贷款|信用卡|高风险|降息|战争风险|衰退|房贷|投资房|消费贷|债务|空投|撸毛|NFT|抄底|翻身)/.test(message)) return text;
  if (/(仓位|上限|止损|亏损上限|最大回撤|退出|压力测试|小仓|分批|禁入|回避|不建议|等待|剔除)/.test(text)) return text;
  return `${text.trim()}\n\n风险预算：这类问题必须先限定最大可承受亏损和退出条件；若没有可量化仓位上限、止损/再平衡规则和最坏情景压力测试，应默认降级为观察，不应满仓、借钱或用生活资金执行。`;
}

function guardCrisisDeEscalationLanguage(text: string, message: string) {
  if (!/(人生完了|亏惨|翻身|尽快回本|一把梭哈|加倍下注|赢回来)/.test(message)) return text;
  if (/(暂停交易|不要梭哈|联系|求助|可信任的人|专业帮助|先停|情绪)/.test(text)) return text;
  return `${text.trim()}\n\n危机降速：如果当前状态是亏损后急着翻身，第一步不是找更高赔率，而是先暂停新增交易，和可信任的人复盘现金流、债务、仓位和情绪状态；在恢复理性前，不做杠杆、借贷、补仓和梭哈。`;
}

function guardLegalBoundaryLanguage(text: string, message: string) {
  if (!/(内幕|逃税|税|跨境|资本管制|套现|绕过|限制|助记词|空投|女巫|离岸|现金收入|报销|募资|亲友借钱|合规|洗钱)/.test(message)) return text;
  if (/(违法|违规|合规|合法|不得|不能|拒绝|不建议|申报|监管|内幕|逃税|洗钱|绕过|助记词|盗币|风险)/.test(text)) return text;
  return `${text.trim()}\n\n法律/合规边界：不能提供逃税、隐匿收入、绕过券商/监管限制、内幕交易、操纵市场、洗钱或规避反女巫/风控的操作步骤；只能讨论公开、可申报、可留痕、可被监管复核的合规框架。`;
}

function guardOnchainCopyTradeBoundary(text: string, message: string) {
  if (!/(聪明钱|钱包|跟买|链上)/.test(message)) return text;
  if (/(不建议|不得|不能|合规|只作为观察|不要复制|不要跟单)/.test(text)) return text;
  return `${text.trim()}\n\n合规/执行边界：链上钱包跟踪只能作为公开信息观察，不应直接复制交易、诱导跟单、绕过平台风控或参与疑似操纵/拉盘；任何地址标签都可能误判，必须先做仓位上限、流动性和退出规则。`;
}

function guardWeakEvidenceSuperlatives(text: string) {
  if (!/证据等级[：:]\s*(低|中低|中低|中)/.test(text)) return text;
  return text
    .replace(/市场悲观预期最充分、逆向抄底性价比最高的资产类别/g, "市场悲观预期较充分、值得优先观察的逆向资产类别之一")
    .replace(/性价比最高的资产类别/g, "值得优先观察的资产类别之一")
    .replace(/预期最充分/g, "预期较充分")
    .replace(/最值得/g, "相对值得")
    .replace(/十年最低折扣价/g, "低估值线索");
}

function guardForecastLanguage(text: string, message: string, options?: AssistantOutputGuardOptions) {
  if (options?.isSimpleGeneralChat?.(message)) return text;
  if (!/(业绩|预估|预测|净利润|营收|利润)/.test(message) || !text.trim()) return text;
  const guarded = text
    .replace(/(\d{4}年)实际值/g, "$1基数线索")
    .replace(/(\d{4}年)实际/g, "$1基数线索")
    .replace(/(全年|归母净利润|营收)实际值/g, "$1基数线索")
    .replace(/证据等级[：:]\s*中至高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*中高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*较高/g, "证据等级：中");
  if (/口径说明：/.test(guarded)) return guarded;
  return `口径说明：以下为基于本轮站内证据和外部搜索线索的情景测算；未逐条核对官方公告的历史基数，不应把搜索摘要当作确定财务事实。\n\n${guarded}`;
}

function guardStaleHistoryLanguage(text: string) {
  return text
    .replace(/站内证据无法支撑/g, "当前可用证据无法支撑")
    .replace(/站内证据不足以支撑/g, "当前可用证据不足以支撑")
    .replace(/站内证据未显示/g, "当前可用证据未显示")
    .replace(/站内无任何此类/g, "当前证据未显示此类")
    .replace(/站内无标的符合/g, "当前证据未显示明确标的符合")
    .replace(/站内证据包/g, "当前证据包")
    .replace(/当前无新增证据[，,、\s]*/g, "")
    .replace(/本次无新增站内证据或外部检索信息修正此前判断[，,。；;\s]*/g, "")
    .replace(/本轮无新增[^。\n]*(站内|外部|证据|检索)[^。\n]*[。；;]?\s*/g, "")
    .replace(/本次无新增站内证据[，,、\s]*/g, "")
    .replace(/维持此前测算口径[，,、\s]*/g, "本轮测算口径：")
    .replace(/与上次(?:判断|回答)?完全一致[，,。；;\s]*/g, "")
    .replace(/口径与上次完全一致[，,。；;\s]*/g, "")
    .replace(/与前次口径完全相同/g, "本轮口径")
    .replace(/与上次回答完全一致/g, "本轮判断")
    .replace(/此前结论保持不变[——\-:：\s]*/g, "本轮判断：")
    .replace(/维持此前结论[——\-:：\s]*/g, "本轮判断：")
    .replace(/此前结论/g, "本轮判断");
}

function guardUnauditedStrongFactLanguage(text: string) {
  return text
    .replace(/上市\d+年首次业绩双降/g, "业绩承压待核验线索")
    .replace(/上市以来首次业绩双降/g, "业绩承压待核验线索")
    .replace(/首次业绩双降/g, "业绩承压待核验线索")
    .replace(/业绩双降/g, "业绩承压待核验线索")
    .replace(/营收[和与、及]?利润首次双降/g, "营收和利润承压待核验线索")
    .replace(/营收[和与、及]?利润双降/g, "营收和利润承压待核验线索")
    .replace(/收入[和与、及]?利润首次双降/g, "收入和利润承压待核验线索")
    .replace(/收入[和与、及]?利润双降/g, "收入和利润承压待核验线索")
    .replace(/利润[和与、及]?收入首次双降/g, "利润和收入承压待核验线索")
    .replace(/利润[和与、及]?收入双降/g, "利润和收入承压待核验线索")
    .replace(/营收利润双降/g, "营收和利润承压待核验线索")
    .replace(/首次年度亏损/g, "年度亏损待核验线索");
}

function guardExternalEvidenceConsistency(text: string, externalEvidence?: AssistantGuardExternalEvidence) {
  if (!externalEvidence?.exa.used || externalEvidence.exa.count <= 0) return text;
  return text
    .replace(/Exa无可用结果/g, "Exa返回了外部线索，但硬证据强度有限")
    .replace(/Exa未返回可用结果/g, "Exa返回了外部线索，但硬证据强度有限")
    .replace(/本轮检索未返回任何([^。\n]*)条目/g, "本轮检索返回了外部线索，但$1条目的硬证据强度有限")
    .replace(/本轮检索未返回任何([^。\n]*)相关条目/g, "本轮检索返回了相关外部线索，但硬证据强度有限")
    .replace(/外部搜索（Exa）：本轮检索未返回任何([^。\n]*)/g, "外部搜索（Exa）：本轮返回了外部线索，但$1的硬证据强度有限");
}

function guardExternalEvidenceLevel(text: string, message: string, externalEvidence?: AssistantGuardExternalEvidence) {
  if (!externalEvidence || !/(Exa|AnySearch|SearXNG|GDELT|ArXiv|SemanticScholar|Semantic Scholar|外部搜索|海外|全球|学术|论文|GCC|印度|美国|季度报告|市场新闻|S&P)/i.test(text)) return text;
  const likelyChinaOrAh = /(A股|港股|中国|银行股|高股息|四大行|国有大行|茅台|宁德时代|腾讯|优必选|比亚迪|万科|招商银行|工商银行|建设银行|农业银行|中国银行)/i.test(message + text);
  const evidenceGradeDependsOnSearch =
    /证据等级[：:][^\n。]*(Exa|AnySearch|SearXNG|GDELT|ArXiv|SemanticScholar|Semantic Scholar|外部搜索|海外|全球|学术|论文|GCC|印度|美国|S&P|券商研报|行业新闻|市场新闻|多地区)/i.test(text) ||
    /(Exa|AnySearch|SearXNG|GDELT|ArXiv|SemanticScholar|Semantic Scholar|外部搜索|学术|论文)[^。]*(证据等级[：:]\s*(高|较高|中高|中至高|强))/i.test(text);
  const hasDirectChinaHardSource = /(央行|金融监管总局|交易所公告|公司公告|上市银行年报|上市银行季报|官方统计|监管文件)/.test(text);
  if (!likelyChinaOrAh && !evidenceGradeDependsOnSearch) return text;
  if (hasDirectChinaHardSource && !evidenceGradeDependsOnSearch) return text;
  return text
    .replace(/证据等级[：:]\s*中至高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*中高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*较高/g, "证据等级：中")
    .replace(/证据等级[：:]\s*强/g, "证据等级：中");
}

function cleanAssistantFormatting(text: string) {
  return removeEmptyMarkdownSections(text)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(?:^|\n)\s*(好的[，,]\s*)?收到(?:您的)?(?:指令|问题|需求)?[。！!，,]?\s*作为\s*CSTD Alpha\s*的?[^。\n]{0,40}(?:助手|投研助手)[^。\n]*[。！!]?\s*/g, "\n")
    .replace(/(?:^|\n)\s*好的[，,]\s*收到(?:您的)?(?:指令|问题|需求)?[。！!]?\s*/g, "\n")
    .replace(/^结构化表格\s*\d*\s*$/gim, "")
    .replace(/反证条件（支持“?稳赚”?）/g, "削弱反驳的条件")
    .replace(/反证条件\(支持“?稳赚”?\)/g, "削弱反驳的条件")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeEmptyMarkdownSections(text: string) {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isPotentialEmptyHeading(line)) {
      kept.push(line);
      continue;
    }
    let firstNonBlank = index + 1;
    while (firstNonBlank < lines.length && !lines[firstNonBlank].trim()) firstNonBlank += 1;
    if (/^[-—_]{3,}$/.test(lines[firstNonBlank]?.trim() ?? "")) {
      let afterRule = firstNonBlank + 1;
      while (afterRule < lines.length && (!lines[afterRule].trim() || /^[-—_]{3,}$/.test(lines[afterRule].trim()))) afterRule += 1;
      index = afterRule - 1;
      continue;
    }
    let cursor = index + 1;
    let hasContent = false;
    while (cursor < lines.length && !isAnyMarkdownHeading(lines[cursor])) {
      const current = lines[cursor].trim();
      if (current && !/^[-—_]{3,}$/.test(current)) {
        hasContent = true;
        break;
      }
      cursor += 1;
    }
    if (hasContent) kept.push(line);
    else index = cursor - 1;
  }
  return kept.join("\n");
}

function isPotentialEmptyHeading(line: string) {
  return /^#{1,6}\s*(核心理由|证据|证据等级|反驳用户(?:典型)?观点(?:（[^）]*）)?|我可能错在哪里(?:（[^）]*）)?|下一步跟踪|后续跟踪|反证条件(?:（[^）]*）)?|正向确认信号(?:（[^）]*）)?)\s*[：:]?\s*$/.test(line.trim());
}

function isAnyMarkdownHeading(line: string) {
  return /^#{1,6}\s+\S+/.test(line.trim());
}
