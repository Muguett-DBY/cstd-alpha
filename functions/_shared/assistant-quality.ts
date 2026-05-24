export type AssistantQualityPrompt = {
  id: string;
  category: "forecast" | "target" | "industry" | "technical" | "valuation" | "risk" | "compare" | "chart" | "memory" | "clarification";
  mode: "chat" | "target" | "industry";
  prompt: string;
  mustUseEvidence?: boolean;
  shouldClarify?: boolean;
};

export const ASSISTANT_QUALITY_PROMPTS: AssistantQualityPrompt[] = [
  { id: "forecast-maotai-profit", category: "forecast", mode: "chat", prompt: "茅台今年业绩预估？", mustUseEvidence: true },
  { id: "forecast-maotai-current", category: "forecast", mode: "chat", prompt: "根据现有信息和数据预测贵州茅台今年净利润区间。", mustUseEvidence: true },
  { id: "forecast-catl-profit", category: "forecast", mode: "target", prompt: "宁德时代今年净利润可能是多少？", mustUseEvidence: true },
  { id: "forecast-tencent-revenue", category: "forecast", mode: "target", prompt: "腾讯今年收入和利润增速怎么估？", mustUseEvidence: true },
  { id: "forecast-nvidia", category: "forecast", mode: "target", prompt: "英伟达下一财年业绩增长还能维持吗？", mustUseEvidence: true },
  { id: "target-buy-catl", category: "target", mode: "target", prompt: "宁德时代现在能买吗？", mustUseEvidence: true },
  { id: "target-maotai-hold", category: "target", mode: "target", prompt: "贵州茅台长期持有的主要矛盾是什么？", mustUseEvidence: true },
  { id: "target-byd-risk", category: "target", mode: "target", prompt: "比亚迪最大的反证条件是什么？", mustUseEvidence: true },
  { id: "target-tencent-capital", category: "target", mode: "target", prompt: "腾讯回购和分红能支撑估值吗？", mustUseEvidence: true },
  { id: "target-vanke-redflag", category: "target", mode: "target", prompt: "万科A现在最需要排查的红线是什么？", mustUseEvidence: true },
  { id: "industry-pv", category: "industry", mode: "industry", prompt: "光伏产业链是不是已经见底？", mustUseEvidence: true },
  { id: "industry-storage", category: "industry", mode: "industry", prompt: "存储芯片涨价周期还能持续多久？", mustUseEvidence: true },
  { id: "industry-grid", category: "industry", mode: "industry", prompt: "电网设备高景气是否真实？", mustUseEvidence: true },
  { id: "industry-cxo", category: "industry", mode: "industry", prompt: "CXO行业现在是衰退还是复苏？", mustUseEvidence: true },
  { id: "industry-liquor", category: "industry", mode: "industry", prompt: "白酒行业现在是价值陷阱还是现金牛？", mustUseEvidence: true },
  { id: "technical-ubtech-brain", category: "technical", mode: "target", prompt: "优必选人形机器人，大脑与小脑之间的协调性如何？", mustUseEvidence: true },
  { id: "technical-ubtech-advantage", category: "technical", mode: "target", prompt: "优必选公司有哪些技术优势？", mustUseEvidence: true },
  { id: "technical-robot-embodied", category: "technical", mode: "industry", prompt: "人形机器人行业的大模型和运动控制怎么结合？", mustUseEvidence: true },
  { id: "technical-ai-server", category: "technical", mode: "industry", prompt: "AI服务器产业链现在谁最受益？", mustUseEvidence: true },
  { id: "technical-solid-state", category: "technical", mode: "industry", prompt: "固态电池现在是真突破还是概念炒作？", mustUseEvidence: true },
  { id: "valuation-maotai", category: "valuation", mode: "target", prompt: "贵州茅台现在估值贵不贵？", mustUseEvidence: true },
  { id: "valuation-catl", category: "valuation", mode: "target", prompt: "宁德时代估值需要看哪些核心变量？", mustUseEvidence: true },
  { id: "valuation-bank", category: "valuation", mode: "industry", prompt: "银行高股息是不是低估值陷阱？", mustUseEvidence: true },
  { id: "valuation-power", category: "valuation", mode: "industry", prompt: "水电运营商应该用什么估值框架？", mustUseEvidence: true },
  { id: "valuation-nvidia", category: "valuation", mode: "target", prompt: "英伟达估值泡沫风险怎么判断？", mustUseEvidence: true },
  { id: "risk-real-estate", category: "risk", mode: "industry", prompt: "地产链还有哪些风险没出清？", mustUseEvidence: true },
  { id: "risk-pharma-policy", category: "risk", mode: "industry", prompt: "创新药和集采政策风险怎么拆？", mustUseEvidence: true },
  { id: "risk-export", category: "risk", mode: "industry", prompt: "出口链最怕什么反证？", mustUseEvidence: true },
  { id: "risk-semiconductor-ban", category: "risk", mode: "industry", prompt: "半导体设备的出口管制风险如何影响A股公司？", mustUseEvidence: true },
  { id: "risk-user-thesis", category: "risk", mode: "target", prompt: "我觉得万科A已经跌够了所以可以买，你反驳一下。", mustUseEvidence: true },
  { id: "compare-maotai-wuliangye", category: "compare", mode: "target", prompt: "贵州茅台和五粮液长期回报谁更稳？请列表对比。", mustUseEvidence: true },
  { id: "compare-catl-byd", category: "compare", mode: "target", prompt: "宁德时代和比亚迪电池业务的护城河差异。", mustUseEvidence: true },
  { id: "compare-cxo-drug", category: "compare", mode: "industry", prompt: "CXO和创新药哪个更接近周期拐点？", mustUseEvidence: true },
  { id: "compare-shipping-air", category: "compare", mode: "industry", prompt: "航运和航空哪个周期位置更好？", mustUseEvidence: true },
  { id: "compare-ai-hardware-software", category: "compare", mode: "industry", prompt: "AI硬件和AI应用，哪个更容易兑现利润？", mustUseEvidence: true },
  { id: "chart-profit", category: "chart", mode: "target", prompt: "画表对比宁德时代近几年营收、净利润、现金流趋势。", mustUseEvidence: true },
  { id: "chart-industry-matrix", category: "chart", mode: "industry", prompt: "画一个光伏、储能、风电、电网的证据矩阵。", mustUseEvidence: true },
  { id: "chart-risk-return", category: "chart", mode: "target", prompt: "把贵州茅台的上行空间和下行风险做成表。", mustUseEvidence: true },
  { id: "chart-robot-tech", category: "chart", mode: "industry", prompt: "画表拆解人形机器人本体、大脑、小脑、执行器的投资价值。", mustUseEvidence: true },
  { id: "chart-bubble", category: "chart", mode: "industry", prompt: "做一张AI算力产业链泡沫风险矩阵。", mustUseEvidence: true },
  { id: "memory-preference", category: "memory", mode: "chat", prompt: "记住：以后分析白酒先看批价和库存。", mustUseEvidence: false },
  { id: "memory-correction", category: "memory", mode: "chat", prompt: "纠正一下：不要把券商预测写成公司实际业绩。", mustUseEvidence: false },
  { id: "memory-framework", category: "memory", mode: "chat", prompt: "我的投资框架是先排雷，再看现金流，最后看估值。", mustUseEvidence: false },
  { id: "memory-style", category: "memory", mode: "chat", prompt: "以后回答我不要空话，要直接给判断和反证。", mustUseEvidence: false },
  { id: "memory-no-hype", category: "memory", mode: "chat", prompt: "记住：遇到机器人概念要先怀疑商业化进度。", mustUseEvidence: false },
  { id: "clarify-no-subject", category: "clarification", mode: "chat", prompt: "这个能买吗？", shouldClarify: true },
  { id: "clarify-time", category: "clarification", mode: "chat", prompt: "帮我看一下利润。", shouldClarify: true },
  { id: "clarify-ambiguous", category: "clarification", mode: "chat", prompt: "苹果怎么样？", shouldClarify: true },
  { id: "clarify-action", category: "clarification", mode: "chat", prompt: "我该怎么操作？", shouldClarify: true },
  { id: "clarify-clear", category: "clarification", mode: "target", prompt: "贵州茅台未来三年自由现金流稳定性如何？", shouldClarify: false, mustUseEvidence: true },
];

export function isUnsatisfactoryEvidenceOnlyAnswer(answer: string) {
  const normalized = answer.replace(/\s+/g, "");
  if (!normalized) return true;
  const saysCannotAnswer = /(无法|不能|不宜)(给出|判断|预测|回答|下结论)/.test(normalized);
  const evidenceOnly = /(证据不足|缺乏证据|资料不足|数据不足)/.test(normalized);
  const hasConstructiveWork =
    /(情景|区间|假设|测算|公式|基准|乐观|悲观|保守|中性|反证|跟踪|下一步|需要验证|可用证据)/.test(normalized);
  return evidenceOnly && saysCannotAnswer && !hasConstructiveWork;
}

export function assistantQualityPromptStats(prompts = ASSISTANT_QUALITY_PROMPTS) {
  const categories = new Set(prompts.map((prompt) => prompt.category));
  const modes = new Set(prompts.map((prompt) => prompt.mode));
  return { count: prompts.length, categories: categories.size, modes: modes.size };
}
