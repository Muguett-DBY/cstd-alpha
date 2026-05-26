export type AssistantGuardExternalEvidence = {
  exa: { used: boolean; count: number };
};

type AssistantOutputGuardOptions = {
  isSimpleGeneralChat?: (message: string) => boolean;
};

export function guardAssistantOutputLanguage(
  text: string,
  message: string,
  externalEvidence?: AssistantGuardExternalEvidence,
  options?: AssistantOutputGuardOptions,
) {
  return cleanAssistantFormatting(
    guardWeakEvidenceSuperlatives(
      guardExternalEvidenceConsistency(
        guardExternalEvidenceLevel(
          guardUnauditedStrongFactLanguage(guardStaleHistoryLanguage(guardCertaintyPromiseLanguage(guardForecastLanguage(text, message, options)))),
          message,
          externalEvidence,
        ),
        externalEvidence,
      ),
    ),
  );
}

function guardCertaintyPromiseLanguage(text: string) {
  return text
    .replace(/若该博主为持牌机构或已披露历史收益率曲线（如连续3年跑赢大盘），则“?必涨”?可能代表选股能力而非操纵/g, "即使该博主有持牌资质或历史业绩，“必涨”也只能视为未经验证的营销话术，不能作为确定承诺")
    .replace(/该博主若为持牌机构或已披露历史收益率曲线（如连续3年跑赢大盘），则“?必涨”?可能代表选股能力而非操纵/g, "即使该博主有持牌资质或历史业绩，“必涨”也只能视为未经验证的营销话术，不能作为确定承诺")
    .replace(/若该博主为持牌机构或已披露历史收益率曲线[^。\n]*“?必涨”?[^。\n]*选股能力[^。\n]*/g, "即使该博主有持牌资质或历史业绩，“必涨”也只能视为未经验证的营销话术，不能作为确定承诺")
    .replace(/该博主若为持牌机构或已披露历史收益率曲线[^。\n]*“?必涨”?[^。\n]*选股能力[^。\n]*/g, "即使该博主有持牌资质或历史业绩，“必涨”也只能视为未经验证的营销话术，不能作为确定承诺")
    .replace(/“?必涨”?可信/g, "“必涨”不可信")
    .replace(/稳赚可信/g, "“稳赚”不可信")
    .replace(/保证收益可信/g, "“保证收益”不可信");
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
