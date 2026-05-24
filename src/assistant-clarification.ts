export type AssistantClarificationOption = {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
  requiresCustom?: boolean;
};

export type AssistantClarificationRequest = {
  id: "missing-target" | "missing-perspective" | "multi-branch";
  title: string;
  question: string;
  reason: string;
  customPlaceholder: string;
  options: AssistantClarificationOption[];
};

export function analyzeAssistantClarification(message: string): AssistantClarificationRequest | null {
  const normalized = message.trim();
  if (!normalized) return null;
  if (isTeachingMemory(normalized)) return null;

  const profile = buildMessageProfile(normalized);
  if (profile.hasExplicitClarification || profile.isSpecificEnough) return null;
  if (profile.needsTarget) return missingTargetRequest;
  if (profile.isMultiBranch) return multiBranchRequest;
  if (profile.needsPerspective) return missingPerspectiveRequest;
  return null;
}

export function composeClarifiedAssistantMessage(original: string, option: AssistantClarificationOption, customAnswer: string) {
  const custom = customAnswer.trim();
  return [
    original.trim(),
    "",
    "【用户澄清】",
    `选择：${option.label}`,
    `含义：${option.description}`,
    custom ? `补充：${custom}` : "",
    "请基于以上澄清回答；如果仍缺关键事实，先明确证据缺口，不要硬下结论。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildMessageProfile(message: string) {
  const lengthScore = Math.min(message.length / 42, 1);
  const hasTarget = /([A-Z]{1,6}\b|\b\d{5,6}\b|[\u4e00-\u9fa5A-Za-z]{2,}(股份|集团|科技|银行|证券|保险|医药|能源|电力|汽车|时代|茅台|腾讯|阿里|美团|宁德|比亚迪|英伟达|苹果)|A股|港股|美股|半导体|光伏|白酒|地产|银行|保险|券商|电网|储能|机器人|创新药|CXO|AI)/i.test(message);
  const hasPerspective = /(长期|短期|中期|估值|现金流|财报|利润|毛利率|ROE|护城河|风险|反证|仓位|买点|卖点|持有|配置|行业|竞争|订单|销量|价格|周期|催化|回撤|分红|高股息)/i.test(message);
  const hasActionVerb = /(怎么看|能买吗|买不买|值得|分析|评价|对比|排序|打分|复盘|跟踪|解释|找一下|查一下)/.test(message);
  const broadIntent = /(怎么看|能买吗|买不买|值得买吗|分析一下|评价一下|哪个好|怎么样)\??$/.test(message);
  const hasExplicitClarification = /(从.+角度|按.+视角|重点看|只看|不要看|时间维度|持有周期|仓位|风险偏好|我的问题是)/.test(message);
  const branchCount = [/(对比|哪个好|哪个更)/.test(message), /(买|卖|持有|仓位)/.test(message), /(长期|短期|风险|估值|财报)/.test(message)].filter(Boolean).length;
  const clarityScore = lengthScore + (hasTarget ? 0.42 : 0) + (hasPerspective ? 0.42 : 0) + (hasExplicitClarification ? 0.35 : 0) - (broadIntent ? 0.35 : 0);
  return {
    hasExplicitClarification,
    isSpecificEnough: clarityScore >= 1.35,
    needsTarget: hasActionVerb && !hasTarget,
    needsPerspective: hasTarget && (broadIntent || (!hasPerspective && message.length < 36)),
    isMultiBranch: hasTarget && branchCount >= 2 && /(和|与|vs|VS|对比|同时|还有)/.test(message) && !hasExplicitClarification,
  };
}

function isTeachingMemory(message: string) {
  return /^(记住|以后|我的偏好|我的规则|投资框架|不要再|别再|纠正一下|这条规则)/.test(message.trim());
}

const missingPerspectiveRequest: AssistantClarificationRequest = {
  id: "missing-perspective",
  title: "先确认分析视角",
  question: "这个问题可以从不同角度回答。你希望我优先按哪种视角来判断？",
  reason: "问题有研究对象，但缺少时间维度或判断口径。",
  customPlaceholder: "例如：按 3 年持有、重视现金流和估值，不要只看股价...",
  options: [
    { id: "long-term", label: "长期投资视角（推荐）", description: "重点看商业质量、财务持续性、估值安全边际和反证条件。", recommended: true },
    { id: "risk-first", label: "风险排雷视角", description: "先找财务、行业、估值、治理和叙事泡沫里的硬伤。" },
    { id: "catalyst", label: "短期催化视角", description: "重点看近期财报、价格、订单、政策、资金和事件催化。" },
  ],
};

const missingTargetRequest: AssistantClarificationRequest = {
  id: "missing-target",
  title: "先确认研究对象",
  question: "你还没说清楚要分析哪家公司、行业或主题。你希望我怎么继续？",
  reason: "缺少公司、行业或主题，直接回答容易变成泛泛而谈。",
  customPlaceholder: "输入公司、股票代码、行业或主题，例如：宁德时代、300750、港股互联网、光伏...",
  options: [
    { id: "provide-target", label: "补充研究对象（推荐）", description: "你在下方写清公司、行业或主题后，我再分析。", recommended: true, requiresCustom: true },
    { id: "framework", label: "先给分析框架", description: "不针对具体标的，只给一套可执行的判断框架。" },
    { id: "radar-context", label: "结合站内雷达", description: "从当前雷达和自选股里找可能相关的方向，但结论会更保守。" },
  ],
};

const multiBranchRequest: AssistantClarificationRequest = {
  id: "multi-branch",
  title: "先收窄问题分支",
  question: "这个问题同时包含多个判断分支。你希望我先解决哪一类？",
  reason: "多目标问题如果一次回答，容易把结论、证据和反证混在一起。",
  customPlaceholder: "例如：先比较估值和现金流，最后给一个排序...",
  options: [
    { id: "rank-first", label: "先做结论排序（推荐）", description: "先给排序和核心理由，再展开关键证据。", recommended: true },
    { id: "company-by-company", label: "逐个拆解", description: "每个公司或方向单独看，避免混淆逻辑。" },
    { id: "risk-only", label: "只看风险反证", description: "先找最可能导致判断错误的风险点。" },
  ],
};
