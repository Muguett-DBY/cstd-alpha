export type AssistantQualityPrompt = {
  id: string;
  category:
    | "forecast"
    | "target"
    | "industry"
    | "technical"
    | "valuation"
    | "risk"
    | "compare"
    | "chart"
    | "memory"
    | "clarification"
    | "cashflow"
    | "dividend"
    | "moat"
    | "cycle"
    | "bubble"
    | "hk"
    | "us"
    | "portfolio"
    | "contrarian"
    | "tooling";
  mode: "chat" | "target" | "industry";
  prompt: string;
  mustUseEvidence?: boolean;
  shouldClarify?: boolean;
};

const promptBank: Record<AssistantQualityPrompt["category"], Array<Omit<AssistantQualityPrompt, "category">>> = {
  forecast: [
    { id: "forecast-maotai-profit", mode: "chat", prompt: "茅台今年业绩预估？", mustUseEvidence: true },
    { id: "forecast-maotai-current", mode: "chat", prompt: "根据现有信息和数据预测贵州茅台今年净利润区间。", mustUseEvidence: true },
    { id: "forecast-catl-profit", mode: "target", prompt: "宁德时代今年净利润可能是多少？", mustUseEvidence: true },
    { id: "forecast-tencent-revenue", mode: "target", prompt: "腾讯今年收入和利润增速怎么估？", mustUseEvidence: true },
    { id: "forecast-nvidia", mode: "target", prompt: "英伟达下一财年业绩增长还能维持吗？", mustUseEvidence: true },
    { id: "forecast-byd-margin", mode: "target", prompt: "比亚迪今年利润率会继续承压吗？给情景区间。", mustUseEvidence: true },
    { id: "forecast-xiaomi-ev", mode: "target", prompt: "小米汽车今年会拖累还是拉动小米集团利润？", mustUseEvidence: true },
    { id: "forecast-hengrui-drug", mode: "target", prompt: "恒瑞医药今年利润恢复的关键假设是什么？", mustUseEvidence: true },
    { id: "forecast-longi-loss", mode: "target", prompt: "隆基绿能今年亏损收窄的概率大吗？", mustUseEvidence: true },
    { id: "forecast-vanke-cash", mode: "target", prompt: "万科A今年现金流压力会不会缓解？", mustUseEvidence: true },
  ],
  target: [
    { id: "target-buy-catl", mode: "target", prompt: "宁德时代现在能买吗？", mustUseEvidence: true },
    { id: "target-maotai-hold", mode: "target", prompt: "贵州茅台长期持有的主要矛盾是什么？", mustUseEvidence: true },
    { id: "target-byd-risk", mode: "target", prompt: "比亚迪最大的反证条件是什么？", mustUseEvidence: true },
    { id: "target-tencent-capital", mode: "target", prompt: "腾讯回购和分红能支撑估值吗？", mustUseEvidence: true },
    { id: "target-vanke-redflag", mode: "target", prompt: "万科A现在最需要排查的红线是什么？", mustUseEvidence: true },
    { id: "target-ubtech-commercialization", mode: "target", prompt: "优必选最需要验证的商业化指标是什么？", mustUseEvidence: true },
    { id: "target-montage-hbm", mode: "target", prompt: "澜起科技是否真的受益于AI服务器周期？", mustUseEvidence: true },
    { id: "target-wusprinted-pcb", mode: "target", prompt: "沪电股份的AI PCB逻辑还能持续吗？", mustUseEvidence: true },
    { id: "target-chalco-cycle", mode: "target", prompt: "中国铝业是周期弹性还是长期价值？", mustUseEvidence: true },
    { id: "target-baiyunshan", mode: "target", prompt: "白云山现在的投资吸引力主要来自哪里？", mustUseEvidence: true },
  ],
  industry: [
    { id: "industry-pv", mode: "industry", prompt: "光伏产业链是不是已经见底？", mustUseEvidence: true },
    { id: "industry-storage", mode: "industry", prompt: "存储芯片涨价周期还能持续多久？", mustUseEvidence: true },
    { id: "industry-grid", mode: "industry", prompt: "电网设备高景气是否真实？", mustUseEvidence: true },
    { id: "industry-cxo", mode: "industry", prompt: "CXO行业现在是衰退还是复苏？", mustUseEvidence: true },
    { id: "industry-liquor", mode: "industry", prompt: "白酒行业现在是价值陷阱还是现金牛？", mustUseEvidence: true },
    { id: "industry-hk-internet", mode: "industry", prompt: "港股互联网现在投资吸引力来自利润修复、回购还是估值修复？反驳过度乐观观点。", mustUseEvidence: true },
    { id: "industry-pig-cycle", mode: "industry", prompt: "猪周期反转是否已经确认？", mustUseEvidence: true },
    { id: "industry-shipping", mode: "industry", prompt: "航运景气是短期运价扰动还是周期上行？", mustUseEvidence: true },
    { id: "industry-steel-cement", mode: "industry", prompt: "钢铁水泥有周期修复机会还是地产链拖累？", mustUseEvidence: true },
    { id: "industry-power", mode: "industry", prompt: "电力和水电运营商的稳定现金流质量如何？", mustUseEvidence: true },
  ],
  technical: [
    { id: "technical-ubtech-brain", mode: "target", prompt: "优必选人形机器人，大脑与小脑之间的协调性如何？", mustUseEvidence: true },
    { id: "technical-ubtech-advantage", mode: "target", prompt: "优必选公司有哪些技术优势？", mustUseEvidence: true },
    { id: "technical-robot-embodied", mode: "industry", prompt: "人形机器人行业的大模型和运动控制怎么结合？", mustUseEvidence: true },
    { id: "technical-ai-server", mode: "industry", prompt: "AI服务器产业链现在谁最受益？", mustUseEvidence: true },
    { id: "technical-solid-state", mode: "industry", prompt: "固态电池现在是真突破还是概念炒作？", mustUseEvidence: true },
    { id: "technical-hbm-chain", mode: "industry", prompt: "HBM产业链中A股公司真正受益点在哪里？", mustUseEvidence: true },
    { id: "technical-ai-power", mode: "industry", prompt: "AI数据中心用电会如何传导到电网设备公司？", mustUseEvidence: true },
    { id: "technical-autonomous-driving", mode: "industry", prompt: "智能驾驶产业链当前利润最可能落在哪一层？", mustUseEvidence: true },
    { id: "technical-low-altitude", mode: "industry", prompt: "低空经济现在是政策主题还是订单兑现？", mustUseEvidence: true },
    { id: "technical-semiconductor-equipment", mode: "industry", prompt: "半导体设备国产替代的瓶颈是什么？", mustUseEvidence: true },
  ],
  valuation: [
    { id: "valuation-maotai", mode: "target", prompt: "贵州茅台现在估值贵不贵？", mustUseEvidence: true },
    { id: "valuation-catl", mode: "target", prompt: "宁德时代估值需要看哪些核心变量？", mustUseEvidence: true },
    { id: "valuation-bank", mode: "industry", prompt: "银行高股息是不是低估值陷阱？", mustUseEvidence: true },
    { id: "valuation-power", mode: "industry", prompt: "水电运营商应该用什么估值框架？", mustUseEvidence: true },
    { id: "valuation-nvidia", mode: "target", prompt: "英伟达估值泡沫风险怎么判断？", mustUseEvidence: true },
    { id: "valuation-hk-internet", mode: "industry", prompt: "港股互联网低估值是否足以构成买入理由？", mustUseEvidence: true },
    { id: "valuation-robotics", mode: "industry", prompt: "人形机器人公司估值应该如何避免概念泡沫？", mustUseEvidence: true },
    { id: "valuation-cxo", mode: "industry", prompt: "CXO估值修复需要什么利润证据？", mustUseEvidence: true },
    { id: "valuation-lithium", mode: "industry", prompt: "锂矿公司在价格底部如何估值？", mustUseEvidence: true },
    { id: "valuation-property", mode: "industry", prompt: "地产股的PB折价能不能说明安全边际？", mustUseEvidence: true },
  ],
  risk: [
    { id: "risk-real-estate", mode: "industry", prompt: "地产链还有哪些风险没出清？", mustUseEvidence: true },
    { id: "risk-pharma-policy", mode: "industry", prompt: "创新药和集采政策风险怎么拆？", mustUseEvidence: true },
    { id: "risk-export", mode: "industry", prompt: "出口链最怕什么反证？", mustUseEvidence: true },
    { id: "risk-semiconductor-ban", mode: "industry", prompt: "半导体设备的出口管制风险如何影响A股公司？", mustUseEvidence: true },
    { id: "risk-user-thesis", mode: "target", prompt: "我觉得万科A已经跌够了所以可以买，你反驳一下。", mustUseEvidence: true },
    { id: "risk-bank-dividend", mode: "industry", prompt: "如果我认为银行股是稳赚高股息，你反驳我。", mustUseEvidence: true },
    { id: "risk-nvidia-capex", mode: "target", prompt: "英伟达最大风险是不是云厂商资本开支放缓？", mustUseEvidence: true },
    { id: "risk-maotai-price", mode: "target", prompt: "茅台批价下跌会如何影响估值和利润预期？", mustUseEvidence: true },
    { id: "risk-pv-cash", mode: "industry", prompt: "光伏企业最危险的现金流指标是什么？", mustUseEvidence: true },
    { id: "risk-medical-corruption", mode: "industry", prompt: "医药反腐对医疗服务和器械的影响怎么区分？", mustUseEvidence: true },
  ],
  compare: [
    { id: "compare-maotai-wuliangye", mode: "target", prompt: "贵州茅台和五粮液长期回报谁更稳？请列表对比。", mustUseEvidence: true },
    { id: "compare-catl-byd", mode: "target", prompt: "宁德时代和比亚迪电池业务的护城河差异。", mustUseEvidence: true },
    { id: "compare-cxo-drug", mode: "industry", prompt: "CXO和创新药哪个更接近周期拐点？", mustUseEvidence: true },
    { id: "compare-shipping-air", mode: "industry", prompt: "航运和航空哪个周期位置更好？", mustUseEvidence: true },
    { id: "compare-ai-hardware-software", mode: "industry", prompt: "AI硬件和AI应用，哪个更容易兑现利润？", mustUseEvidence: true },
    { id: "compare-grid-storage", mode: "industry", prompt: "电网设备和储能哪个景气更确定？", mustUseEvidence: true },
    { id: "compare-copper-aluminum", mode: "industry", prompt: "铜和铝哪条有色链的投资证据更强？", mustUseEvidence: true },
    { id: "compare-hk-us-ai", mode: "industry", prompt: "港股AI应用和美股AI硬件的风险回报怎么比？", mustUseEvidence: true },
    { id: "compare-property-bank", mode: "industry", prompt: "银行和地产链哪个风险更可控？", mustUseEvidence: true },
    { id: "compare-consumer-export", mode: "industry", prompt: "内需消费和出口链哪个更可能边际改善？", mustUseEvidence: true },
  ],
  chart: [
    { id: "chart-profit", mode: "target", prompt: "画表对比宁德时代近几年营收、净利润、现金流趋势。", mustUseEvidence: true },
    { id: "chart-industry-matrix", mode: "industry", prompt: "画一个光伏、储能、风电、电网的证据矩阵。", mustUseEvidence: true },
    { id: "chart-risk-return", mode: "target", prompt: "把贵州茅台的上行空间和下行风险做成表。", mustUseEvidence: true },
    { id: "chart-robot-tech", mode: "industry", prompt: "画表拆解人形机器人本体、大脑、小脑、执行器的投资价值。", mustUseEvidence: true },
    { id: "chart-bubble", mode: "industry", prompt: "做一张AI算力产业链泡沫风险矩阵。", mustUseEvidence: true },
    { id: "chart-watchlist", mode: "chat", prompt: "把我的自选股按质量、估值风险、证据强度做成对比表。", mustUseEvidence: true },
    { id: "chart-dividend", mode: "industry", prompt: "画表比较银行、电力、煤炭、电信的高股息风险。", mustUseEvidence: true },
    { id: "chart-cxo-stage", mode: "industry", prompt: "画表拆解CXO、创新药、医疗服务的周期阶段。", mustUseEvidence: true },
    { id: "chart-pv-chain", mode: "industry", prompt: "画表拆解光伏硅料、组件、逆变器、设备的出清程度。", mustUseEvidence: true },
    { id: "chart-ai-chain", mode: "industry", prompt: "画表比较光模块、PCB、服务器、存储芯片的利润兑现程度。", mustUseEvidence: true },
  ],
  memory: [
    { id: "memory-preference", mode: "chat", prompt: "记住：以后分析白酒先看批价和库存。", mustUseEvidence: false },
    { id: "memory-correction", mode: "chat", prompt: "纠正一下：不要把券商预测写成公司实际业绩。", mustUseEvidence: false },
    { id: "memory-framework", mode: "chat", prompt: "我的投资框架是先排雷，再看现金流，最后看估值。", mustUseEvidence: false },
    { id: "memory-style", mode: "chat", prompt: "以后回答我不要空话，要直接给判断和反证。", mustUseEvidence: false },
    { id: "memory-no-hype", mode: "chat", prompt: "记住：遇到机器人概念要先怀疑商业化进度。", mustUseEvidence: false },
    { id: "memory-ah-focus", mode: "chat", prompt: "记住：我的核心市场是A股和港股，美股只做参照。", mustUseEvidence: false },
    { id: "memory-score-strict", mode: "chat", prompt: "以后评分要严格，宁可低估，不要给困境公司虚高分。", mustUseEvidence: false },
    { id: "memory-cashflow-first", mode: "chat", prompt: "记住：自由现金流比利润更重要，分析时先看现金流。", mustUseEvidence: false },
    { id: "memory-no-fallback", mode: "chat", prompt: "纠正一下：不要用证据不足当答案，要给可验证的情景判断。", mustUseEvidence: false },
    { id: "memory-citation", mode: "chat", prompt: "以后引用搜索结果要说明只是线索，不要当硬数据。", mustUseEvidence: false },
  ],
  clarification: [
    { id: "clarify-no-subject", mode: "chat", prompt: "这个能买吗？", shouldClarify: true },
    { id: "clarify-time", mode: "chat", prompt: "帮我看一下利润。", shouldClarify: true },
    { id: "clarify-ambiguous", mode: "chat", prompt: "苹果怎么样？", shouldClarify: true },
    { id: "clarify-action", mode: "chat", prompt: "我该怎么操作？", shouldClarify: true },
    { id: "clarify-clear", mode: "target", prompt: "贵州茅台未来三年自由现金流稳定性如何？", shouldClarify: false, mustUseEvidence: true },
    { id: "clarify-subject-only", mode: "chat", prompt: "半导体呢？", shouldClarify: true },
    { id: "clarify-company-nickname", mode: "chat", prompt: "小米还能涨吗？", shouldClarify: false, mustUseEvidence: true },
    { id: "clarify-horizon", mode: "target", prompt: "腾讯短期和三年维度分别怎么看？", shouldClarify: false, mustUseEvidence: true },
    { id: "clarify-risk-only", mode: "chat", prompt: "风险大吗？", shouldClarify: true },
    { id: "clarify-table-clear", mode: "industry", prompt: "请用表格比较光伏和储能的增长、风险和证据缺口。", shouldClarify: false, mustUseEvidence: true },
  ],
  cashflow: [
    { id: "cashflow-maotai", mode: "target", prompt: "贵州茅台自由现金流为什么比利润更值得看？", mustUseEvidence: true },
    { id: "cashflow-catl", mode: "target", prompt: "宁德时代现金流和资本开支对长期回报有什么影响？", mustUseEvidence: true },
    { id: "cashflow-vanke", mode: "target", prompt: "万科A现金流安全边际在哪里？", mustUseEvidence: true },
    { id: "cashflow-longi", mode: "target", prompt: "隆基绿能现金流压力是否比利润亏损更关键？", mustUseEvidence: true },
    { id: "cashflow-tencent", mode: "target", prompt: "腾讯自由现金流能支撑回购多久？", mustUseEvidence: true },
    { id: "cashflow-power", mode: "industry", prompt: "电力运营商现金流质量如何区分？", mustUseEvidence: true },
    { id: "cashflow-pharma", mode: "industry", prompt: "创新药公司的现金流和研发投入怎么一起看？", mustUseEvidence: true },
    { id: "cashflow-robot", mode: "industry", prompt: "机器人公司现金流为什么比订单发布更重要？", mustUseEvidence: true },
    { id: "cashflow-export", mode: "industry", prompt: "出口链公司现金流风险主要来自哪里？", mustUseEvidence: true },
    { id: "cashflow-bank", mode: "industry", prompt: "银行现金流口径和普通制造业有什么不同？", mustUseEvidence: true },
  ],
  dividend: [
    { id: "dividend-bank", mode: "industry", prompt: "银行高股息稳定吗？请反驳稳赚观点。", mustUseEvidence: true },
    { id: "dividend-power", mode: "industry", prompt: "水电高股息和煤炭高股息哪个更稳？", mustUseEvidence: true },
    { id: "dividend-telecom", mode: "industry", prompt: "港股电讯的高股息主要风险是什么？", mustUseEvidence: true },
    { id: "dividend-coal", mode: "industry", prompt: "煤炭股高分红可持续性看哪些指标？", mustUseEvidence: true },
    { id: "dividend-maotai", mode: "target", prompt: "贵州茅台分红回报和估值之间怎么权衡？", mustUseEvidence: true },
    { id: "dividend-tencent", mode: "target", prompt: "腾讯回购和分红哪个更能提升长期回报？", mustUseEvidence: true },
    { id: "dividend-catl", mode: "target", prompt: "宁德时代未来分红能力取决于什么？", mustUseEvidence: true },
    { id: "dividend-utility", mode: "industry", prompt: "公用事业高股息是不是利率下行受益？", mustUseEvidence: true },
    { id: "dividend-risk", mode: "industry", prompt: "哪些高股息行业可能是分红陷阱？", mustUseEvidence: true },
    { id: "dividend-portfolio", mode: "chat", prompt: "如果只靠高股息构建组合，最大的错误是什么？", mustUseEvidence: true },
  ],
  moat: [
    { id: "moat-maotai", mode: "target", prompt: "贵州茅台护城河是否正在变窄？", mustUseEvidence: true },
    { id: "moat-catl", mode: "target", prompt: "宁德时代护城河来自技术、规模还是客户绑定？", mustUseEvidence: true },
    { id: "moat-tencent", mode: "target", prompt: "腾讯护城河现在还是社交网络吗？", mustUseEvidence: true },
    { id: "moat-nvidia", mode: "target", prompt: "英伟达护城河最容易被谁削弱？", mustUseEvidence: true },
    { id: "moat-hengrui", mode: "target", prompt: "恒瑞医药创新药护城河是否已经重建？", mustUseEvidence: true },
    { id: "moat-pcb", mode: "target", prompt: "沪电股份护城河和AI服务器需求是否匹配？", mustUseEvidence: true },
    { id: "moat-ubtech", mode: "target", prompt: "优必选的护城河是真技术还是品牌曝光？", mustUseEvidence: true },
    { id: "moat-bank", mode: "industry", prompt: "银行业护城河是否主要来自牌照和负债成本？", mustUseEvidence: true },
    { id: "moat-power", mode: "industry", prompt: "水电运营商的护城河和成长性如何平衡？", mustUseEvidence: true },
    { id: "moat-consumer", mode: "industry", prompt: "消费龙头的品牌护城河在需求下行时是否失效？", mustUseEvidence: true },
  ],
  cycle: [
    { id: "cycle-pig", mode: "industry", prompt: "猪周期现在处于哪个阶段？", mustUseEvidence: true },
    { id: "cycle-lithium", mode: "industry", prompt: "锂价反弹是周期反转还是库存扰动？", mustUseEvidence: true },
    { id: "cycle-copper", mode: "industry", prompt: "铜价上涨能否传导到A股铜企利润？", mustUseEvidence: true },
    { id: "cycle-aluminum", mode: "industry", prompt: "铝行业现在是供给约束还是需求复苏？", mustUseEvidence: true },
    { id: "cycle-shipping", mode: "industry", prompt: "BDI上涨对航运股利润有多大参考意义？", mustUseEvidence: true },
    { id: "cycle-steel", mode: "industry", prompt: "钢铁周期有没有真正复苏信号？", mustUseEvidence: true },
    { id: "cycle-cement", mode: "industry", prompt: "水泥行业价格修复是否可持续？", mustUseEvidence: true },
    { id: "cycle-memory", mode: "industry", prompt: "存储周期什么时候从量价齐升转向产能风险？", mustUseEvidence: true },
    { id: "cycle-consumer", mode: "industry", prompt: "消费复苏为什么经常是假信号？", mustUseEvidence: true },
    { id: "cycle-real-estate", mode: "industry", prompt: "地产链周期底和资产负债表底有什么区别？", mustUseEvidence: true },
  ],
  bubble: [
    { id: "bubble-robot", mode: "industry", prompt: "人形机器人股价泡沫怎么识别？", mustUseEvidence: true },
    { id: "bubble-ai", mode: "industry", prompt: "AI算力当前最大泡沫风险在哪里？", mustUseEvidence: true },
    { id: "bubble-pv", mode: "industry", prompt: "光伏行业泡沫破裂后为什么还可能继续亏？", mustUseEvidence: true },
    { id: "bubble-biotech", mode: "industry", prompt: "创新药出海会不会形成股价泡沫？", mustUseEvidence: true },
    { id: "bubble-low-altitude", mode: "industry", prompt: "低空经济主题有没有产业泡沫？", mustUseEvidence: true },
    { id: "bubble-solid-state", mode: "industry", prompt: "固态电池概念怎么区分技术突破和炒作？", mustUseEvidence: true },
    { id: "bubble-hk-tech", mode: "industry", prompt: "港股科技反弹是不是估值修复过头？", mustUseEvidence: true },
    { id: "bubble-nvidia", mode: "target", prompt: "英伟达是不是已经透支未来业绩？", mustUseEvidence: true },
    { id: "bubble-pcb", mode: "target", prompt: "沪电股份AI逻辑是否已经被股价透支？", mustUseEvidence: true },
    { id: "bubble-memory", mode: "industry", prompt: "存储芯片涨价周期中哪些公司容易业绩透支？", mustUseEvidence: true },
  ],
  hk: [
    { id: "hk-tencent", mode: "target", prompt: "腾讯控股当前核心投资矛盾是什么？", mustUseEvidence: true },
    { id: "hk-xiaomi", mode: "target", prompt: "小米集团-W的汽车业务应该加分还是扣分？", mustUseEvidence: true },
    { id: "hk-ubtech", mode: "target", prompt: "优必选港股估值合理吗？", mustUseEvidence: true },
    { id: "hk-baiyunshan", mode: "target", prompt: "白云山港股和A股逻辑有什么区别？", mustUseEvidence: true },
    { id: "hk-internet-buyback", mode: "industry", prompt: "港股互联网回购是不是主要上涨动力？", mustUseEvidence: true },
    { id: "hk-innovation-drug", mode: "industry", prompt: "港股创新药是否比A股更有弹性？", mustUseEvidence: true },
    { id: "hk-property", mode: "industry", prompt: "港股地产和内房风险是否已经充分定价？", mustUseEvidence: true },
    { id: "hk-telecom", mode: "industry", prompt: "港股电讯高股息值得配置吗？", mustUseEvidence: true },
    { id: "hk-insurance", mode: "industry", prompt: "港股保险估值修复需要什么证据？", mustUseEvidence: true },
    { id: "hk-ah-premium", mode: "industry", prompt: "AH折溢价能否带来套利或配置机会？", mustUseEvidence: true },
  ],
  us: [
    { id: "us-nvidia", mode: "target", prompt: "英伟达未来两年最关键的反证是什么？", mustUseEvidence: true },
    { id: "us-apple", mode: "target", prompt: "苹果现在更像现金牛还是成长股？", mustUseEvidence: true },
    { id: "us-msft", mode: "target", prompt: "微软AI投入对利润率的压力大吗？", mustUseEvidence: true },
    { id: "us-amazon", mode: "target", prompt: "亚马逊云和零售哪个更影响估值？", mustUseEvidence: true },
    { id: "us-tesla", mode: "target", prompt: "特斯拉现在的估值更依赖汽车还是机器人？", mustUseEvidence: true },
    { id: "us-ai-capex", mode: "industry", prompt: "美股AI资本开支还能持续多久？", mustUseEvidence: true },
    { id: "us-semiconductor", mode: "industry", prompt: "美国半导体周期和A股半导体有什么传导关系？", mustUseEvidence: true },
    { id: "us-rate", mode: "industry", prompt: "美国利率变化对成长股估值影响怎么量化？", mustUseEvidence: true },
    { id: "us-cybersecurity", mode: "industry", prompt: "网络安全SaaS是不是稳定成长行业？", mustUseEvidence: true },
    { id: "us-healthcare", mode: "industry", prompt: "美股医疗龙头适合做防御配置吗？", mustUseEvidence: true },
  ],
  portfolio: [
    { id: "portfolio-watchlist", mode: "chat", prompt: "根据我的自选股，哪些需要优先排雷？", mustUseEvidence: true },
    { id: "portfolio-concentration", mode: "chat", prompt: "如果我的组合里AI和新能源太多，风险在哪里？", mustUseEvidence: true },
    { id: "portfolio-barbell", mode: "chat", prompt: "高股息和AI成长做杠铃组合是否合理？", mustUseEvidence: true },
    { id: "portfolio-drawdown", mode: "chat", prompt: "如何给自选股设置最大回撤触发条件？", mustUseEvidence: true },
    { id: "portfolio-ranking", mode: "chat", prompt: "自选股排行里公司质量分和投资吸引力分应该怎么权衡？", mustUseEvidence: true },
    { id: "portfolio-add", mode: "chat", prompt: "如果只能从自选股里加仓一只，应该先看哪些证据？", mustUseEvidence: true },
    { id: "portfolio-trim", mode: "chat", prompt: "如果要减仓，应该优先卖逻辑变差还是估值过高的公司？", mustUseEvidence: true },
    { id: "portfolio-cash", mode: "chat", prompt: "什么时候应该保留现金而不是买高股息？", mustUseEvidence: true },
    { id: "portfolio-rebalance", mode: "chat", prompt: "如何按证据变化而不是股价涨跌调整组合？", mustUseEvidence: true },
    { id: "portfolio-watch", mode: "chat", prompt: "帮我设计自选股每周复盘清单。", mustUseEvidence: false },
  ],
  contrarian: [
    { id: "contrarian-bank", mode: "industry", prompt: "市场都说银行高股息安全，哪里可能错？", mustUseEvidence: true },
    { id: "contrarian-pv", mode: "industry", prompt: "市场都说光伏没救了，反向机会在哪里？", mustUseEvidence: true },
    { id: "contrarian-maotai", mode: "target", prompt: "市场都说茅台不增长了，这个观点哪里可能错？", mustUseEvidence: true },
    { id: "contrarian-robot", mode: "industry", prompt: "市场都炒人形机器人，最容易忽略的负面证据是什么？", mustUseEvidence: true },
    { id: "contrarian-cxo", mode: "industry", prompt: "CXO被低估还是基本面确实坏了？", mustUseEvidence: true },
    { id: "contrarian-vanke", mode: "target", prompt: "万科A如果不是价值陷阱，需要哪些证据？", mustUseEvidence: true },
    { id: "contrarian-nvidia", mode: "target", prompt: "英伟达如果不是泡沫，需要哪些兑现证据？", mustUseEvidence: true },
    { id: "contrarian-liquor", mode: "industry", prompt: "白酒如果还能复苏，先看什么领先指标？", mustUseEvidence: true },
    { id: "contrarian-hk", mode: "industry", prompt: "港股互联网如果还有大机会，必须满足什么条件？", mustUseEvidence: true },
    { id: "contrarian-lithium", mode: "industry", prompt: "锂矿如果周期见底，先出现哪些信号？", mustUseEvidence: true },
  ],
  tooling: [
    { id: "tooling-latest", mode: "chat", prompt: "查一下最新港股互联网回购和利润修复情况，然后给结论。", mustUseEvidence: true },
    { id: "tooling-external", mode: "target", prompt: "用最新外部信息补充优必选人形机器人技术进展。", mustUseEvidence: true },
    { id: "tooling-search", mode: "industry", prompt: "联网查一下光伏硅料价格和行业出清进度。", mustUseEvidence: true },
    { id: "tooling-news", mode: "target", prompt: "查一下宁德时代最近有没有影响估值的重大新闻。", mustUseEvidence: true },
    { id: "tooling-global", mode: "industry", prompt: "查一下全球AI服务器资本开支是否有放缓迹象。", mustUseEvidence: true },
    { id: "tooling-source-check", mode: "chat", prompt: "把你用于判断银行高股息风险的来源按硬证据和线索分层。", mustUseEvidence: true },
    { id: "tooling-no-search", mode: "chat", prompt: "不用联网，用站内证据说明当前自选股最需要补什么数据。", mustUseEvidence: true },
    { id: "tooling-radar", mode: "industry", prompt: "根据最新雷达，哪些行业从观察升级成正式结论的可能性最高？", mustUseEvidence: true },
    { id: "tooling-template", mode: "target", prompt: "结合已有模板报告，指出英伟达最脆弱的投资假设。", mustUseEvidence: true },
    { id: "tooling-cache", mode: "chat", prompt: "重复问一个类似问题时，你应如何保持口径稳定？", mustUseEvidence: false },
  ],
};

export const ASSISTANT_QUALITY_PROMPTS: AssistantQualityPrompt[] = Object.entries(promptBank).flatMap(([category, prompts]) =>
  prompts.map((prompt) => ({ ...prompt, category: category as AssistantQualityPrompt["category"] })),
);

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
