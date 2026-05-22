#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { jsonrepair } from "jsonrepair";

const RADAR_CACHE_VERSION = "v2";
const RADAR_VALID_HOURS = 12;
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const EVIDENCE_WEIGHTS = {
  hard_data: 5,
  official: 4,
  announcement: 4,
  market: 3,
  news: 2,
  research: 1,
};
const TOPIC_RULES = [
  ["平稳现金流/高股息", /平稳|高股息|分红|现金流|公用事业|电信|水电|运营商|煤炭|高速公路/i],
  ["半导体/AI算力", /半导体|存储|DRAM|NAND|HBM|芯片|算力|AI|服务器|数据中心|光模块|PCB|CPO/i],
  ["战略有色金属", /有色|铜|铝|钨|稀土|金|银|锂|钴|镍|矿/i],
  ["锂电储能", /锂电|电池|储能|碳酸锂|磷酸铁锂|固态电池/i],
  ["光伏产业链", /光伏|硅料|硅片|组件|逆变器|电池片|TOPCon|BC电池/i],
  ["生猪养殖", /猪价|生猪|能繁母猪|养殖|猪肉/i],
  ["汽车/智能驾驶", /汽车|新能源车|乘用车|智能驾驶|出口|车企|销量/i],
  ["创新药/医疗服务", /创新药|医药|医疗|临床|审批|CXO|医保|药监|化学制药/i],
  ["电力电网/能源基础设施", /电力|电网|发电量|装机|特高压|变压器|储能电站/i],
  ["钢铁水泥/地产链", /钢铁|水泥|地产|房地产|玻璃|建材|开工率/i],
  ["航运物流", /航运|运价|集运|港口|物流|BDI|CCFI|SCFI/i],
  ["消费出海", /消费|品牌出海|跨境|家电|纺织|食品饮料|旅游/i],
  ["机器人/AI应用", /机器人|人形机器人|具身智能|AI应用|大模型/i],
];
const STAGE_ALIAS_RULES = [
  ["半导体/AI算力", /半导体|AI算力|算力|芯片|晶圆|封测|存储|DRAM|NAND|HBM|光模块|PCB|CPO/i],
  ["创新药/医疗服务", /创新药|医疗服务|医药|医疗|CXO|CRO|CDMO|制药|药/i],
  ["电网设备", /电网|特高压|输变电|配网|变压器|电力设备|能源基础设施/i],
  ["锂电储能", /锂电|储能|电池|碳酸锂|锂矿|锂盐/i],
  ["航运物流", /航运|集运|油运|港口|物流|BDI|SCFI|CCFI/i],
  ["地产链", /地产链|房地产|地产开发|房地产开发|房地产服务|房企|保交楼|销售面积|新开工|竣工/i],
  ["传统燃油车/零部件", /传统燃油车|燃油车|汽车零部件/i],
  ["光伏产业链", /光伏|硅料|硅片|组件|逆变器|电池片/i],
  ["钢铁水泥/地产链", /钢铁|水泥|玻璃|建材|开工率/i],
];
const STAGE_PRIORITY = {
  衰退: 50,
  泡沫风险: 45,
  扎实增长: 40,
  即将增长: 35,
  平稳现金流: 30,
  继续观察: 20,
  证据不足: 10,
};
const NON_AH_PATTERNS = [
  /美光|Micron/i,
  /英伟达|NVIDIA/i,
  /苹果|Apple/i,
  /特斯拉|Tesla/i,
  /ASML/i,
  /台积电|TSMC/i,
  /微软|Microsoft/i,
  /谷歌|Alphabet|Google/i,
  /亚马逊|Amazon/i,
  /Meta/i,
  /博通|Broadcom/i,
  /AMD/i,
  /英特尔|Intel/i,
  /三星|Samsung/i,
  /SK海力士|SK Hynix|Hynix/i,
  /维通利/i,
  /\([A-Z]{1,6}\.(O|N|NASDAQ|NYSE|US)\)/i,
];
const UNSUITABLE_REPRESENTATIVE_PATTERNS = [/^\*?ST/i, /^退市/i, /退市|风险警示/i];
const REPRESENTATIVE_CONTEXT_RULES = [
  {
    pattern: /生猪|猪价|猪周期|猪肉/i,
    required: /生猪|猪价|猪周期|猪肉|猪企|养猪|母猪|牧原|温氏|新希望|天邦|傲农|正邦|唐人神|巨星农牧/i,
  },
  {
    pattern: /光伏|硅料|硅片|组件|逆变器|电池片|多晶硅|工业硅/i,
    required: /光伏|硅料|硅片|组件|逆变器|电池片|多晶硅|工业硅|TOPCon|BC电池/i,
  },
  {
    pattern: /航运|运价|集运|港口|物流|BDI|CCFI|SCFI/i,
    required: /航运|运价|集运|港口|物流|BDI|CCFI|SCFI|船/i,
  },
  {
    pattern: /地产|房地产|水泥|建材|玻璃|竣工|开工/i,
    required: /地产|房地产|房企|物业|水泥|建材|玻璃|竣工|开工|销售面积/i,
  },
  {
    pattern: /电网|电力设备|特高压|输变电|变压器/i,
    required: /电网|电力设备|特高压|输变电|变压器|电气|电工|电源|配网/i,
  },
  {
    pattern: /锂电|储能|电池|碳酸锂|锂矿/i,
    required: /锂|储能|电池|碳酸锂|能源金属|正极|负极|电解液/i,
  },
  {
    pattern: /煤炭|煤价|动力煤|焦煤/i,
    required: /煤炭|煤矿|动力煤|焦煤|平煤|中煤|兖矿|陕西煤业|山煤|潞安|晋控煤业|中国神华/i,
  },
  {
    pattern: /煤电|火电/i,
    required: /煤电|火电|电力|能源|华能|华电|大唐|国电|晋控电力/i,
  },
  {
    pattern: /燃油车|传统燃油|汽车零部件/i,
    required: /燃油|传统燃油|整车|商用车|汽车零部件|车桥|曙光|福田|上汽/i,
  },
  {
    pattern: /汽车|智能驾驶|新能源车/i,
    required: /汽车|车企|乘用车|整车|零部件|智能驾驶|新能源车/i,
  },
  {
    pattern: /创新药|医疗服务|医药|医疗器械|CXO|制药|药/i,
    required: /创新药|医药|医疗|医疗器械|CXO|CRO|CDMO|临床|药|制药|生物|药明|康德|迪哲|百奥/i,
  },
  {
    pattern: /存储|DRAM|NAND|HBM/i,
    required: /存储|DRAM|NAND|HBM|德明利|佰维|兆易|北京君正/i,
  },
  {
    pattern: /半导体|芯片/i,
    required: /半导体|芯片|封测|晶圆|材料|设备|德明利|佰维|兆易|北京君正/i,
  },
];
const DISALLOWED_COMPANY_CONTEXT_RULES = [
  { company: /万通发展/i, context: /地产|房地产|地产链|物业/i },
  { company: /南网储能/i, context: /水电|来水|水力发电|锂电|锂盐|锂矿|电池/i },
  { company: /崧盛股份/i, context: /电网|特高压|输变电|变压器|配网/i },
  { company: /帝尔激光/i, context: /硅料|硅片|组件|多晶硅|工业硅|光伏产业链/i, allow: /设备|激光|电池片|工艺/i },
  { company: /林州重机/i, context: /煤炭|煤价|煤矿|动力煤|焦煤/i },
  { company: /晋控电力/i, context: /煤炭|煤价|煤矿|动力煤|焦煤/i },
];
const CONCLUSION_STRENGTHS = ["正式结论", "观察", "证据不足"];
const EVIDENCE_GAPS = ["缺财报", "缺价格", "缺销量", "缺订单", "缺库存", "缺产能", "缺现金流", "缺政策细则", "缺公司公告", "缺多源验证"];
const DRIVER_TAGS = ["需求", "价格", "技术", "政策", "市占率", "供给收缩"];
const SUSTAINABILITY_TIERS = ["短期催化", "中期景气", "长期护城河"];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jobId = requiredArg(args, "job-id");
  const evidence = readJsonFile(requiredArg(args, "evidence"));
  const previousPayload = readOptionalJsonFile(args.previous);
  const previousScan = previousPayload?.radar ?? null;
  const industryPackets = normalizeIndustryPackets(evidence.industryPackets);
  const industryScope = partitionIndustryPackets(industryPackets, previousScan);
  const digest = buildEvidenceDigest(Array.isArray(evidence.sources) ? evidence.sources : [], industryPackets);
  const structuredFacts = {
    financialFacts: Array.isArray(evidence.financialFacts) ? evidence.financialFacts.slice(0, 120) : [],
    industryFacts: Array.isArray(evidence.industryFacts) ? evidence.industryFacts.slice(0, 160) : [],
    companyCandidates: Array.isArray(evidence.companyCandidates) ? evidence.companyCandidates.slice(0, 120) : [],
    industryPackets,
  };
  const body = buildRadarRequestBody(digest, structuredFacts, previousScan, evidence.asOfDate, industryScope);
  if (args["debug-request-output"]) writeJsonFile(args["debug-request-output"], body);

  let modelPayload;
  let tokenUsage;
  if (args["mock-model-output"]) {
    modelPayload = readJsonFile(args["mock-model-output"]);
  } else if (args["mock-deepseek-response"]) {
    const parsed = parseDeepSeekResponsePayload(readJsonFile(args["mock-deepseek-response"]));
    modelPayload = parsed.output;
    tokenUsage = parsed.tokenUsage;
  } else {
    const parsed = await callDeepSeek(body);
    modelPayload = parsed.output;
    tokenUsage = parsed.tokenUsage;
  }

  const radar = normalizeRadarScan(modelPayload, digest, previousScan, evidence.asOfDate, industryScope);
  const cachePayload = {
    version: RADAR_CACHE_VERSION,
    cachedAt: new Date().toISOString(),
    radar,
  };
  const job = {
    id: jobId,
    status: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    evidenceHash: evidence.evidenceHash,
    message: "后台深度分析完成。",
    radarGeneratedAt: radar.generatedAt,
    ...(tokenUsage ? { tokenUsage } : {}),
  };
  if (args["output-radar"]) writeJsonFile(args["output-radar"], cachePayload);
  if (args["output-job"]) writeJsonFile(args["output-job"], job);
  if (args["output-d1-sql"]) writeTextFile(args["output-d1-sql"], buildRadarD1Sql(radar, evidence, jobId));
}

function buildRadarRequestBody(digest, structuredFacts, previousScan, asOfDate, industryScope) {
  const stableEvidence = stableRadarEvidencePayload(digest, structuredFacts);
  const volatileContext = {
    analysisScope: compactIndustryScopeForModel(industryScope),
    asOfDate: asOfDate || new Date().toISOString().slice(0, 10),
    previousScan: previousScan ? summarizePreviousScan(previousScan) : null,
  };
  return {
    model: DEEPSEEK_MODEL,
    reasoning_effort: "max",
    response_format: { type: "json_object" },
    stream: false,
    temperature: 0.12,
    max_tokens: 24000,
    messages: [
      {
        role: "system",
        content:
          "你是 CSTD Alpha 的行业雷达分析师。只输出 JSON。你必须基于结构化证据、公开来源和产业逻辑做投资雷达判断。不要编造具体数据；证据不足的方向只能进入覆盖复核或观察，不要冒充正式结论。",
      },
      {
        role: "user",
        content: stableJsonStringify({
          task: "生成全市场增长、泡沫与衰退扫描。重点识别扎实增长、强观察、周期反转、泡沫/过热、衰退、平稳现金流，并给出 A/H 代表公司。",
          evidenceRules: [
            "信息差必须来自价格变化、财报拐点、业绩预告、销量/订单边际变化、产业链利润迁移，不能只复述新闻标题。",
            "已验证结论至少需要价格/销量/财报/公告/多源证据之一；财报和行业硬数据优先级高于市场热度。",
            "强观察可以使用行业硬数据加公司候选，但必须写清仍缺什么证据。",
            "弱线索只进入 coverageReview 或 limitations，不进入正式结论区。",
            "代表公司只能列 A 股或港股上市公司；海外公司只能作为产业证据出现，不能进入 companies、representativeCompanies、stageCompanies。",
            "净利润同比超过 1000% 必须按低基数或一次性修复处理，不能单独证明扎实增长；必须同时看营收、毛利率、经营现金流和行业硬数据。",
            "每个行业条目必须引用 sourceIds，绑定 evidenceDigest.citations 中的 S1/S2 等证据编号。",
            "每个结论必须写反证条件：什么价格、销量、订单、财报、政策或供给信号出现后应撤销判断。",
            "输出必须包含本次 vs 上次：新增、升级、降级、维持、撤销。",
            "全行业扫描必须以 analysisScope 为准：changedIndustryPackets 是本轮需要深度重判的行业，unchangedIndustrySummaries 是已扫描但证据未明显变化的行业，不能写成未覆盖。",
            "对 unchanged 行业除非有强反证，不要重写长期判断；可沿用 previousScan 中稳定结论。",
          ],
          expectedJsonShape: radarJsonShape(),
        }),
      },
      {
        role: "user",
        content: stableJsonStringify(stableEvidence),
      },
      {
        role: "user",
        content: stableJsonStringify(volatileContext),
      },
    ],
  };
}

function stableRadarEvidencePayload(digest, structuredFacts) {
  const compactDigest = compactDigestForModel(digest);
  return {
    evidenceDigest: {
      ...compactDigest,
      citations: sortedByStableKey(compactDigest.citations, (item) => stringValue(item.id) || citationSortKey(item)),
      packets: sortedByStableKey(compactDigest.packets, (item) => stringValue(item.topic)),
      softCoverage: sortedByStableKey(compactDigest.softCoverage, (item) => stringValue(item.label)),
    },
    structuredFacts: {
      financialFacts: sortedByStableKey(structuredFacts.financialFacts.slice(0, 120).map(compactFinancialFact), factSortKey),
      industryFacts: sortedByStableKey(structuredFacts.industryFacts.slice(0, 120).map(compactIndustryFact), factSortKey),
      companyCandidates: sortedByStableKey(structuredFacts.companyCandidates.slice(0, 120).map(compactCompanyCandidate), factSortKey),
      industryPackets: sortedByStableKey(arrayValue(structuredFacts.industryPackets).map(compactStableIndustryPacket), industrySortKey),
    },
  };
}

function compactStableIndustryPacket(packet) {
  return {
    group: stringValue(packet.group),
    industry: stringValue(packet.industry),
    evidenceHash: stringValue(packet.evidenceHash),
    sourceCount: typeof packet.sourceCount === "number" ? packet.sourceCount : undefined,
    evidenceTypes: stringArray(packet.evidenceTypes),
    signalTypes: stringArray(packet.signalTypes),
    evidenceGaps: normalizeEvidenceGaps(packet.evidenceGaps),
    themes: stringArray(packet.themes).slice(0, 8),
    scores: scoreIndustryPacket(packet),
    factCounts: {
      financial: arrayValue(packet.financialFacts).length,
      industry: arrayValue(packet.industryFacts).length,
      companies: arrayValue(packet.companyCandidates).length,
    },
  };
}

function sortedByStableKey(values, keyFn) {
  return arrayValue(values)
    .map((value, index) => ({ value, key: `${keyFn(value) || ""}\u0000${index}` }))
    .sort((left, right) => left.key.localeCompare(right.key, "zh-Hans-CN"))
    .map((entry) => entry.value);
}

function industrySortKey(item) {
  return `${stringValue(item.group)}|${stringValue(item.industry)}`;
}

function citationSortKey(item) {
  return `${stringValue(item.source)}|${stringValue(item.publishedAt)}|${stringValue(item.title)}|${stringValue(item.url)}`;
}

function factSortKey(item) {
  return `${stringValue(item.industry)}|${stringValue(item.company)}|${stringValue(item.code)}|${stringValue(item.metric)}|${stringValue(item.publishedAt)}|${stringValue(item.title)}`;
}

async function callDeepSeek(body) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");
  const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`DeepSeek failed: ${response.status} ${text.slice(0, 400)}`);
  const payload = JSON.parse(text);
  try {
    return parseDeepSeekResponsePayload(payload);
  } catch (error) {
    const content = payload.choices?.[0]?.message?.content;
    if (!content?.trim()) throw error;
    const repaired = await repairDeepSeekJsonContent(content, apiKey);
    return {
      output: parseModelJsonContent(repaired.outputText),
      tokenUsage: mergeDeepSeekUsage(normalizeDeepSeekUsage(payload.usage), repaired.tokenUsage),
    };
  }
}

function parseDeepSeekResponsePayload(payload) {
  const content = payload.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new Error("DeepSeek returned empty content");
  return {
    output: parseModelJsonContent(content),
    tokenUsage: normalizeDeepSeekUsage(payload.usage),
  };
}

function parseModelJsonContent(content) {
  const candidates = jsonContentCandidates(content);
  const errors = [];
  for (const candidate of candidates) {
    try {
      return JSON.parse(jsonrepair(candidate));
    } catch (error) {
      errors.push(error);
    }
  }
  const lastError = errors.at(-1);
  throw new Error(lastError?.message || "DeepSeek returned invalid JSON");
}

function jsonContentCandidates(content) {
  const text = String(content).trim();
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map((match) => match[1].trim()).filter(Boolean);
  const objectText = extractJsonObjectText(withoutFence);
  return unique([text, withoutFence, ...fenced, objectText].filter(Boolean));
}

function extractJsonObjectText(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return "";
  return text.slice(start, end + 1).trim();
}

async function repairDeepSeekJsonContent(content, apiKey) {
  const repairBody = {
    model: DEEPSEEK_MODEL,
    response_format: { type: "json_object" },
    stream: false,
    temperature: 0,
    max_tokens: 24000,
    messages: [
      {
        role: "system",
        content: "你是 JSON 修复器。只输出一个合法 JSON 对象，不要解释，不要新增事实，不要改写字段含义。",
      },
      {
        role: "user",
        content: `修复下面内容为合法 JSON。保持原有键和值，删除 Markdown、注释、尾随解释和非法片段：\n${String(content).slice(0, 160000)}`,
      },
    ],
  };
  const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(repairBody),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`DeepSeek JSON repair failed: ${response.status} ${text.slice(0, 400)}`);
  const payload = JSON.parse(text);
  const outputText = payload.choices?.[0]?.message?.content;
  if (!outputText?.trim()) throw new Error("DeepSeek JSON repair returned empty content");
  return { outputText, tokenUsage: normalizeDeepSeekUsage(payload.usage) };
}

function mergeDeepSeekUsage(primary, fallback) {
  const promptTokens = (primary.promptTokens ?? 0) + (fallback.promptTokens ?? 0);
  const promptCacheHitTokens = (primary.promptCacheHitTokens ?? 0) + (fallback.promptCacheHitTokens ?? 0);
  const promptCacheMissTokens = (primary.promptCacheMissTokens ?? 0) + (fallback.promptCacheMissTokens ?? 0);
  const completionTokens = (primary.completionTokens ?? 0) + (fallback.completionTokens ?? 0);
  const totalTokens = (primary.totalTokens ?? 0) + (fallback.totalTokens ?? 0);
  const cacheBase = promptCacheHitTokens + promptCacheMissTokens;
  return {
    promptTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    completionTokens,
    totalTokens,
    cacheHitRate: cacheBase > 0 ? Number((promptCacheHitTokens / cacheBase).toFixed(4)) : undefined,
  };
}

function normalizeDeepSeekUsage(rawUsage) {
  const promptTokens = numericUsage(rawUsage?.prompt_tokens);
  const promptCacheHitTokens = numericUsage(rawUsage?.prompt_cache_hit_tokens);
  const explicitMiss = numericUsage(rawUsage?.prompt_cache_miss_tokens);
  const promptCacheMissTokens = explicitMiss || Math.max(0, promptTokens - promptCacheHitTokens);
  const completionTokens = numericUsage(rawUsage?.completion_tokens);
  const totalTokens = numericUsage(rawUsage?.total_tokens);
  const cacheInputTokens = promptCacheHitTokens + promptCacheMissTokens;
  return {
    model: DEEPSEEK_MODEL,
    calls: 1,
    promptTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    completionTokens,
    totalTokens,
    cacheHitRate: cacheInputTokens ? Number((promptCacheHitTokens / cacheInputTokens).toFixed(4)) : 0,
  };
}

function numericUsage(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeIndustryPackets(value) {
  return arrayValue(value)
    .map((item) => {
      const record = isRecord(item) ? item : {};
      const industry = stringValue(record.industry);
      if (!industry) return null;
      return {
        group: stringValue(record.group) || "未分组",
        industry,
        status: stringValue(record.status) || "scanned",
        evidenceHash: stringValue(record.evidenceHash) || fingerprint([record]),
        sourceCount: typeof record.sourceCount === "number" ? record.sourceCount : arrayValue(record.sources).length,
        evidenceTypes: enumArray(record.evidenceTypes, Object.keys(EVIDENCE_WEIGHTS)),
        signalTypes: stringArray(record.signalTypes),
        themes: stringArray(record.themes).slice(0, 8),
        sources: arrayValue(record.sources).slice(0, 12),
        financialFacts: arrayValue(record.financialFacts).slice(0, 10),
        industryFacts: arrayValue(record.industryFacts).slice(0, 10),
        companyCandidates: arrayValue(record.companyCandidates).slice(0, 10),
        evidenceGaps: normalizeEvidenceGaps(record.evidenceGaps).slice(0, 6),
      };
    })
    .filter(Boolean);
}

function partitionIndustryPackets(industryPackets, previousScan) {
  const previousByIndustry = new Map(arrayValue(previousScan?.industryPackets).map((packet) => [packet.industry, packet]));
  const changed = [];
  const unchanged = [];
  for (const packet of industryPackets) {
    const previous = previousByIndustry.get(packet.industry);
    if (previous?.evidenceHash && previous.evidenceHash === packet.evidenceHash) unchanged.push({ ...packet, previousSourceCount: previous.sourceCount, changeStatus: "unchanged" });
    else changed.push({ ...packet, previousSourceCount: previous?.sourceCount, changeStatus: previous ? "changed" : "new" });
  }
  return {
    totalIndustryCount: industryPackets.length,
    changed,
    unchanged,
    previousIndustryCount: previousByIndustry.size,
  };
}

function compactIndustryScopeForModel(scope) {
  return {
    totalIndustryCount: scope.totalIndustryCount,
    changedIndustryCount: scope.changed.length,
    unchangedIndustryCount: scope.unchanged.length,
    changedIndustryPackets: scope.changed.map(compactIndustryPacket),
    unchangedIndustrySummaries: scope.unchanged.slice(0, 80).map((packet) => ({
      group: packet.group,
      industry: packet.industry,
      evidenceHash: packet.evidenceHash,
      sourceCount: packet.sourceCount,
      evidenceTypes: packet.evidenceTypes,
      signalTypes: packet.signalTypes,
      evidenceGaps: packet.evidenceGaps,
      themes: packet.themes,
      scores: scoreIndustryPacket(packet),
      note: "本轮已扫描，证据 hash 未变化；可复用上次稳定结论。",
    })),
  };
}

function compactIndustryPacket(packet) {
  return {
    group: packet.group,
    industry: packet.industry,
    changeStatus: packet.changeStatus,
    evidenceHash: packet.evidenceHash,
    sourceCount: packet.sourceCount,
    evidenceTypes: packet.evidenceTypes,
    signalTypes: packet.signalTypes,
    evidenceGaps: packet.evidenceGaps,
    themes: packet.themes,
    scores: scoreIndustryPacket(packet),
    sources: packet.sources.slice(0, 1).map((source) => ({
      source: source.source,
      title: trimText(source.title, 70),
      sourceType: source.sourceType,
      signalType: source.signalType,
      publishedAt: source.publishedAt,
    })),
    factCounts: {
      financial: packet.financialFacts.length,
      industry: packet.industryFacts.length,
      companies: packet.companyCandidates.length,
    },
  };
}

function compactFinancialFact(fact) {
  return {
    source: stringValue(fact.source),
    company: stringValue(fact.company),
    code: stringValue(fact.code),
    market: stringValue(fact.market),
    industry: stringValue(fact.industry),
    metric: stringValue(fact.metric),
    value: typeof fact.value === "number" ? fact.value : undefined,
    yoy: typeof fact.yoy === "number" ? fact.yoy : undefined,
    publishedAt: stringValue(fact.publishedAt),
    title: trimText(fact.title, 100),
  };
}

function compactIndustryFact(fact) {
  return {
    source: stringValue(fact.source),
    industry: stringValue(fact.industry),
    signalType: stringValue(fact.signalType),
    sourceType: stringValue(fact.sourceType),
    publishedAt: stringValue(fact.publishedAt),
    title: trimText(fact.title, 110),
    summary: trimText(fact.summary, 120),
  };
}

function compactCompanyCandidate(candidate) {
  return {
    company: stringValue(candidate.company),
    code: stringValue(candidate.code),
    market: stringValue(candidate.market),
    industry: stringValue(candidate.industry),
    evidenceStrength: typeof candidate.evidenceStrength === "number" ? candidate.evidenceStrength : undefined,
    sourceTypes: stringArray(candidate.sourceTypes).slice(0, 4),
    triggerEvidence: trimText(candidate.triggerEvidence, 100),
  };
}

function buildEvidenceDigest(sources, industryPackets = []) {
  const packetSourceKeys = new Set(
    arrayValue(industryPackets)
      .flatMap((packet) => arrayValue(packet.sources).slice(0, 5))
      .flatMap((source) => [source.url, source.sourceId, source.title])
      .filter(Boolean),
  );
  const citations = dedupeSources(sources.map(classifySource))
    .sort((left, right) => sourceDigestPriority(right, packetSourceKeys) - sourceDigestPriority(left, packetSourceKeys))
    .slice(0, 220)
    .map((source, index) => ({ ...source, id: `S${index + 1}` }));
  const groups = new Map();
  for (const citation of citations) {
    const topic = inferTopic(citation);
    groups.set(topic, [...(groups.get(topic) ?? []), citation]);
  }
  const sourcePackets = [...groups.entries()]
    .map(([topic, group]) => {
      const sorted = [...group].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
      const evidenceTypes = unique(sorted.map((source) => source.sourceType)).sort((left, right) => EVIDENCE_WEIGHTS[right] - EVIDENCE_WEIGHTS[left]);
      const signalTypes = unique(sorted.map((source) => source.signalType).filter(Boolean));
      return {
        topic,
        score: sorted.reduce((sum, source) => sum + (source.score ?? 0), 0),
        sourceCount: group.length,
        sourceIds: sorted.slice(0, 8).map((source) => source.id),
        evidenceTypes,
        signalTypes,
        summary: `${topic}共 ${group.length} 条来源，证据类型：${evidenceTypes.join("、")}${signalTypes.length ? `，信号：${signalTypes.join("、")}` : ""}。`,
        signals: sorted.slice(0, 8).map((source) => `${source.id}${source.signalType ? ` [${source.signalType}]` : ""} ${source.title}${source.summary ? `：${source.summary}` : ""}`),
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 24);
  const covered = new Set(sourcePackets.map((packet) => packet.topic));
  const emptyIndustryPackets = industryPackets
    .filter((packet) => !covered.has(packet.industry))
    .map((packet) => {
      const packetSourceKeys = new Set(packet.sources.flatMap((source) => [source.url, source.title]).filter(Boolean));
      const exactCitations = citations.filter((source) => packetSourceKeys.has(source.url) || packetSourceKeys.has(source.title));
      const relatedCitations = (exactCitations.length ? exactCitations : citations
        .map((source) => ({ source, score: keywordOverlapScore(`${packet.industry} ${(packet.themes ?? []).join(" ")}`, `${source.query} ${source.title} ${source.summary ?? ""} ${source.industry ?? ""}`) + (source.industry === packet.industry ? 3 : 0) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 8)
        .map((item) => item.source));
      const sourceIds = relatedCitations.map((source) => source.id);
      return {
        topic: packet.industry,
        score: packet.sourceCount || 0,
        sourceCount: packet.sourceCount ?? sourceIds.length,
        sourceIds,
        evidenceTypes: packet.evidenceTypes?.length ? packet.evidenceTypes : unique(relatedCitations.map((source) => source.sourceType)),
        signalTypes: packet.signalTypes?.length ? packet.signalTypes : unique(relatedCitations.map((source) => source.signalType).filter(Boolean)),
        summary: `${packet.industry}已完成扫描，当前结构化证据 ${packet.sourceCount ?? sourceIds.length} 条。`,
        signals: relatedCitations.slice(0, 5).map((source) => `${source.id}${source.signalType ? ` [${source.signalType}]` : ""} ${source.title}`),
        evidenceHash: packet.evidenceHash,
        group: packet.group,
      };
    });
  const packets = [...sourcePackets, ...emptyIndustryPackets];
  return {
    sourceFingerprint: fingerprint(citations),
    sourceCount: citations.length,
    evidenceBreakdown: summarizeBreakdown(citations),
    citations,
    packets,
    softCoverage: packets.map((packet) => ({
      label: packet.topic,
      sourceCount: packet.sourceCount ?? packet.sourceIds.length,
      evidenceTypes: packet.evidenceTypes,
      note: `${packet.topic}已扫描，是否进入结论取决于证据强度。`,
      topSourceIds: packet.sourceIds.slice(0, 5),
    })),
  };
}

function sourceDigestPriority(source, packetSourceKeys) {
  const score = Number(source.score) || 0;
  const packetSourceBonus = [source.url, source.sourceId, source.title].some((key) => key && packetSourceKeys.has(key)) ? 36 : 0;
  const structuredBonus = source.sourceType === "announcement" ? 8 : source.sourceType === "hard_data" || source.sourceType === "official" ? 6 : 0;
  return score + packetSourceBonus + structuredBonus;
}

function compactDigestForModel(digest) {
  const citationIds = new Set(digest.packets.slice(0, 12).flatMap((packet) => packet.sourceIds.slice(0, 4)));
  const prioritized = [...digest.citations.filter((source) => citationIds.has(source.id)), ...digest.citations.filter((source) => !citationIds.has(source.id))].slice(0, 70);
  return {
    sourceFingerprint: digest.sourceFingerprint,
    sourceCount: digest.sourceCount,
    evidenceBreakdown: digest.evidenceBreakdown,
    softCoverage: digest.softCoverage,
    packets: digest.packets.slice(0, 12).map((packet) => ({
      ...packet,
      sourceIds: packet.sourceIds.slice(0, 4),
      signals: packet.signals.slice(0, 3).map((signal) => trimText(signal, 160)),
    })),
    citations: prioritized.map((source) => ({
      id: source.id,
      source: source.source,
      sourceType: source.sourceType,
      signalType: source.signalType,
      query: source.query,
      title: trimText(source.title, 120),
      summary: source.summary ? trimText(source.summary, 150) : undefined,
      url: source.url,
      publishedAt: source.publishedAt,
      company: source.company,
      code: source.code,
      market: source.market,
      industry: source.industry,
      evidenceProfile: source.evidenceProfile,
      anysearchTags: source.anysearchTags,
      anysearchContentTypes: source.anysearchContentTypes,
      anysearchFreshness: source.anysearchFreshness,
      anysearchSource: source.anysearchSource,
      qualityScore: source.qualityScore,
      cached: source.cached,
    })),
  };
}

function normalizeRadarScan(value, digest, previousScan, asOfDate, industryScope) {
  const record = isRecord(value) ? value : {};
  const now = new Date();
  const generatedAt = now.toISOString();
  const validUntil = new Date(now.getTime() + RADAR_VALID_HOURS * 60 * 60 * 1000).toISOString();
  const previousTitles = previousRadarTitles(previousScan);
  const unchangedIndustries = new Set(industryScope.unchanged.map((packet) => packet.industry));
  const cleanedSections = cleanRadarSections({
    solidGrowth: reuseUnchangedRadarItems(radarItems(record.solidGrowth, previousTitles, digest, "solidGrowth"), previousScan?.solidGrowth, unchangedIndustries, digest, "solidGrowth"),
    sustainability: reuseUnchangedRadarItems(radarItems(record.sustainability, previousTitles, digest, "sustainability"), previousScan?.sustainability, unchangedIndustries, digest, "sustainability"),
    bubbleRisks: reuseUnchangedRadarItems(radarItems(record.bubbleRisks, previousTitles, digest, "bubbleRisks"), previousScan?.bubbleRisks, unchangedIndustries, digest, "bubbleRisks"),
    upcomingGrowth: reuseUnchangedRadarItems(radarItems(record.upcomingGrowth, previousTitles, digest, "upcomingGrowth"), previousScan?.upcomingGrowth, unchangedIndustries, digest, "upcomingGrowth"),
    decliningIndustries: reuseUnchangedRadarItems(radarItems(record.decliningIndustries, previousTitles, digest, "decliningIndustries"), previousScan?.decliningIndustries, unchangedIndustries, digest, "decliningIndustries"),
  });
  const balancedSections = rebalanceRadarSections(cleanedSections, industryScope, digest);
  const { solidGrowth, sustainability, bubbleRisks, upcomingGrowth, decliningIndustries } = balancedSections;
  const radarSectionItems = [...solidGrowth, ...sustainability, ...bubbleRisks, ...upcomingGrowth, ...decliningIndustries];
  const formalCoverageItems = radarSectionItems.filter((item) => item.conclusionStrength === "正式结论");
  const coverageReview = radarCoverageReview(record.coverageReview, digest, formalCoverageItems);
  const stageByIndustry = buildIndustryStageMap({ solidGrowth, sustainability, bubbleRisks, upcomingGrowth, decliningIndustries });
  const representativeLists = radarLists(record.representativeCompanies);
  const stageLists = radarLists(record.stageCompanies);
  const scan = {
    id: stringValue(record.id) || `radar-${generatedAt}`,
    title: stringValue(record.title) || "行业雷达扫描",
    generatedAt,
    asOfDate: stringValue(record.asOfDate) || asOfDate || generatedAt.slice(0, 10),
    validUntil,
    model: DEEPSEEK_MODEL,
    sourceCount: digest.sourceCount,
    sourceQueries: unique(digest.citations.map((source) => source.query)).slice(0, 80),
    evidenceBreakdown: digest.evidenceBreakdown,
    evidenceSources: digest.citations,
    softCoverage: digest.softCoverage,
    coverageReview,
    industryPackets: [...industryScope.changed, ...industryScope.unchanged].map((packet) => normalizeRadarIndustryPacket(packet, stageByIndustry)),
    analysisScope: {
      totalIndustryCount: industryScope.totalIndustryCount,
      changedIndustryCount: industryScope.changed.length,
      unchangedIndustryCount: industryScope.unchanged.length,
      previousIndustryCount: industryScope.previousIndustryCount,
    },
    confidenceSummary: conservativeConfidenceSummary(stringValue(record.confidenceSummary), digest.evidenceBreakdown),
    fromCache: false,
    executiveSummary: normalizedExecutiveSummary(balancedSections, industryScope),
    solidGrowth,
    sustainability,
    bubbleRisks,
    upcomingGrowth,
    decliningIndustries,
    representativeCompanies: mergeRadarLists(
      representativeLists,
      representativeCompanyLists(formalSectionsOnly({ solidGrowth, sustainability, bubbleRisks, upcomingGrowth, decliningIndustries })),
    ),
    stageCompanies: mergeRadarLists(stageLists, stageCompanyLists(formalSectionsOnly({ solidGrowth, sustainability, bubbleRisks, upcomingGrowth, decliningIndustries }))),
    limitations: sanitizeLimitations(record.limitations, radarSectionItems),
  };
  return {
    ...scan,
    changeLog: buildChangeLog(previousScan, scan),
  };
}

function normalizedExecutiveSummary(sections, industryScope) {
  const sectionEntries = [
    ...arrayValue(sections.solidGrowth).map((item) => ({ section: "solidGrowth", item })),
    ...arrayValue(sections.upcomingGrowth).map((item) => ({ section: "upcomingGrowth", item })),
    ...arrayValue(sections.bubbleRisks).map((item) => ({ section: "bubbleRisks", item })),
    ...arrayValue(sections.decliningIndustries).map((item) => ({ section: "decliningIndustries", item })),
    ...arrayValue(sections.sustainability).map((item) => ({ section: "sustainability", item })),
  ];
  const formalEntries = sectionEntries.filter(({ item }) => item.conclusionStrength === "正式结论");
  if (formalEntries.length) {
    const formalSummary = formalEntries.slice(0, 4).map(({ section, item }) => {
      const label = radarSectionDisplayLabel(section);
      return `${item.title}：${label}，${fixRadarText(item.thesis || "已达到正式结论门槛。")}`;
    });
    const observations = sectionEntries
      .filter(({ item }) => item.conclusionStrength !== "正式结论")
      .slice(0, Math.max(0, 5 - formalSummary.length))
      .map(({ item }) => `${item.title}：观察，${fixRadarText(item.thesis || "已扫描到公开证据，但仍需交叉验证。")}（${item.evidenceGaps?.length ? item.evidenceGaps.join("、") : "仍需交叉验证"}）`);
    return [...formalSummary, ...observations].slice(0, 5);
  }
  const packets = [...arrayValue(industryScope.changed), ...arrayValue(industryScope.unchanged)]
    .filter((packet) => (packet.sourceCount ?? 0) > 0)
    .sort((a, b) => ((b.sourceCount ?? 0) + (b.scores?.evidence ?? 0)) - ((a.sourceCount ?? 0) + (a.scores?.evidence ?? 0)))
    .slice(0, 4);
  const summary = [
    "本轮没有行业达到正式结论门槛；以下内容按观察和风险复核展示，不能视为高置信投资结论。",
    ...packets.map((packet) => {
      const stage = packet.stage || fallbackIndustryStage(packet, scoreIndustryPacket(packet));
      const displayStage = stage === "衰退" ? "衰退风险复核" : stage === "泡沫风险" ? "泡沫风险复核" : "继续观察";
      const thesis = stringValue(packet.thesis) || "已扫描到公开证据，但仍需交叉验证。";
      return `${packet.industry}：${displayStage}，${fixRadarText(thesis)}`;
    }),
  ];
  return summary.slice(0, 5);
}

function radarSectionDisplayLabel(section) {
  return {
    solidGrowth: "扎实增长",
    upcomingGrowth: "即将增长",
    bubbleRisks: "泡沫/过热风险",
    decliningIndustries: "衰退风险",
    sustainability: "可持续性判断",
  }[section] || "雷达结论";
}

function formalSectionsOnly(sections) {
  return Object.fromEntries(
    Object.entries(sections).map(([section, items]) => [
      section,
      arrayValue(items).filter((item) => item.conclusionStrength === "正式结论"),
    ]),
  );
}

function sanitizeLimitations(limitations, formalItems) {
  return stringArray(limitations)
    .filter((limitation) => {
      const matchedItem = formalItems.find((item) => {
        const labels = [item.title, ...arrayValue(item.industries)].map(stringValue).filter(Boolean);
        return labels.some((label) => limitation.includes(label));
      });
      if (!matchedItem) return true;
      const hasStructuredEvidence = arrayValue(matchedItem.evidenceTypes).some((type) => type === "announcement" || type === "hard_data" || type === "official");
      const hasCompanyEvidence = arrayValue(matchedItem.companies).length > 0;
      if (hasStructuredEvidence && hasCompanyEvidence && /仅有新闻|缺乏上市公司财报验证|缺乏财报硬数据|只由新闻/.test(limitation)) return false;
      return true;
    })
    .slice(0, 8);
}

function conservativeConfidenceSummary(summary, breakdown = {}) {
  const base = summary || "置信度按财报公告、价格/销量硬数据、市场数据和新闻线索的交叉验证强弱生成。";
  const hard = Number(breakdown.hard_data) || 0;
  const official = Number(breakdown.official) || 0;
  const announcement = Number(breakdown.announcement) || 0;
  if (hard < 30 || official <= 2) {
    const cleanedBase = fixRadarText(base).split("证据结构提示：")[0].trim();
    const confidenceBase = /^(高|较高|中高)$/.test(cleanedBase) ? "总体置信度中等" : cleanedBase;
    const conservativeBase = confidenceBase
      .replace(/总体置信度[较偏]?高/g, "总体置信度中等")
      .replace(/置信度较高/g, "置信度中等")
      .replace(/总体置信度高/g, "总体置信度中等")
      .replace(/置信度高/g, "置信度中等")
      .replace(/硬数据支撑充分/g, "硬数据仍需补强")
      .replace(/证据充分/g, "证据覆盖较强但仍需交叉验证");
    return `${conservativeBase} 证据结构提示：公告/财报 ${announcement} 条、硬数据 ${hard} 条、官方/协会 ${official} 条；官方统计或行业硬数据偏少的增长类结论按中等置信处理，需继续交叉验证。`;
  }
  return fixRadarText(base);
}

function radarItems(value, previousTitles, digest, section = "") {
  return arrayValue(value)
    .map((item) => {
      const record = isRecord(item) ? item : {};
      const title = stringValue(record.title);
      if (!title) return null;
      const sourceIds = sourceIdsForItem(record, digest);
      const normalizedEvidence = stringArray(record.evidence).slice(0, 8).map(formatExtremePercentEvidence);
      const thesis = formatExtremePercentEvidence(stringValue(record.thesis));
      const companies = evidenceBackedCompanies(ahCompanies(record.companies), sourceIds, digest, record).slice(0, 6);
      const evidenceTypes = enumArray(record.evidenceTypes, Object.keys(EVIDENCE_WEIGHTS));
      const signalSplit = splitRadarSignals(record);
      const normalized = refineRadarItemTopic(
        normalizeRadarItemCertainty(
        {
          title,
          industries: stringArray(record.industries).slice(0, 5),
          companies,
          thesis,
          drivers: stringArray(record.drivers).slice(0, 8),
          evidence: normalizedEvidence,
          conclusionStrength: enumValue(record.conclusionStrength, CONCLUSION_STRENGTHS, enumValue(record.confidence, ["低", "中", "高"], "中") === "高" ? "正式结论" : "观察"),
          evidenceGaps: evidenceGapsForItem({ ...record, thesis }, normalizedEvidence),
          driverTags: enumArray(record.driverTags, DRIVER_TAGS),
          sustainabilityTier: enumValue(record.sustainabilityTier, SUSTAINABILITY_TIERS, "中期景气"),
          durability: enumValue(record.durability, ["短期", "中期", "长期", "不确定"], "不确定"),
          riskLevel: enumValue(record.riskLevel, ["低", "中", "高"], "中"),
          confidence: enumValue(record.confidence, ["低", "中", "高"], "中"),
          evidenceTypes,
          supportingSourceCount: sourceIds.length,
          sourceIds,
          changeReason: stringValue(record.changeReason) || (previousTitles.has(title) ? "延续上次判断，等待新证据确认强弱。" : "本次证据包新增或强化该方向。"),
          counterEvidenceConditions: signalSplit.counterSignals,
          confirmationConditions: signalSplit.confirmationSignals,
          turningPoints: signalSplit.turningPoints,
        },
        digest,
        ),
        section,
      );
      return {
        ...normalized,
        title: fixRadarText(normalized.title),
        thesis: fixRadarText(normalized.thesis),
        evidence: normalized.evidence.map(fixRadarText),
        changeReason: fixRadarText(normalized.changeReason),
      };
    })
    .filter(Boolean);
}

function normalizeRadarItemCertainty(item, digest) {
  const sourceSet = new Set(item.sourceIds);
  const matchedCitations = digest.citations.filter((source) => sourceSet.has(source.id));
  const citationTypes = matchedCitations.map((source) => source.sourceType);
  const relatedPackets = relatedPacketsForRadarItem(item, digest);
  const positivePacketCompanies = positiveFinancialCompaniesForPackets(relatedPackets);
  const packetEvidenceTypes = relatedPackets.flatMap((packet) => packet.evidenceTypes ?? []);
  const packetSourceCount = Math.max(0, ...relatedPackets.map((packet) => packet.sourceCount ?? 0));
  const evidenceTypes = unique([...arrayValue(item.evidenceTypes), ...citationTypes, ...packetEvidenceTypes].filter(Boolean));
  const sourceCount = item.sourceIds.length;
  const hasHardOrOfficial = evidenceTypes.some((type) => type === "hard_data" || type === "official");
  const hasAnnouncement = evidenceTypes.includes("announcement");
  const hasMultiFamily = evidenceTypes.length >= 2;
  const citationFinancialCompanies = unique(
    matchedCitations
      .filter((source) => source.signalType === "financial_metric" || source.sourceType === "announcement")
      .filter((source) => isPositiveFinancialText(`${source.title ?? ""} ${source.summary ?? ""}`))
      .map((source) => stripTicker(source.company ?? ""))
      .filter(Boolean),
  );
  const multiCompanyFinancialEvidence = unique([...citationFinancialCompanies, ...positivePacketCompanies.map(stripTicker)]).length >= 2;
  const hasExtremePercent = /低基数|一次性因素需核验|原始[+-]?\d{4,}(?:\.\d+)?%/.test([item.title, item.thesis, ...item.evidence].join(" "));
  const relatedPacketGaps = relatedPackets.flatMap((packet) => arrayValue(packet.evidenceGaps));
  const gapSet = new Set(normalizeEvidenceGaps([...item.evidenceGaps, ...relatedPacketGaps]));
  const packetBacked = packetSourceCount >= 6 && hasHardOrOfficial && hasAnnouncement && !gapSet.has("缺财报");
  const lowBaseCrossChecked = Boolean(item._lowBaseCrossChecked) || relatedPackets.some((packet) => hasMultiplePositiveFinancialFacts(packet, 3));
  const formalReady = sourceCount >= 2 && ((hasMultiFamily || (hasHardOrOfficial && hasAnnouncement) || multiCompanyFinancialEvidence) || packetBacked);
  const lowBaseOnly = hasExtremePercent && !lowBaseCrossChecked && (!packetBacked || isLowBaseSensitiveGrowthContext(item));
  if (!hasHardOrOfficial && isGrowthConclusionContext(item) && !hasMultiFamily && !multiCompanyFinancialEvidence) gapSet.add("缺多源验证");
  const highReady = sourceCount >= 3 && hasHardOrOfficial && hasAnnouncement && !hasExtremePercent && !hasConfidenceBlockingGap(gapSet);
  if (!formalReady || lowBaseOnly) gapSet.add("缺多源验证");
  if (hasExtremePercent && !gapSet.has("缺现金流")) gapSet.add("缺现金流");
  let confidence = item.confidence;
  let conclusionStrength = item.conclusionStrength;
  if (confidence === "高" && !highReady) confidence = "中";
  if (conclusionStrength === "正式结论" && (!formalReady || lowBaseOnly)) conclusionStrength = "观察";
  const thesis = conclusionStrength === "正式结论" ? item.thesis : softenObservationText(item.thesis);
  const { _lowBaseCrossChecked, ...publicItem } = item;
  const companies = growthItemShouldUsePositivePacketCompanies(item, conclusionStrength, positivePacketCompanies)
    ? preferredPositiveCompanies(item.companies, positivePacketCompanies)
    : item.companies;
  const evidenceGaps = normalizeEvidenceGaps([...gapSet]).filter((gap) => {
    if (gap === "缺多源验证" && conclusionStrength === "正式结论" && (hasMultiFamily || multiCompanyFinancialEvidence || packetBacked)) return false;
    return true;
  });
  return {
    ...publicItem,
    companies,
    thesis,
    confidence,
    conclusionStrength,
    evidenceTypes,
    evidenceGaps,
    supportingSourceCount: sourceCount,
  };
}

function isGrowthConclusionContext(item) {
  return /增长|景气|算力|半导体|存储|有色|锂电|储能|创新药|电网|订单|利润/.test([item.title, item.thesis, ...arrayValue(item.industries), ...arrayValue(item.drivers)].join(" "));
}

function hasConfidenceBlockingGap(gapSet) {
  return ["缺财报", "缺价格", "缺销量", "缺订单", "缺库存", "缺现金流", "缺多源验证"].some((gap) => gapSet.has(gap));
}

function refineRadarItemTopic(item, section = "") {
  const text = `${item.title} ${item.thesis} ${arrayValue(item.industries).join(" ")} ${arrayValue(item.companies).join(" ")} ${arrayValue(item.evidence).join(" ")}`;
  const isStorageBacked = /存储|DRAM|NAND|HBM|德明利|佰维存储|兆易创新|北京君正|江波龙/.test(text);
  if (!/存储芯片/.test(item.title) && isStorageBacked && /半导体|AI算力|芯片|存储/.test(text)) {
    return {
      ...item,
      title: section === "sustainability" ? "存储芯片增长可持续性" : section === "upcomingGrowth" ? "存储芯片增长启动" : section === "bubbleRisks" ? "存储芯片泡沫风险" : "存储芯片景气与业绩共振",
      industries: ["存储芯片"],
      changeReason: fixRadarText(item.changeReason).replace(/半导体\/AI算力|AI算力与存储|半导体/g, "存储芯片"),
    };
  }
  return item;
}

function positiveFinancialCompaniesForPackets(packets) {
  return uniqueCompaniesByName(
    arrayValue(packets)
      .flatMap((packet) => arrayValue(packet.financialFacts))
      .filter(isPositiveFinancialFact)
      .map((fact) => fact.company)
      .filter(Boolean),
  );
}

function growthItemShouldUsePositivePacketCompanies(item, conclusionStrength, positiveCompanies) {
  if (!positiveCompanies.length) return false;
  const text = `${item.title} ${item.thesis} ${arrayValue(item.industries).join(" ")} ${arrayValue(item.drivers).join(" ")}`;
  if (conclusionStrength === "正式结论" && /增长|景气|算力|半导体|存储|锂电|储能|航运|运价|创新药|电网|订单/.test(text)) return true;
  return item.conclusionStrength === "观察" && /增长可持续性|可持续|景气|增长/.test(text);
}

function preferredPositiveCompanies(companies, positiveCompanies) {
  const positiveKeys = new Set(positiveCompanies.map((company) => cleanCompanyKey(company)));
  const filtered = arrayValue(companies).filter((company) => positiveKeys.has(cleanCompanyKey(company)));
  return uniqueCompaniesByName(filtered.length ? filtered : positiveCompanies).slice(0, 6);
}

function cleanCompanyKey(company) {
  return stripTicker(company).replace(/\s+/g, "");
}

function relatedPacketsForRadarItem(item, digest) {
  const keys = new Set([
    ...stageLookupKeys(item.title),
    ...arrayValue(item.industries).flatMap((industry) => stageLookupKeys(industry)),
  ]);
  return arrayValue(digest.packets).filter((packet) => keys.has(cleanStageKey(packet.topic)) || keys.has(canonicalIndustryKey(packet.topic)));
}

function isLowBaseSensitiveGrowthContext(item) {
  return /电网|电力设备|输变电|配网|储能|锂电|地产|房地产/.test([item.title, item.thesis, ...arrayValue(item.industries)].join(" "));
}

function softenObservationText(text) {
  return fixRadarText(text)
    .replace(/得到业绩确认/g, "出现业绩线索但仍需多源确认")
    .replace(/周期确认/g, "周期线索待确认")
    .replace(/确认(?=业绩兑现)/g, "待确认")
    .replace(/景气持续向上/g, "景气改善线索待验证")
    .replace(/龙头业绩爆发/g, "部分公司业绩高增")
    .replace(/产业链公司业绩爆发/g, "产业链公司业绩高增线索")
    .replace(/业绩爆发/g, "业绩高增线索")
    .replace(/行业触底回升/g, "触底回升线索待验证")
    .replace(/待待确认/g, "待确认")
    .replace(/待确认业绩兑现/g, "业绩兑现仍待确认")
    .replace(/周期线索业绩兑现仍待确认/g, "周期线索待验证，业绩兑现仍待确认");
}

function splitRadarSignals(record) {
  const explicitCounter = stringArray(record.counterEvidenceConditions).slice(0, 6);
  const explicitConfirmation = stringArray(record.confirmationConditions).slice(0, 6);
  const turningPoints = stringArray(record.turningPoints).slice(0, 6);
  const counterFromTurning = [];
  const confirmationFromTurning = [];
  for (const point of turningPoints) {
    if (isPositiveConfirmationSignal(point)) confirmationFromTurning.push(point);
    else if (isCounterSignal(point)) counterFromTurning.push(point);
  }
  return {
    counterSignals: unique([...explicitCounter, ...counterFromTurning]).slice(0, 6),
    confirmationSignals: unique([...explicitConfirmation, ...confirmationFromTurning]).slice(0, 6),
    turningPoints: turningPoints.filter((point) => !confirmationFromTurning.includes(point) && !counterFromTurning.includes(point)).slice(0, 6),
  };
}

function isPositiveConfirmationSignal(value) {
  const text = stringValue(value);
  return /超预期|订单落地|中标|投资计划|价格反弹|价格上行|需求回升|销量回升|现金流改善|产能出清|利润改善/i.test(text) && !isCounterSignal(text);
}

function isCounterSignal(value) {
  return /不及预期|低于预期|回落|下降|下滑|恶化|转亏|亏损扩大|失败|放缓|减弱/i.test(stringValue(value));
}

function fixRadarText(value) {
  return stringValue(value)
    .replace(/医疗服触底/g, "医疗服务触底")
    .replace(/存储芯片和存储芯片/g, "存储芯片");
}

function rebalanceRadarSections(sections, industryScope, digest) {
  const balanced = Object.fromEntries(Object.entries(sections).map(([section, items]) => [section, [...arrayValue(items)]]));
  const weakSolidGrowth = balanced.solidGrowth.filter((item) => item.conclusionStrength !== "正式结论");
  if (weakSolidGrowth.length) {
    balanced.solidGrowth = balanced.solidGrowth.filter((item) => item.conclusionStrength === "正式结论");
    balanced.sustainability = [...weakSolidGrowth, ...balanced.sustainability];
  }
  const targetFormalGrowthCount = 3;
  const candidates = supplementalSolidGrowthCandidates(balanced, industryScope, digest);

  if (!candidates.length) {
    return ensureSustainabilityObservations(promoteGrowthObservationsToTarget(balanced, targetFormalGrowthCount), industryScope, digest);
  }
  const promotedKeys = new Set(candidates.flatMap((item) => [item.title, ...arrayValue(item.industries)].flatMap((value) => stageLookupKeys(value))));
  balanced.sustainability = balanced.sustainability.filter((item) => ![item.title, ...arrayValue(item.industries)].flatMap((value) => stageLookupKeys(value)).some((key) => promotedKeys.has(key)));
  balanced.upcomingGrowth = balanced.upcomingGrowth.filter((item) => ![item.title, ...arrayValue(item.industries)].flatMap((value) => stageLookupKeys(value)).some((key) => promotedKeys.has(key)));
  const cleanedGrowthCandidates = cleanRadarSections({ ...balanced, solidGrowth: [...balanced.solidGrowth, ...candidates] }).solidGrowth;
  const formalGrowthCandidates = cleanedGrowthCandidates.filter((item) => item.conclusionStrength === "正式结论");
  const observedGrowthCandidates = cleanedGrowthCandidates.filter((item) => item.conclusionStrength !== "正式结论");
  balanced.solidGrowth = formalGrowthCandidates;
  balanced.sustainability = [...observedGrowthCandidates, ...balanced.sustainability];
  return ensureSustainabilityObservations(promoteGrowthObservationsToTarget(balanced, targetFormalGrowthCount), industryScope, digest);
}

function supplementalSolidGrowthCandidates(sections, industryScope, digest) {
  const existingFormalCount = arrayValue(sections.solidGrowth).filter((item) => item.conclusionStrength === "正式结论").length;
  const targetFormalCount = 3;
  const slots = Math.max(0, targetFormalCount - existingFormalCount);
  if (!slots) return [];
  const blockingKeys = new Set(
    [sections.solidGrowth, sections.bubbleRisks, sections.decliningIndustries]
      .flatMap((items) => arrayValue(items))
      .filter((item) => item.conclusionStrength === "正式结论")
      .flatMap((item) => [item.title, ...arrayValue(item.industries)])
      .flatMap(identityKeys),
  );
  return [...arrayValue(industryScope.changed), ...arrayValue(industryScope.unchanged)]
    .filter((packet) => qualifiesForRuleBackedSolidGrowth(packet, blockingKeys))
    .map((packet) => ruleBackedSolidGrowthItem(packet, digest))
    .filter(Boolean)
    .sort((left, right) => radarItemQuality(right) - radarItemQuality(left))
    .slice(0, slots);
}

function ensureSustainabilityObservations(sections, industryScope, digest) {
  const balanced = Object.fromEntries(Object.entries(sections).map(([section, items]) => [section, [...arrayValue(items)]]));
  const blockedSectionKeys = new Set(
    [balanced.solidGrowth, balanced.upcomingGrowth, balanced.bubbleRisks, balanced.decliningIndustries]
      .flatMap((items) => arrayValue(items))
      .flatMap((item) => [item.title, ...arrayValue(item.industries)].flatMap(identityKeys)),
  );
  balanced.sustainability = balanced.sustainability.filter((item) => {
    const itemKeys = [item.title, ...arrayValue(item.industries)].flatMap(identityKeys);
    return !itemKeys.some((key) => blockedSectionKeys.has(key));
  });
  const existingKeys = new Set(arrayValue(balanced.sustainability).flatMap((item) => [item.title, ...arrayValue(item.industries)].flatMap(identityKeys)));
  const targetSustainabilityCount = 6;
  if (balanced.sustainability.length < targetSustainabilityCount) {
    const sectionKeys = new Set([...blockedSectionKeys, ...existingKeys]);
    const packetItems = [...arrayValue(industryScope.changed), ...arrayValue(industryScope.unchanged)]
      .filter((packet) => qualifiesForSustainabilityObservation(packet, sectionKeys, digest))
      .map((packet) => ruleBackedSustainabilityItem(packet, digest))
      .filter(Boolean)
      .sort((left, right) => radarItemQuality(right) - radarItemQuality(left));
    for (const item of packetItems) {
      for (const key of [item.title, ...arrayValue(item.industries)].flatMap(identityKeys)) sectionKeys.add(key);
      balanced.sustainability.push(item);
      if (balanced.sustainability.length >= targetSustainabilityCount) break;
    }
  }

  return balanced;
}

function qualifiesForSustainabilityObservation(packet, sectionKeys, digest) {
  const keys = identityKeys(packet.industry);
  if (keys.some((key) => sectionKeys.has(key))) return rejectSustainabilityObservation(packet, "section-key-conflict", { keys });
  if (itemDeclineIsDirect(packet.industry) || isDirectStructuralDecline(packet)) return rejectSustainabilityObservation(packet, "structural-decline");
  const scores = scoreIndustryPacket(packet);
  const growthPressure = Math.max(scores.growth, scores.momentum);
  const evidenceTypes = arrayValue(packet.evidenceTypes);
  const gaps = arrayValue(packet.evidenceGaps);
  const sourceIds = sourceIdsForPacket(packet, digest).slice(0, 5);
  const matchedSources = digest.citations.filter((source) => sourceIds.includes(source.id));
  const reliableEvidence = evidenceTypes.some((type) => type === "hard_data" || type === "official" || type === "announcement");
  const sourceBackedCompanies = packetBackedCompanies(packet, sourceIds, digest);
  const hasCompany = sourceBackedCompanies.length > 0 || arrayValue(packet.companyCandidates).length > 0 || arrayValue(packet.financialFacts).length > 0;
  const hasFinancialValidation = arrayValue(packet.financialFacts).length > 0 || hasPositiveFinancialMetricSource(matchedSources);
  if ((packet.sourceCount ?? 0) < 4 || growthPressure < 52 || scores.evidence < 55) return rejectSustainabilityObservation(packet, "weak-score", { scores, growthPressure });
  if (!reliableEvidence || !hasCompany) return rejectSustainabilityObservation(packet, "missing-reliable-or-company", { reliableEvidence, hasCompany, sourceIds, sourceBackedCompanies });
  if (scores.bubbleRisk >= 60 || scores.declineRisk >= 70) return rejectSustainabilityObservation(packet, "risk-too-high", { scores });
  if (gaps.some((gap) => /缺多源验证/.test(gap)) && !(evidenceTypes.length >= 2 && (packet.sourceCount ?? 0) >= 8)) return rejectSustainabilityObservation(packet, "multi-source-gap", { gaps, evidenceTypes });
  if (gaps.some((gap) => /缺财报/.test(gap)) && !hasFinancialValidation) return rejectSustainabilityObservation(packet, "financial-gap", { gaps });
  if (hasNegativeSourceDominance(matchedSources) && growthPressure < 62) return rejectSustainabilityObservation(packet, "negative-source-dominance", { growthPressure, sourceIds });
  if (hasNegativeFinancialDominance(packet) && growthPressure < 58) return rejectSustainabilityObservation(packet, "negative-financial-dominance", { growthPressure });
  return true;
}

function rejectSustainabilityObservation(packet, reason, extra = {}) {
  if (process.env.RADAR_DEBUG_SUSTAIN) {
    console.error(JSON.stringify({ sustainReject: packet.industry, reason, sourceCount: packet.sourceCount, types: packet.evidenceTypes, gaps: packet.evidenceGaps, ...extra }));
  }
  return false;
}

function hasPositiveFinancialMetricSource(sources) {
  return arrayValue(sources).some((source) => {
    if (source.signalType !== "financial_metric" && source.sourceType !== "announcement") return false;
    return isPositiveFinancialText(`${source.title ?? ""} ${source.summary ?? ""}`);
  });
}

function hasNegativeSourceDominance(sources) {
  const financialSources = arrayValue(sources).filter((source) => source.signalType === "financial_metric" || source.sourceType === "announcement");
  if (!financialSources.length) return false;
  const positive = financialSources.filter((source) => isPositiveFinancialText(`${source.title ?? ""} ${source.summary ?? ""}`)).length;
  const negative = financialSources.filter((source) => isNegativeFinancialText(`${source.title ?? ""} ${source.summary ?? ""}`)).length;
  return negative > positive;
}

function isPositiveFinancialText(text) {
  const revenueYoy = firstPercentAfter(text, /营收同比/);
  const profitYoy = firstPercentAfter(text, /净利润同比/);
  if (/预增|略增|扭亏|利润增长|净利润增长|营收增长/.test(text) && !/预减|首亏|续亏|增亏/.test(text)) return true;
  return Number.isFinite(revenueYoy) && revenueYoy >= 8 && Number.isFinite(profitYoy) && profitYoy > 0 && profitYoy < 1000;
}

function isNegativeFinancialText(text) {
  const revenueYoy = firstPercentAfter(text, /营收同比/);
  const profitYoy = firstPercentAfter(text, /净利润同比/);
  if (/预减|首亏|续亏|增亏|亏损|下滑|下降|承压|需求减少|价格下行/.test(text)) return true;
  return (Number.isFinite(revenueYoy) && revenueYoy < 0) || (Number.isFinite(profitYoy) && profitYoy < 0);
}

function hasNegativeFinancialDominance(packet) {
  const facts = arrayValue(packet.financialFacts);
  if (!facts.length) return false;
  const positive = facts.filter(isPositiveFinancialFact).length;
  const negative = facts.filter((fact) => {
    const metrics = isRecord(fact.metrics) ? fact.metrics : {};
    const revenueYoy = numericValue(metrics.revenueYoy ?? fact.revenueYoy);
    const netProfitYoy = numericValue(metrics.netProfitYoy ?? fact.yoy);
    const netProfit = numericValue(metrics.netProfit ?? fact.value);
    return (Number.isFinite(revenueYoy) && revenueYoy < 0) || (Number.isFinite(netProfitYoy) && netProfitYoy < 0) || (Number.isFinite(netProfit) && netProfit < 0);
  }).length;
  return negative > positive;
}

function ruleBackedSustainabilityItem(packet, digest) {
  const sourceIds = sourceIdsForPacket(packet, digest).slice(0, 5);
  if (sourceIds.length < 2 && !canUseSingleCoreSourceForObservation(packet, sourceIds)) return null;
  const packetCompanyKeys = new Set(packetCompanyNames(packet).map(stripTicker));
  const backedCompanies = packetBackedCompanies(packet, sourceIds, digest).filter((company) => !packetCompanyKeys.size || packetCompanyKeys.has(stripTicker(company)));
  const companies = (backedCompanies.length ? backedCompanies : sustainabilityPacketCompanies(packet)).slice(0, 5);
  const mixedFinancialEvidence = hasNegativeFinancialDominance(packet);
  const evidenceGaps = unique([
    ...arrayValue(packet.evidenceGaps),
    ...(mixedFinancialEvidence ? ["缺现金流"] : []),
    ...(!companies.length ? ["缺公司公告"] : []),
    ...(!arrayValue(packet.financialFacts).length ? ["缺财报"] : []),
  ]);
  const evidenceLines = sourceIds
    .map((id) => digest.citations.find((source) => source.id === id))
    .filter(Boolean)
    .map((source) => formatExtremePercentEvidence(`${source.id} ${source.title}${source.summary ? `：${trimText(source.summary, 80)}` : ""}`))
    .slice(0, 5);
  return normalizeRadarItemCertainty(
    {
      title: `${packet.industry}增长可持续性`,
      industries: [packet.industry],
      companies,
      thesis: mixedFinancialEvidence
        ? `${packet.industry}已扫描到增长或景气改善线索，但公司财报表现分化，暂不升为扎实增长；本项用于跟踪增长质量、现金流、订单和后续财报确认。`
        : `${packet.industry}已扫描到增长或景气改善线索，但证据仍不足以升为扎实增长；本项用于跟踪增长质量、现金流、订单和后续财报确认。`,
      drivers: inferDriversFromPacket(packet),
      evidence: evidenceLines,
      conclusionStrength: "观察",
      evidenceGaps,
      driverTags: inferDriverTagsFromPacket(packet),
      sustainabilityTier: "中期景气",
      durability: "中期",
      riskLevel: "中",
      confidence: "中",
      evidenceTypes: arrayValue(packet.evidenceTypes),
      supportingSourceCount: sourceIds.length,
      sourceIds,
      changeReason: "规则引擎识别到较强增长线索但正式增长门槛未完全满足，补入增长可持续性观察。",
      counterEvidenceConditions: ["后续财报未延续收入和利润改善", "订单或价格数据转弱", "经营现金流恶化"],
      confirmationConditions: ["更多 A/H 公司财报共振", "订单/价格/销量硬数据继续改善", "经营现金流同步转强"],
      turningPoints: [],
    },
    digest,
  );
}

function canUseSingleCoreSourceForObservation(packet, sourceIds) {
  return sourceIds.length >= 1 && (packet.sourceCount ?? 0) >= 8 && arrayValue(packet.evidenceTypes).some((type) => type === "announcement" || type === "hard_data" || type === "official");
}

function sustainabilityPacketCompanies(packet) {
  const itemText = `${packet.industry} ${packet.group ?? ""} ${arrayValue(packet.themes).join(" ")} ${arrayValue(packet.signalTypes).join(" ")}`;
  return uniqueCompaniesByName(
    ahCompanies([
      ...arrayValue(packet.financialFacts)
        .filter(isPositiveFinancialFact)
        .map((fact) => fact.company),
      ...arrayValue(packet.companyCandidates).map((candidate) => candidate.company),
    ])
      .filter(Boolean)
      .filter((company) => companyMatchesItemContext(company, itemText, [])),
  );
}

function promoteGrowthObservationsToTarget(sections, targetFormalCount = 3) {
  const formalCount = arrayValue(sections.solidGrowth).filter((item) => item.conclusionStrength === "正式结论").length;
  const slots = Math.max(0, targetFormalCount - formalCount);
  if (!slots) return sections;
  const observationCandidates = [
    ...arrayValue(sections.upcomingGrowth).map((item) => ({ section: "upcomingGrowth", item })),
    ...arrayValue(sections.sustainability).map((item) => ({ section: "sustainability", item })),
  ]
    .filter(({ item }) => qualifiesForObservationPromotion(item))
    .sort((left, right) => radarItemQuality(right.item) - radarItemQuality(left.item));
  const balanced = Object.fromEntries(Object.entries(sections).map(([section, items]) => [section, [...arrayValue(items)]]));
  const promotedKeys = new Set(arrayValue(balanced.solidGrowth).flatMap((item) => [item.title, ...arrayValue(item.industries)].flatMap(identityKeys)));
  for (const candidate of observationCandidates) {
    if (arrayValue(balanced.solidGrowth).filter((item) => item.conclusionStrength === "正式结论").length >= targetFormalCount) break;
    const candidateKeys = [candidate.item.title, ...arrayValue(candidate.item.industries)].flatMap(identityKeys);
    if (candidateKeys.some((key) => promotedKeys.has(key))) continue;
    balanced[candidate.section] = balanced[candidate.section].filter((item) => item !== candidate.item);
    for (const key of candidateKeys) promotedKeys.add(key);
    balanced.solidGrowth.push(promotedGrowthObservation(candidate.item));
  }
  return balanced;
}

function promotedGrowthObservation(item) {
  return {
    ...item,
    industries: narrowedPromotedIndustries(item),
    confidence: "中",
    conclusionStrength: "正式结论",
    evidenceGaps: normalizeEvidenceGaps(item.evidenceGaps).filter((gap) => gap !== "缺多源验证"),
    thesis: fixRadarText(item.thesis).replace(/可持续性需观察。?$/, "但现金流、价格或订单仍需继续跟踪。"),
    changeReason: "模型保持观察，但该方向具备多家公司公告和产业增长线索，规则引擎补入中置信扎实增长候选并保留证据缺口。",
  };
}

function qualifiesForObservationPromotion(item) {
  const text = `${item.title} ${item.thesis} ${arrayValue(item.industries).join(" ")} ${arrayValue(item.drivers).join(" ")}`;
  if (item.conclusionStrength === "正式结论") return false;
  const sourceCount = item.sourceIds?.length ?? item.supportingSourceCount ?? 0;
  const companyCount = item.companies?.length ?? 0;
  const evidenceFamilies = arrayValue(item.evidenceTypes).length;
  if (sourceCount < 4 && !(sourceCount >= 2 && companyCount >= 2 && evidenceFamilies >= 2)) return false;
  if (companyCount < 2) return false;
  if (!arrayValue(item.evidenceTypes).includes("announcement")) return false;
  if (arrayValue(item.evidenceGaps).some((gap) => /缺财报|缺公司公告/.test(gap))) return false;
  if (!/增长|涨价|景气|利润|营收|需求|订单|放量|周期/.test(text)) return false;
  if (/地产|房地产|光伏|煤炭|燃油车|电网|电力|输变电|配网|衰退|亏损扩大|过剩/.test(text)) return false;
  if (item.riskLevel === "高") return false;
  return true;
}

function narrowedPromotedIndustries(item) {
  const text = `${item.title} ${item.thesis} ${arrayValue(item.industries).join(" ")}`;
  if (/存储|DRAM|NAND|HBM/.test(text)) return ["存储芯片"];
  if (/航运|运价|BDI|集运/.test(text)) return ["航运物流"];
  if (/有色|铜|铝|稀土|钨|钼/.test(text)) return ["战略有色金属"];
  return arrayValue(item.industries).slice(0, 2);
}

function qualifiesForRuleBackedSolidGrowth(packet, existingKeys) {
  const key = canonicalIndustryKey(packet.industry);
  if (!key || existingKeys.has(key) || existingKeys.has(cleanStageKey(packet.industry))) return false;
  if (itemDeclineIsDirect(packet.industry)) return false;
  if (/创新药|医疗服务|CXO|消费电子|端侧AI|锂电|储能|锂矿|锂盐|水泥|建材|玻璃|白酒/.test(packet.industry)) return false;
  const scores = scoreIndustryPacket(packet);
  const evidenceTypes = arrayValue(packet.evidenceTypes);
  const hasHardOrOfficial = evidenceTypes.some((type) => type === "hard_data" || type === "official");
  const hasAnnouncement = evidenceTypes.includes("announcement");
  const richCompanyValidation = hasMultiplePositiveFinancialFacts(packet, 3);
  const hasCompanyValidation =
    hasSustainableFinancialFact(packet) ||
    hasRevenueAndProfitGrowthFact(packet) ||
    richCompanyValidation ||
    arrayValue(packet.companyCandidates).some((candidate) => evidenceStrength(candidate) >= 8 && /announcement/.test(arrayValue(candidate.sourceTypes).join(" ")));
  const hasReliableGrowthEvidence = (hasHardOrOfficial && hasAnnouncement) || (hasAnnouncement && richCompanyValidation);
  const hasNoBlockingGap = !arrayValue(packet.evidenceGaps).some((gap) => /缺财报|缺多源验证|缺现金流/.test(gap));
  const protectedGrowth = /半导体|AI算力|芯片|晶圆|封测|存储|DRAM|NAND|HBM|航运|运价|BDI|SCFI|CCFI/.test(`${packet.industry} ${arrayValue(packet.themes).join(" ")}`);
  const requiredGrowth = protectedGrowth && richCompanyValidation ? 52 : 70;
  const allowedDeclineRisk = protectedGrowth && richCompanyValidation ? 65 : 55;
  return (
    (packet.sourceCount ?? 0) >= 6 &&
    scores.growth >= requiredGrowth &&
    scores.evidence >= 70 &&
    scores.declineRisk < allowedDeclineRisk &&
    scores.bubbleRisk < 65 &&
    hasReliableGrowthEvidence &&
    hasCompanyValidation &&
    hasNoBlockingGap
  );
}

function evidenceStrength(candidate) {
  return typeof candidate?.evidenceStrength === "number" ? candidate.evidenceStrength : 0;
}

function hasSustainableFinancialFact(packet) {
  return arrayValue(packet.financialFacts).some((fact) => {
    const metrics = isRecord(fact.metrics) ? fact.metrics : {};
    const revenueYoy = numericValue(metrics.revenueYoy ?? fact.revenueYoy);
    const netProfitYoy = numericValue(metrics.netProfitYoy ?? fact.yoy);
    const operatingCashflowPerShare = numericValue(metrics.operatingCashflowPerShare);
    if (!Number.isFinite(netProfitYoy) || netProfitYoy <= 0) return false;
    if (netProfitYoy >= 1000 && (!Number.isFinite(revenueYoy) || revenueYoy < 20 || !(Number.isFinite(operatingCashflowPerShare) && operatingCashflowPerShare > 0))) return false;
    return !Number.isFinite(revenueYoy) || revenueYoy >= 0;
  });
}

function hasRevenueAndProfitGrowthFact(packet) {
  return arrayValue(packet.financialFacts).some((fact) => {
    const metrics = isRecord(fact.metrics) ? fact.metrics : {};
    const revenueYoy = numericValue(metrics.revenueYoy ?? fact.revenueYoy);
    const netProfitYoy = numericValue(metrics.netProfitYoy ?? fact.yoy);
    return Number.isFinite(revenueYoy) && revenueYoy >= 20 && Number.isFinite(netProfitYoy) && netProfitYoy > 0;
  });
}

function hasMultiplePositiveFinancialFacts(packet, minimum = 3) {
  const positiveCompanies = new Set();
  for (const fact of arrayValue(packet.financialFacts)) {
    const metrics = isRecord(fact.metrics) ? fact.metrics : {};
    const revenueYoy = numericValue(metrics.revenueYoy ?? fact.revenueYoy);
    const netProfitYoy = numericValue(metrics.netProfitYoy ?? fact.yoy);
    const netProfit = numericValue(metrics.netProfit ?? fact.value);
    const operatingCashflowPerShare = numericValue(metrics.operatingCashflowPerShare);
    const company = stringValue(fact.company);
    if (!company) continue;
    if (!Number.isFinite(netProfitYoy) || netProfitYoy <= 0) continue;
    if (Number.isFinite(netProfit) && netProfit <= 0) continue;
    if (Number.isFinite(revenueYoy) && revenueYoy < 8) continue;
    if (netProfitYoy >= 1000 && !(Number.isFinite(operatingCashflowPerShare) && operatingCashflowPerShare > 0)) continue;
    positiveCompanies.add(company);
  }
  return positiveCompanies.size >= minimum;
}

function ruleBackedSolidGrowthItem(packet, digest) {
  const sourceIds = sourceIdsForPacket(packet, digest).slice(0, 5);
  if (sourceIds.length < 2) return null;
  const companies = packetBackedCompanies(packet, sourceIds, digest).slice(0, 5);
  if (!companies.length) return null;
  const industry = refinedGrowthIndustryForPacket(packet, sourceIds, digest, companies);
  const mixedFinancialEvidence = hasNegativeFinancialDominance(packet);
  const evidenceLines = sourceIds
    .map((id) => digest.citations.find((source) => source.id === id))
    .filter(Boolean)
    .map((source) => formatExtremePercentEvidence(`${source.id} ${source.title}${source.summary ? `：${trimText(source.summary, 80)}` : ""}`))
    .slice(0, 5);
  const title = `${industry}景气与业绩共振`;
  const item = normalizeRadarItemCertainty(
    {
      title,
      industries: [industry],
      companies,
      thesis: ruleBackedSolidGrowthThesis({ ...packet, industry }),
      drivers: inferDriversFromPacket(packet),
      evidence: evidenceLines,
      conclusionStrength: "正式结论",
      evidenceGaps: unique([
        ...arrayValue(packet.evidenceGaps).filter((gap) => !/缺多源验证/.test(gap)),
        ...(mixedFinancialEvidence ? ["盈利分化待验证"] : []),
      ]),
      driverTags: inferDriverTagsFromPacket(packet),
      sustainabilityTier: "中期景气",
      durability: "中期",
      riskLevel: "中",
      confidence: "中",
      evidenceTypes: arrayValue(packet.evidenceTypes),
      supportingSourceCount: sourceIds.length,
      sourceIds,
      _lowBaseCrossChecked: hasMultiplePositiveFinancialFacts(packet, 3),
      changeReason: "模型未升入正式增长章节，但全行业规则评分显示硬数据与公司级证据已达到扎实增长候选门槛，自动补入并按中等置信展示。",
      counterEvidenceConditions: ["行业价格或运价连续回落", "代表公司后续财报未能延续盈利改善", "经营现金流转弱"],
      confirmationConditions: ["价格/运价继续维持高位", "更多 A/H 代表公司财报共振", "经营现金流改善"],
      turningPoints: [],
    },
    digest,
  );
  return { ...item, title: fixRadarText(item.title), thesis: fixRadarText(item.thesis), evidence: item.evidence.map(fixRadarText), changeReason: fixRadarText(item.changeReason) };
}

function refinedGrowthIndustryForPacket(packet, sourceIds, digest, companies = []) {
  const sourceText = digest.citations
    .filter((source) => sourceIds.includes(source.id))
    .map((source) => `${source.company ?? ""} ${source.industry ?? ""} ${source.title ?? ""} ${source.summary ?? ""}`)
    .join(" ");
  const companyText = companies.join(" ");
  const factText = [
    packet.industry,
    ...arrayValue(packet.themes),
    ...arrayValue(packet.financialFacts)
      .filter((fact) => companies.some((company) => stripTicker(company) === stripTicker(fact.company)))
      .map((fact) => `${fact.company ?? ""} ${JSON.stringify(fact.metrics ?? {})}`),
    ...arrayValue(packet.companyCandidates)
      .filter((candidate) => companies.some((company) => stripTicker(company) === stripTicker(candidate.company)))
      .map((candidate) => `${candidate.company ?? ""} ${candidate.industry ?? ""} ${candidate.theme ?? ""}`),
    ...companies,
    sourceText,
  ].join(" ");
  if (/存储|DRAM|NAND|HBM/.test(factText) || /德明利|佰维存储|兆易创新|北京君正|江波龙/.test(companyText)) return "存储芯片";
  if (/半导体设备|刻蚀|薄膜沉积|光刻胶|硅片|封测/.test(factText)) return "半导体设备/材料";
  if (/光模块|CPO|PCB|服务器|算力芯片|AI服务器/.test(factText) && !/存储|DRAM|NAND|HBM/.test(factText)) return "AI算力硬件";
  if (/稀土|钨|钼|翔鹭钨业|厦门钨业|北方稀土/.test(factText)) return "稀土/钨钼";
  if (/铜|铝|紫金矿业|洛阳钼业|中国铝业/.test(factText)) return "铜/铝";
  return packet.industry;
}

function ruleBackedSolidGrowthThesis(packet) {
  const evidenceTypes = arrayValue(packet.evidenceTypes);
  const hasHardOrOfficial = evidenceTypes.some((type) => type === "hard_data" || type === "official");
  if (hasHardOrOfficial) {
    return `${packet.industry}同时出现行业硬数据和公司级财报/公告验证，规则引擎补入扎实增长候选；仍需后续季度确认持续性。`;
  }
  return `${packet.industry}出现多家公司财报/公告共振和产业线索，规则引擎补入中置信扎实增长候选；由于行业价格或订单硬数据仍不完整，需要继续跟踪。`;
}

function sourceIdsForPacket(packet, digest) {
  const packetSourceKeys = new Set(arrayValue(packet.sources).flatMap((source) => [source.url, source.sourceId, source.title]).filter(Boolean));
  const companyNames = packetCompanyNames(packet);
  const exact = digest.citations
    .filter((source) => packetSourceKeys.has(source.url) || packetSourceKeys.has(source.sourceId) || packetSourceKeys.has(source.title))
    .filter((source) => sourceMatchesPacketContext(source, packet, companyNames) || exactPacketSourceCanSupportObservation(source, packet));
  const companyEvidenceIds = exact
    .filter((source) => companyNames.some((company) => `${source.company ?? ""} ${source.title} ${source.summary ?? ""}`.includes(company)))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .map((source) => source.id);
  const text = `${packet.industry} ${arrayValue(packet.themes).join(" ")} ${arrayValue(packet.evidenceTypes).join(" ")} ${arrayValue(packet.signalTypes).join(" ")}`;
  const inferred = digest.citations
    .map((source) => ({ source, score: keywordOverlapScore(text, `${source.query} ${source.title} ${source.summary ?? ""} ${source.industry ?? ""}`) + (source.industry === packet.industry ? 4 : 0) }))
    .filter((item) => item.score > 0)
    .filter((item) => sourceMatchesPacketContext(item.source, packet, companyNames))
    .sort((left, right) => right.score - left.score)
    .map((item) => item.source.id);
  if (exact.length) return unique([...companyEvidenceIds.slice(0, 2), ...exact.sort((left, right) => (right.score ?? 0) - (left.score ?? 0)).map((source) => source.id), ...inferred.slice(0, 6)]);
  return inferred;
}

function exactPacketSourceCanSupportObservation(source, packet) {
  const sourceText = `${source.company ?? ""} ${source.industry ?? ""} ${source.query ?? ""} ${source.title ?? ""} ${source.summary ?? ""}`;
  const topicText = `${packet.industry} ${arrayValue(packet.themes).join(" ")} ${arrayValue(packet.signalTypes).join(" ")}`;
  if (source.sourceType === "hard_data" || source.sourceType === "official") return keywordOverlapScore(topicText, sourceText) > 0;
  if (source.sourceType !== "announcement" && source.signalType !== "financial_metric") return false;
  if (!source.company || !isEligibleRepresentativeCompany(source.company)) return false;
  if (isNegativeFinancialText(sourceText) || !isPositiveFinancialText(sourceText)) return false;
  return companyMatchesItemContext(source.company, topicText, [source]);
}

function sourceMatchesPacketContext(source, packet, companyNames = []) {
  const sourceText = `${source.company ?? ""} ${source.industry ?? ""} ${source.query ?? ""} ${source.title ?? ""} ${source.summary ?? ""}`;
  const sourceCompanyKey = source.company ? stripTicker(source.company) : "";
  const topicText = `${packet.industry} ${arrayValue(packet.themes).join(" ")} ${arrayValue(packet.signalTypes).join(" ")}`;
  if (sourceCompanyKey && companyNames.some((company) => stripTicker(company) === sourceCompanyKey) && companyMatchesItemContext(source.company, topicText, [source])) return true;
  if (source.industry && cleanStageKey(source.industry) === cleanStageKey(packet.industry)) return true;
  if (source.industry && relatedIndustryContextMatches(source.industry, packet.industry)) return true;
  const packetCanonical = canonicalIndustryKey(packet.industry);
  const aliasRule = STAGE_ALIAS_RULES.find(([alias]) => canonicalIndustryKey(alias) === packetCanonical);
  if (aliasRule?.[1]?.test(sourceText)) return true;
  return keywordOverlapScore(topicText, sourceText) > 0;
}

function relatedIndustryContextMatches(left, right) {
  const leftKey = cleanStageKey(left);
  const rightKey = cleanStageKey(right);
  if (!leftKey || !rightKey || /行业待验证/.test(`${leftKey}${rightKey}`)) return false;
  if (leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey)) return true;
  const leftCanonical = canonicalIndustryKey(leftKey);
  const rightCanonical = canonicalIndustryKey(rightKey);
  return Boolean(leftCanonical && rightCanonical && (leftCanonical === rightCanonical || leftCanonical.includes(rightCanonical) || rightCanonical.includes(leftCanonical)));
}

function packetBackedCompanies(packet, sourceIds, digest) {
  const positiveCompanies = positiveFinancialFactCompanies(packet);
  const sourceCompanies = digest.citations
    .filter((source) => sourceIds.includes(source.id))
    .map((source) => source.company)
    .filter((company) => company && (!positiveCompanies.size || positiveCompanies.has(company)));
  const mentionedCompanies = digest.citations
    .filter((source) => sourceIds.includes(source.id))
    .flatMap((source) => sourceMentionedCompanies(source))
    .filter((company) => !positiveCompanies.size || positiveCompanies.has(company));
  const candidateCompanies = arrayValue(packet.companyCandidates)
    .filter((candidate) => evidenceStrength(candidate) >= 4 && (!positiveCompanies.size || positiveCompanies.has(candidate.company)))
    .map((candidate) => candidate.company);
  const factCompanies = arrayValue(packet.financialFacts)
    .filter(isPositiveFinancialFact)
    .map((fact) => fact.company)
    .filter(Boolean);
  const record = {
    title: packet.industry,
    thesis: `${packet.industry} ${arrayValue(packet.themes).join(" ")}`,
    companies: unique([...sourceCompanies, ...mentionedCompanies, ...candidateCompanies, ...factCompanies]),
    allowedCompanies: positiveCompanies.size ? [...positiveCompanies] : [],
  };
  return evidenceBackedCompanies(ahCompanies(record.companies), sourceIds, digest, record);
}

function sourceMentionedCompanies(source) {
  const text = stringValue(source.title).replace(/^\[PDF\]\s*/i, "").split(/[：:]/)[0];
  const candidates = [];
  for (const segment of text.split(/[、,，；;：:|｜]/).slice(0, 8)) {
    const match = segment.match(/^\s*([\u4e00-\u9fa5]{2,8})(?:\(|（|$|\s)/);
    if (!match) continue;
    const name = match[1].trim();
    if (!isLikelyCompanyMention(name)) continue;
    candidates.push(name);
  }
  return uniqueCompaniesByName(candidates);
}

function isLikelyCompanyMention(name) {
  if (!name || name.length < 2 || name.length > 8) return false;
  if (!/^[\u4e00-\u9fa5]+$/.test(name)) return false;
  if (/行业|市场|公司|集团|指数|价格|数据|观点|报告|关于|发布|预测|网传|国内|海外|中国|全球|一季度|周报|月报|公告|政策|现身|需求|库存|涨价|亏损|复苏|股价|基金|券商|证券|银行|新浪|搜狐|财联社|东方财富|板块|代表|业绩|综述|设备|能源/.test(name)) return false;
  return isEligibleRepresentativeCompany(name);
}

function positiveFinancialFactCompanies(packet) {
  return new Set(arrayValue(packet.financialFacts).filter(isPositiveFinancialFact).map((fact) => fact.company).filter(Boolean));
}

function isPositiveFinancialFact(fact) {
  const metrics = isRecord(fact.metrics) ? fact.metrics : {};
  const revenueYoy = numericValue(metrics.revenueYoy ?? fact.revenueYoy);
  const netProfitYoy = numericValue(metrics.netProfitYoy ?? fact.yoy);
  const netProfit = numericValue(metrics.netProfit ?? fact.value);
  const operatingCashflowPerShare = numericValue(metrics.operatingCashflowPerShare);
  if (!Number.isFinite(netProfitYoy) || netProfitYoy <= 0) return false;
  if (Number.isFinite(netProfit) && netProfit <= 0) return false;
  if (Number.isFinite(revenueYoy) && revenueYoy < 8) return false;
  if (netProfitYoy >= 1000 && !(Number.isFinite(operatingCashflowPerShare) && operatingCashflowPerShare > 0)) return false;
  return true;
}

function packetCompanyNames(packet) {
  return unique([
    ...arrayValue(packet.companyCandidates).map((candidate) => stringValue(candidate.company)),
    ...arrayValue(packet.financialFacts).map((fact) => stringValue(fact.company)),
  ]).filter((company) => company.length >= 2);
}

function inferDriversFromPacket(packet) {
  const text = `${packet.industry} ${arrayValue(packet.signalTypes).join(" ")} ${arrayValue(packet.themes).join(" ")}`;
  const drivers = [];
  if (/price|commodity|价格|铜|铝|锂|钨|稀土/.test(text)) drivers.push("价格上行");
  if (/freight|BDI|运价|航运/.test(text)) drivers.push("运价改善");
  if (/financial|财报|利润|业绩/.test(text)) drivers.push("业绩改善");
  if (/official|统计|政策/.test(text)) drivers.push("官方/结构化数据验证");
  return drivers.length ? drivers : ["需求与利润改善"];
}

function inferDriverTagsFromPacket(packet) {
  const text = `${packet.industry} ${arrayValue(packet.signalTypes).join(" ")} ${arrayValue(packet.themes).join(" ")}`;
  const tags = [];
  if (/price|commodity|价格|铜|铝|锂|钨|稀土|freight|BDI|运价/.test(text)) tags.push("价格");
  if (/需求|销量|出口|订单/.test(text)) tags.push("需求");
  if (/供给|库存|产能/.test(text)) tags.push("供给收缩");
  return tags.length ? tags : ["需求"];
}

function cleanRadarSections(sections) {
  const cleaned = Object.fromEntries(
    Object.entries(sections).map(([section, items]) => [
      section,
      dedupeRadarItems(arrayValue(items).filter((item) => hasEnoughRadarItemEvidence(item, section))),
    ]),
  );
  return removeDuplicateSecondaryIndustries(removeCrossSectionConflicts(cleaned));
}

function hasEnoughRadarItemEvidence(item, section = "") {
  const sourceCount = item.sourceIds?.length ?? 0;
  const needsRepresentativeCompany = /solidGrowth|sustainability|bubbleRisks|upcomingGrowth/.test(section);
  if (section === "solidGrowth" && item.conclusionStrength !== "正式结论") return sourceCount >= 1 && (!needsRepresentativeCompany || item.companies?.length > 0);
  return sourceCount >= 2 && (!needsRepresentativeCompany || item.companies?.length > 0);
}

function dedupeRadarItems(items) {
  const selected = [];
  for (const item of [...items].sort((left, right) => radarItemQuality(right) - radarItemQuality(left))) {
    const keys = radarItemKeys(item);
    const overlaps = selected.some((existing) => {
      const existingKeys = new Set(radarItemKeys(existing));
      return keys.some((key) => existingKeys.has(key));
    });
    if (!overlaps) selected.push(item);
  }
  return selected;
}

function removeCrossSectionConflicts(sections) {
  const ordered = ["solidGrowth", "upcomingGrowth", "bubbleRisks", "decliningIndustries", "sustainability"];
  const candidates = [];
  for (const section of ordered) {
    for (const item of sections[section] ?? []) {
      const primaryKey = primaryRadarItemKey(item);
      if (!primaryKey) continue;
      candidates.push({ section, item, key: primaryKey, score: radarItemQuality(item) + conflictStageBonus(section, item) });
    }
  }
  const winners = new Map();
  for (const candidate of candidates) {
    const existing = winners.get(candidate.key);
    if (!existing || candidate.score > existing.score) winners.set(candidate.key, candidate);
  }
  const winningTitleKeys = new Set([...winners.values()].map((candidate) => cleanStageKey(candidate.item.title)));
  return Object.fromEntries(
    Object.entries(sections).map(([section, items]) => [
      section,
      arrayValue(items).filter((item) => {
        const key = primaryRadarItemKey(item);
        const winner = winners.get(key);
        return winner?.section === section && cleanStageKey(winner.item.title) === cleanStageKey(item.title) && winningTitleKeys.has(cleanStageKey(item.title));
      }),
    ]),
  );
}

function conflictStageBonus(section, item) {
  const stage = { solidGrowth: "扎实增长", upcomingGrowth: "即将增长", bubbleRisks: "泡沫风险", decliningIndustries: "衰退", sustainability: "继续观察" }[section];
  const directDeclineBonus = section === "decliningIndustries" && stringArray(item.industries).some(itemDeclineIsDirect) ? 16 : 0;
  const thinGrowthPenalty = section === "solidGrowth" && (item.conclusionStrength !== "正式结论" || item.confidence !== "高") ? 18 : 0;
  return (STAGE_PRIORITY[stage] ?? 0) + directDeclineBonus - thinGrowthPenalty;
}

function removeDuplicateSecondaryIndustries(sections) {
  return Object.fromEntries(
    Object.entries(sections).map(([section, items]) => {
      const primaryKeys = new Set(arrayValue(items).map((item) => canonicalIndustryKey(item.industries?.[0] ?? item.title)).filter(Boolean));
      return [
        section,
        arrayValue(items)
          .map((item) => {
            const primaryKey = canonicalIndustryKey(item.industries?.[0] ?? item.title);
            const localKeys = new Set();
            const industries = stringArray(item.industries).filter((industry, index) => {
              const key = canonicalIndustryKey(industry);
              if (localKeys.has(key)) return false;
              localKeys.add(key);
              return index === 0 || key === primaryKey || !primaryKeys.has(key);
            });
            return { ...item, industries };
          })
          .filter((item) => item.industries.length),
      ];
    }),
  );
}

function primaryRadarItemKey(item) {
  return radarItemKeys(item)[0] || cleanStageKey(item.title);
}

function radarItemKeys(item) {
  const values = [item.title, ...stringArray(item.industries)].map(canonicalIndustryKey).filter(Boolean);
  return unique(values);
}

function canonicalIndustryKey(value) {
  const text = cleanStageKey(value);
  if (!text) return "";
  if (/地产|房地产|物业/.test(text)) return "地产链";
  if (/水泥|建材|玻璃/.test(text)) return "水泥建材";
  if (/电网|特高压|变压器|能源基础设施/.test(text)) return "电网设备";
  if (/电力\/水电|水电|发电|电力$|电力平稳|水电电力/.test(text)) return "电力水电";
  if (/高速|铁路/.test(text)) return "高速铁路";
  if (/电信|运营商/.test(text)) return "电信运营";
  if (/银行|保险|券商/.test(text)) return "金融高股息";
  if (/平稳现金流|高股息|分红/.test(text)) return "平稳现金流高股息";
  if (/战略有色|有色|铜|铝|稀土|钨|钼|钴|镍/.test(text)) return "战略有色金属";
  if (/存储|DRAM|NAND|HBM/.test(text)) return "存储芯片";
  if (/航运|集运|油运|港口|BDI|SCFI|CCFI/.test(text)) return "航运物流";
  if (/锂电|储能|锂矿|锂盐|碳酸锂/.test(text)) return "锂电储能";
  if (/生猪|养殖|猪价/.test(text)) return "生猪养殖";
  if (/光伏|硅料|组件|逆变器/.test(text)) return "光伏产业链";
  if (/燃油车|汽车零部件/.test(text)) return "传统燃油车";
  if (/AI应用|软件/.test(text)) return "AI应用软件";
  if (/机器人|具身/.test(text)) return "机器人具身智能";
  return text;
}

function itemDeclineIsDirect(industry) {
  return /地产|房地产|物业|光伏|硅料|组件|逆变器|传统燃油|燃油车|汽车零部件/.test(industry);
}

function radarItemQuality(item) {
  const confidence = { 低: 1, 中: 2, 高: 3 }[item.confidence] ?? 1;
  const strength = item.conclusionStrength === "正式结论" ? 12 : item.conclusionStrength === "观察" ? 6 : 0;
  const evidenceWeight = arrayValue(item.evidenceTypes).reduce((sum, type) => sum + (EVIDENCE_WEIGHTS[type] ?? 1), 0);
  const sourceScore = (item.sourceIds?.length ?? 0) * 6 + (item.supportingSourceCount ?? 0) * 3;
  const currentBonus = item.changeReason?.includes("复用") ? 0 : 8;
  return confidence * 10 + strength + evidenceWeight + sourceScore + currentBonus - (item.evidenceGaps?.length ?? 0) * 3;
}

function reuseUnchangedRadarItems(currentItems, previousItems, unchangedIndustries, digest, section = "") {
  const seen = new Set(currentItems.map((item) => item.title));
  const reusable = arrayValue(previousItems)
    .filter((item) => isRecord(item) && !seen.has(item.title) && stringArray(item.industries).some((industry) => unchangedIndustries.has(industry)))
    .slice(0, 6)
    .map((item) => {
      const conclusionStrength = enumValue(item.conclusionStrength, CONCLUSION_STRENGTHS, "观察");
      const sourceIds = sourceIdsForItem(item, digest);
      const reusedItem = {
        ...item,
        companies: evidenceBackedCompanies(ahCompanies(item.companies), sourceIds, digest, item).slice(0, 6),
        thesis: conclusionStrength === "正式结论" ? fixRadarText(item.thesis) : softenObservationText(item.thesis),
        evidence: stringArray(item.evidence).map(fixRadarText),
        conclusionStrength,
        sourceIds,
        changeReason: "本轮全行业扫描已完成，该行业证据 hash 未明显变化，复用上次稳定结论。",
      };
      return refineRadarItemTopic(normalizeRadarItemCertainty(reusedItem, digest), section);
    });
  return [...currentItems, ...reusable];
}

function buildIndustryStageMap(sections) {
  const stageByIndustry = new Map();
  const setStage = (key, stage) => {
    const keys = identityKeys(key);
    for (const normalized of keys) {
      const existing = stageByIndustry.get(normalized);
      if (!existing || (STAGE_PRIORITY[stage] ?? 0) >= (STAGE_PRIORITY[existing] ?? 0)) stageByIndustry.set(normalized, stage);
    }
  };
  for (const [stage, items] of [
    ["扎实增长", sections.solidGrowth],
    ["继续观察", sections.sustainability],
    ["泡沫风险", sections.bubbleRisks],
    ["即将增长", sections.upcomingGrowth],
    ["衰退", sections.decliningIndustries],
  ]) {
    for (const item of items) {
      const itemStage = stageForRadarSectionItem(item, stage);
      for (const key of identityKeys(item.title)) setStage(key, itemStage);
      for (const industry of item.industries ?? []) {
        for (const key of identityKeys(industry)) setStage(key, itemStage);
      }
    }
  }
  return stageByIndustry;
}

function stageForRadarSectionItem(item, defaultStage) {
  const text = [item.title, item.thesis, ...stringArray(item.industries), ...stringArray(item.drivers), ...stringArray(item.driverTags)].join(" ");
  if (defaultStage === "扎实增长" && item.conclusionStrength !== "正式结论") return "继续观察";
  if (defaultStage === "继续观察" && /平稳现金流|高股息|分红|公用事业|电力|水电|高速公路|电信运营|运营商|银行|保险/.test(text) && !/泡沫|衰退|严重下滑|流动性风险/.test(text)) {
    return "平稳现金流";
  }
  return defaultStage;
}

function normalizeRadarIndustryPacket(packet, stageByIndustry) {
  const rawScores = scoreIndustryPacket(packet);
  const mappedStage = stageForIndustryPacket(packet, stageByIndustry);
  const directMappedStage = stageByIndustry.get(cleanStageKey(packet.industry)) || stageByIndustry.get(canonicalIndustryKey(packet.industry));
  const stage = normalizedStageForPacket(packet, rawScores, mappedStage, Boolean(directMappedStage));
  const scores = reconcileScoresWithStage(rawScores, stage);
  return {
    group: packet.group,
    industry: packet.industry,
    status: packet.status,
    changeStatus: packet.changeStatus,
    stage,
    evidenceHash: packet.evidenceHash,
    sourceCount: packet.sourceCount,
    evidenceTypes: packet.evidenceTypes,
    signalTypes: packet.signalTypes,
    evidenceGaps: normalizeEvidenceGaps(packet.evidenceGaps),
    themes: packet.themes,
    scores,
  };
}

function normalizedStageForPacket(packet, scores, mappedStage, hasDirectStageMatch = false) {
  if ((packet.sourceCount ?? 0) <= 0 || (scores.evidence < 28 && !hasDirectStageMatch)) return "证据不足";
  const fallback = fallbackIndustryStage(packet, scores);
  if ((mappedStage === "扎实增长" || fallback === "扎实增长") && !hasDirectStageMatch && packetHasFormalGrowthBlockingGap(packet)) return "继续观察";
  if (mappedStage === "继续观察" && fallback === "平稳现金流") return "平稳现金流";
  if (!mappedStage) return fallback === "扎实增长" ? "继续观察" : fallback;
  if (mappedStage === "扎实增长" && shouldRejectSolidGrowthForStructuralDecline(packet, scores)) return "衰退";
  if (mappedStage === "衰退" && shouldProtectFromBroadDecline(packet, scores)) return fallback === "衰退" ? "继续观察" : fallback;
  return mappedStage;
}

function packetHasFormalGrowthBlockingGap(packet) {
  return arrayValue(packet.evidenceGaps).some((gap) => /缺财报|缺多源验证|缺现金流/.test(gap));
}

function reconcileScoresWithStage(scores, stage) {
  const next = { ...scores };
  if (stage === "衰退") {
    next.growth = Math.min(next.growth, 49);
    next.momentum = Math.min(next.momentum, 49);
    next.declineRisk = Math.max(next.declineRisk, 72);
  } else if (stage === "扎实增长") {
    next.growth = Math.max(next.growth, 68);
    next.momentum = Math.max(next.momentum, 55);
    next.declineRisk = Math.min(next.declineRisk, 60);
    next.bubbleRisk = Math.min(next.bubbleRisk, 58);
  } else if (stage === "即将增长") {
    next.growth = Math.max(next.growth, 56);
    next.momentum = Math.max(next.momentum, 58);
    next.declineRisk = Math.min(next.declineRisk, 68);
  } else if (stage === "平稳现金流") {
    next.growth = Math.min(next.growth, 52);
    next.bubbleRisk = Math.min(next.bubbleRisk, 45);
    next.declineRisk = Math.min(next.declineRisk, 45);
  } else if (stage === "泡沫风险") {
    next.bubbleRisk = Math.max(next.bubbleRisk, 64);
    next.valuationRisk = Math.max(next.valuationRisk, 60);
  } else if (stage === "继续观察") {
    next.growth = Math.min(Math.max(next.growth, 35), 72);
    next.declineRisk = Math.min(next.declineRisk, 84);
  } else if (stage === "证据不足") {
    next.confidence = Math.min(next.confidence, 48);
  }
  return next;
}

function stageForIndustryPacket(packet, stageByIndustry) {
  const keys = unique([
    ...identityKeys(packet.industry),
    ...identityKeys(`${packet.group ?? ""} ${packet.industry ?? ""} ${arrayValue(packet.themes).join(" ")}`),
    ...identityKeys(packet.group),
    ...arrayValue(packet.themes).flatMap(identityKeys),
  ]);
  let selected = "";
  for (const key of keys) {
    const stage = stageByIndustry.get(cleanStageKey(key));
    if (stage && (!selected || (STAGE_PRIORITY[stage] ?? 0) > (STAGE_PRIORITY[selected] ?? 0))) selected = stage;
  }
  return selected;
}

function stageLookupKeys(value) {
  const text = stringValue(value);
  if (!text) return [];
  const keys = [text];
  for (const [alias, pattern] of STAGE_ALIAS_RULES) {
    if (pattern.test(text)) keys.push(alias);
  }
  return unique(keys.map(cleanStageKey).filter(Boolean));
}

function cleanStageKey(value) {
  return stringValue(value).replace(/\s+/g, "");
}

function identityKeys(value) {
  return unique([cleanStageKey(value), canonicalIndustryKey(value)].filter(Boolean));
}

function fallbackIndustryStage(packet, scores) {
  if ((packet.sourceCount ?? 0) <= 0 || scores.evidence < 28) return "证据不足";
  const growthPressure = Math.max(scores.growth, scores.momentum);
  const structuralDecline = isDirectStructuralDecline(packet);
  const protectedGrowthTheme = isProtectedGrowthTheme(packet);
  const positiveCycleTheme = isPositiveCycleTheme(packet);
  if (scores.bubbleRisk >= 64 && growthPressure >= 50) return "泡沫风险";
  if (structuralDecline && packetHasStructuralDistress(packet)) return "衰退";
  if (structuralDecline && /过剩\/衰退|衰退/.test(stringValue(packet.group)) && scores.evidence >= 60 && !arrayValue(packet.evidenceGaps).length) return "衰退";
  if (structuralDecline && scores.declineRisk >= 52) return "衰退";
  if (structuralDecline && growthPressure >= 54) return "继续观察";
  if (!structuralDecline && protectedGrowthTheme && scores.declineRisk >= 68) return "继续观察";
  if (!structuralDecline && positiveCycleTheme && scores.declineRisk >= 68) return "继续观察";
  if (scores.declineRisk >= 68 && growthPressure < 58) return "衰退";
  if (scores.declineRisk >= 68 && growthPressure >= 58) return "继续观察";
  if (/现金流|高股息|公用事业|电信|高速|银行|保险/.test(`${packet.group} ${packet.industry}`) && scores.declineRisk < 50 && stableCashflowEvidenceIsSufficient(packet, scores)) return "平稳现金流";
  if (scores.growth >= 68 && scores.bubbleRisk < 56 && scores.declineRisk < 52) return "扎实增长";
  if (scores.growth >= 54 || scores.momentum >= 58) return "继续观察";
  return "证据不足";
}

function stableCashflowEvidenceIsSufficient(packet, scores) {
  const hasStructuredFacts = arrayValue(packet.financialFacts).length + arrayValue(packet.industryFacts).length > 0;
  const hasReliableType = arrayValue(packet.evidenceTypes).some((type) => type === "hard_data" || type === "official" || type === "announcement");
  const externalOnly = arrayValue(packet.signalTypes).length > 0 && arrayValue(packet.signalTypes).every((signal) => signal === "external_search");
  return !externalOnly && hasReliableType && hasStructuredFacts && !arrayValue(packet.evidenceGaps).includes("缺财报") && scores.evidence >= 50;
}

function stageSignalText(packet) {
  return `${packet.group ?? ""} ${packet.industry ?? ""} ${arrayValue(packet.themes).join(" ")}`;
}

function stageTopicText(packet) {
  return `${packet.industry ?? ""} ${arrayValue(packet.themes).join(" ")}`;
}

function isDirectStructuralDecline(packet) {
  const group = stringValue(packet.group);
  const industry = stringValue(packet.industry);
  const topic = stageTopicText(packet);
  return /过剩\/衰退|衰退/.test(group) || /过剩|衰退/.test(topic) || /地产|房地产|光伏|传统燃油|传统/.test(industry);
}

function isProtectedGrowthTheme(packet) {
  return /高景气成长|新能源汽车|智能驾驶|消费电子|端侧AI|半导体|AI算力|创新药|医疗器械|医药医疗|医药健康|医疗服务|CXO|订单恢复|电网设备|AI应用|软件|消费复苏|消费出海|品牌出海|白酒批价|高股息|保险复苏|物业现金流|储能出海|水泥|建材|建材复苏|产能出清/.test(stageSignalText(packet));
}

function isPositiveCycleTheme(packet) {
  const text = stageSignalText(packet);
  return /铜价上涨|铝价上涨|金价上涨|钨价上涨|稀土|库存低位|价格上涨|涨价|价格高位|复苏|修复|景气|订单恢复|出口改善/.test(text);
}

function shouldProtectFromBroadDecline(packet, scores) {
  if (!isProtectedGrowthTheme(packet) && !isPositiveCycleTheme(packet)) return false;
  if (isDirectStructuralDecline(packet)) return false;
  return true;
}

function shouldRejectSolidGrowthForStructuralDecline(packet, scores) {
  if (!isDirectStructuralDecline(packet)) return false;
  if (packetHasStructuralDistress(packet)) return true;
  return scores.declineRisk >= 52;
}

function packetHasStructuralDistress(packet) {
  const text = [
    packet.group,
    packet.industry,
    ...arrayValue(packet.themes),
    ...arrayValue(packet.evidenceGaps),
    ...arrayValue(packet.sources).map((source) => `${source.title ?? ""} ${source.summary ?? ""}`),
    ...arrayValue(packet.financialFacts).map((fact) => JSON.stringify(fact)),
    ...arrayValue(packet.industryFacts).map((fact) => JSON.stringify(fact)),
  ].join(" ");
  return /低基数|一次性|销售.*弱|销售.*承压|销售面积.*降|新开工.*降|债务|需求.*弱|亏损|价格.*低位|产能过剩|出清/.test(text);
}

function scoreIndustryPacket(packet) {
  const text = [
    packet.group,
    packet.industry,
    ...(packet.themes ?? []),
    ...packet.signalTypes,
    ...packet.evidenceGaps,
    ...packet.sources.map((source) => `${source.title ?? ""} ${source.summary ?? ""}`),
    ...packet.financialFacts.map((fact) => JSON.stringify(fact)),
    ...packet.industryFacts.map((fact) => JSON.stringify(fact)),
    ...packet.companyCandidates.map((candidate) => JSON.stringify(candidate)),
  ].join(" ");
  const evidenceWeight = packet.evidenceTypes.reduce((sum, type) => sum + (EVIDENCE_WEIGHTS[type] ?? 1), 0);
  const structuredFactCount = packet.financialFacts.length + packet.industryFacts.length + packet.companyCandidates.length;
  const sourceCount = packet.sourceCount ?? 0;
  const gapPenalty = packet.evidenceGaps.length * 7;
  const hardSignalCount = packet.signalTypes.filter((signal) => /financial_metric|industry_stat|commodity_price|freight_rate/.test(signal)).length;
  const externalOnly = packet.signalTypes.length > 0 && packet.signalTypes.every((signal) => signal === "external_search");
  const sourceDepth = Math.sqrt(Math.max(0, sourceCount)) * 12;
  const factDiversityBonus = Math.min(28, structuredFactCount * 6);
  const rawEvidence = clampScore(sourceDepth + evidenceWeight * 4 + factDiversityBonus - gapPenalty);
  const evidence = externalOnly && hardSignalCount === 0 ? Math.min(rawEvidence, 45) : rawEvidence;
  const positiveSignals = Math.min(8, keywordCount(text, /增长|上涨|改善|扩张|预增|回升|复苏|修复|景气|订单|出口|涨价|放量|利润|同比|环比/g));
  const riskSignals = Math.min(8, keywordCount(text, /泡沫|过热|透支|估值|连板|停牌|炒作|拥挤|高估/g));
  const declineSignals = Math.min(8, keywordCount(text, /下滑|亏损|过剩|去库|衰退|萎缩|价格下跌|需求弱|开工率低|减值/g));
  const hardSignalBonus = hardSignalCount * 7;
  const changeStatusBonus = packet.changeStatus === "new" ? 18 : packet.changeStatus === "changed" ? 14 : 5;
  const previousSourceCount = typeof packet.previousSourceCount === "number" ? packet.previousSourceCount : sourceCount;
  const sourceDelta = sourceCount - previousSourceCount;
  const growth = clampScore(18 + evidence * 0.24 + hardSignalBonus + positiveSignals * 4 - declineSignals * 5 - packet.evidenceGaps.length * 2);
  const momentum = clampScore(18 + changeStatusBonus + Math.min(6, Math.max(0, sourceDelta)) * 6 + positiveSignals * 3 + Math.min(10, sourceCount) * 1.5 - declineSignals * 3);
  const bubbleRisk = clampScore(12 + riskSignals * 13 + (packet.evidenceTypes.includes("market") ? 18 : 0) + (/机器人|低空|AI应用|商业航天/.test(`${packet.group} ${packet.industry}`) ? 8 : 0));
  const structuralDeclineBonus = isDirectStructuralDecline(packet) ? 18 : 0;
  const declineRisk = clampScore(12 + declineSignals * 9 + structuralDeclineBonus + (packet.evidenceGaps.includes("缺销量") ? 4 : 0));
  const valuationRisk = clampScore(15 + riskSignals * 10 + (packet.evidenceTypes.includes("market") ? 15 : 0) + (bubbleRisk > 60 ? 10 : 0));
  const confidence = clampScore(evidence + (packet.evidenceTypes.length >= 2 ? 12 : 0) - packet.evidenceGaps.length * 6);
  const change = clampScore(35 + changeStatusBonus + Math.abs(sourceDelta) * 12 + (packet.changeStatus === "unchanged" ? -12 : 0));
  return { growth, momentum, evidence, valuationRisk, bubbleRisk, declineRisk, confidence, change };
}

function keywordCount(text, pattern) {
  return [...String(text).matchAll(pattern)].length;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sourceIdsForItem(record, digest) {
  const valid = new Set(digest.citations.map((source) => source.id));
  const text = [record.title, record.thesis, ...stringArray(record.industries), ...stringArray(record.companies), ...stringArray(record.evidence)].join(" ");
  const companyNames = ahCompanies(record.companies).map(stripTicker).filter((company) => company.length >= 2);
  const companyMatched = digest.citations
    .map((source) => {
      const sourceText = `${source.company ?? ""} ${source.title} ${source.summary ?? ""} ${source.query}`;
      const matched = companyNames.some((company) => sourceText.includes(company));
      return { source, id: source.id, matched, score: source.weight + keywordOverlapScore(text, sourceText) };
    })
    .filter((source) => source.matched)
    .filter(({ source }) => sourceMatchesRadarItemContext(source, record))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((source) => source.id);
  const evidenceMentioned = unique(stringArray(record.evidence).flatMap((line) => [...String(line).matchAll(/\bS\d+\b/g)].map((match) => match[0])))
    .filter((id) => valid.has(id))
    .map((id) => digest.citations.find((source) => source.id === id))
    .filter(Boolean)
    .filter((source) => sourceMatchesRadarItemContext(source, record))
    .map((source) => source.id);
  const explicit = stringArray(record.sourceIds)
    .filter((id) => valid.has(id))
    .map((id) => digest.citations.find((source) => source.id === id))
    .filter(Boolean)
    .filter((source) => sourceMatchesRadarItemContext(source, record))
    .map((source) => source.id);
  const inferred = digest.citations
    .map((source) => {
      const overlap = keywordOverlapScore(text, `${source.title} ${source.summary ?? ""} ${source.query}`);
      return { source, id: source.id, overlap, score: overlap * 10 + source.weight };
    })
    .filter((source) => source.overlap > 0)
    .filter(({ source }) => sourceMatchesRadarItemContext(source, record))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((source) => source.id);
  return unique([...companyMatched, ...evidenceMentioned, ...inferred, ...explicit]).slice(0, 5);
}

function sourceMatchesRadarItemContext(source, record) {
  const itemText = [record.title, record.thesis, ...stringArray(record.industries), ...stringArray(record.drivers)].join(" ");
  const sourceText = `${source.company ?? ""} ${source.industry ?? ""} ${source.title ?? ""} ${source.summary ?? ""}`;
  const sourceCompanyKey = source.company ? stripTicker(source.company) : "";
  const itemCompanies = ahCompanies(record.companies).map(stripTicker);
  if (sourceCompanyKey && itemCompanies.includes(sourceCompanyKey) && companyMatchesItemContext(source.company, itemText, [source])) return true;
  for (const industry of stringArray(record.industries)) {
    if (source.industry && cleanStageKey(source.industry) === cleanStageKey(industry)) return true;
    const canonical = canonicalIndustryKey(industry);
    const aliasRule = STAGE_ALIAS_RULES.find(([alias]) => canonicalIndustryKey(alias) === canonical);
    if (aliasRule?.[1]?.test(sourceText)) return true;
  }
  return keywordOverlapScore([record.title, ...stringArray(record.industries), ...stringArray(record.drivers)].join(" "), sourceText) > 0;
}

function formatExtremePercentEvidence(text) {
  return String(text)
    .replace(/同比\s*([+-]?\d+(?:\.\d+)?)%/g, (match, rawValue) => {
      const value = Number(rawValue);
      if (!Number.isFinite(value) || Math.abs(value) < 1000) return match;
      const sign = value > 0 ? "+" : "";
      return `同比大幅变化（原始${sign}${value}%，低基数/一次性因素需核验）`;
    })
    .replace(/同比\s*([+-]?\d+(?:\.\d+)?)\s*倍/g, (match, rawValue) => {
      const value = Number(rawValue);
      if (!Number.isFinite(value) || Math.abs(value) < 10) return match;
      const sign = value > 0 ? "+" : "";
      return `同比大幅变化（原始${sign}${value}倍，低基数/一次性因素需核验）`;
    });
}

function evidenceGapsForItem(record, evidence) {
  const gaps = normalizeEvidenceGaps(record.evidenceGaps);
  const text = [record.title, record.thesis, ...stringArray(record.drivers), ...evidence].join(" ");
  if (/低基数|一次性因素需核验|原始[+-]?\d{4,}(?:\.\d+)?%/.test(text)) {
    if (!/现金流|经营现金流|OCF/i.test(text)) gaps.push("缺现金流");
    if (!/价格|销量|订单|库存|产能|多源|行业硬数据/.test(text)) gaps.push("缺多源验证");
  }
  if (/现金流为负|经营现金流为负|现金流转负|经营现金流转负/.test(text)) gaps.push("缺现金流");
  return unique(gaps);
}

function normalizeEvidenceGaps(values) {
  return unique(
    arrayValue(values)
      .map((gap) => {
        const text = stringValue(gap);
        if (EVIDENCE_GAPS.includes(text)) return text;
        if (/财报|盈利|利润|业绩|毛利|分化|低基数/.test(text)) return "缺财报";
        if (/价格|现货|期货|报价/.test(text)) return "缺价格";
        if (/销量|装机|出货/.test(text)) return "缺销量";
        if (/订单|中标|合同/.test(text)) return "缺订单";
        if (/库存/.test(text)) return "缺库存";
        if (/产能|开工/.test(text)) return "缺产能";
        if (/现金流|经营现金/.test(text)) return "缺现金流";
        if (/政策|监管|细则/.test(text)) return "缺政策细则";
        if (/公告|公司/.test(text)) return "缺公司公告";
        if (/多源|交叉|验证|确认|待验证/.test(text)) return "缺多源验证";
        return "";
      })
      .filter(Boolean),
  );
}

function stripTicker(company) {
  return String(company).replace(/\s*\([^)]*\)\s*/g, "").trim();
}

function evidenceBackedCompanies(companies, sourceIds, digest, record = {}) {
  const sourceSet = new Set(sourceIds);
  const matchedSources = digest.citations.filter((source) => sourceSet.has(source.id));
  const itemText = [record.title, record.thesis, ...stringArray(record.industries), ...stringArray(record.drivers), ...stringArray(record.evidence)].join(" ");
  const allowedCompanies = new Set(stringArray(record.allowedCompanies));
  const sourceCompanies = rankedSourceCompanies(matchedSources, itemText, allowedCompanies);
  const explicitCompanies = companies
    .filter((company) => !allowedCompanies.size || allowedCompanies.has(company))
    .filter((company) => companyMatchesItemContext(company, itemText, matchedSources));
  return uniqueCompaniesByName(sourceCompanies.length ? sourceCompanies : explicitCompanies);
}

function rankedSourceCompanies(matchedSources, itemText, allowedCompanies) {
  const bestByCompany = new Map();
  for (const source of matchedSources) {
    const company = stringValue(source.company);
    if (!company || (allowedCompanies.size && !allowedCompanies.has(company))) continue;
    if (!isEligibleRepresentativeCompany(company)) continue;
    if (!companyMatchesItemContext(company, itemText, matchedSources)) continue;
    const score = companyEvidenceQuality(source);
    const key = stripTicker(company);
    const existing = bestByCompany.get(key);
    if (!existing || score > existing.score) bestByCompany.set(key, { company, score });
  }
  return [...bestByCompany.values()]
    .sort((left, right) => right.score - left.score || left.company.localeCompare(right.company, "zh-Hans-CN"))
    .map((entry) => entry.company);
}

function companyEvidenceQuality(source) {
  const text = `${source.title ?? ""} ${source.summary ?? ""}`;
  const revenueYoy = firstPercentAfter(text, /营收同比/);
  const profitYoy = firstPercentAfter(text, /净利润同比/);
  let score = Number(source.score) || 0;
  if (Number.isFinite(revenueYoy) && revenueYoy >= 8) score += 18;
  if (Number.isFinite(profitYoy) && profitYoy > 0 && profitYoy < 1000) score += 18;
  if (/高速增长|预增|略增|利润增长|净利润增长|营收增长/.test(text)) score += 10;
  if (/经营现金流\s*-|每股经营现金流\s*-|现金流为负/.test(text)) score -= 30;
  if (Number.isFinite(revenueYoy) && revenueYoy < 0) score -= 35;
  if (Number.isFinite(profitYoy) && profitYoy < 0) score -= 24;
  if (Number.isFinite(profitYoy) && profitYoy >= 1000) score -= 50;
  if (/减亏|扭亏|低基数|一次性|待验证/.test(text)) score -= 8;
  return score;
}

function firstPercentAfter(text, marker) {
  const match = String(text).match(new RegExp(`${marker.source}\\s*([+-]?\\d+(?:\\.\\d+)?)%`));
  return match ? Number(match[1]) : undefined;
}

function uniqueCompaniesByName(companies) {
  const seen = new Set();
  const result = [];
  for (const company of companies.filter((value) => isEligibleRepresentativeCompany(value))) {
    const key = stripTicker(company);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(company);
  }
  return result;
}

function isEligibleRepresentativeCompany(company) {
  if (/^\d{5,6}\.(?:SH|SZ|BJ|HK)$/i.test(stripTicker(company))) return false;
  return ![...NON_AH_PATTERNS, ...UNSUITABLE_REPRESENTATIVE_PATTERNS].some((pattern) => pattern.test(company) || pattern.test(stripTicker(company)));
}

function companyMatchesItemContext(company, itemText, sources) {
  const disallowed = DISALLOWED_COMPANY_CONTEXT_RULES.find((rule) => rule.company.test(company) && rule.context.test(itemText) && !(rule.allow && rule.allow.test(itemText)));
  if (disallowed) return false;
  const rule = REPRESENTATIVE_CONTEXT_RULES.find((entry) => entry.pattern.test(itemText));
  if (!rule) return true;
  const name = stripTicker(company);
  const companySourceText = sources
    .filter((source) => stripTicker(source.company) === name || `${source.title ?? ""} ${source.summary ?? ""}`.includes(name))
    .map((source) => `${source.company ?? ""} ${source.industry ?? ""} ${source.title ?? ""} ${source.summary ?? ""}`)
    .join(" ");
  if (!companySourceText) return itemText.includes(name) || rule.required.test(name);
  if (isDeclineItemContext(itemText) && !hasCompanyDeclineEvidence(companySourceText)) return false;
  return rule.required.test(companySourceText);
}

function isDeclineItemContext(text) {
  return /衰退|萎缩|下滑|亏损|承压|低迷|过剩|利润率下降|份额被|需求弱|价格下跌/.test(text);
}

function hasCompanyDeclineEvidence(text) {
  return /亏损|续亏|预减|下滑|萎缩|承压|低迷|下降|减值|需求弱|产销量未达预期|利润率下降|价格下跌|过剩|销售弱|开工弱/.test(text);
}

function representativeCompanyLists(sections) {
  return [
    companyListFromItems("扎实增长产业中的代表公司", sections.solidGrowth, "本轮无满足正式门槛的扎实增长代表公司。"),
    companyListFromItems("短期增长但可持续性弱的代表公司", sections.sustainability.filter((item) => item.durability === "短期" || item.sustainabilityTier === "短期催化"), "本轮无满足正式门槛的短期增长代表公司。"),
    companyListFromItems("存在产业泡沫或股价泡沫的代表公司", sections.bubbleRisks, "本轮无满足正式门槛的泡沫风险代表公司。"),
    companyListFromItems("即将进入增长期的代表公司", sections.upcomingGrowth, "本轮无满足正式门槛的即将增长代表公司。"),
    companyListFromItems("已经或即将步入严重衰退的代表公司", sections.decliningIndustries, "本轮无满足正式门槛的衰退代表公司。"),
  ].filter((item) => item.companies.length || item.note);
}

function stageCompanyLists(sections) {
  const stable = sections.sustainability.filter((item) => /平稳|高股息|现金流|公用事业|电力|水电|电信/.test(`${item.title} ${item.industries.join(" ")}`));
  return [
    companyListFromItems("衰落产业中的沙漠之花", sections.decliningIndustries.filter((item) => item.riskLevel !== "高"), "本轮未识别出高置信沙漠之花时保持空缺。"),
    companyListFromItems("平稳产业中的杰出经营者", stable, "本轮无满足正式门槛的平稳经营者。"),
    companyListFromItems("上升产业中的领军人物", [...sections.solidGrowth, ...sections.upcomingGrowth], "本轮无满足正式门槛的上升产业领军公司。"),
    companyListFromItems("细分产业初期的风险投资标的", sections.bubbleRisks.filter((item) => /早期|初期|机器人|低空|商业航天|固态/.test(`${item.title} ${item.industries.join(" ")}`)), "风险投资标的必须有可验证 A/H 公司证据，否则保持空缺。"),
  ].filter((item) => item.companies.length || item.note);
}

function companyListFromItems(label, items, emptyNote) {
  const companies = uniqueCompaniesByName(items.flatMap((item) => item.companies ?? [])).slice(0, 8);
  return {
    label,
    companies,
    note: companies.length ? items.map((item) => item.title).slice(0, 3).join("；") : emptyNote,
  };
}

function radarCoverageReview(value, digest, formalItems) {
  const explicit = arrayValue(value)
    .map((item) => (isRecord(item) ? item : null))
    .filter(Boolean);
  const byLabel = new Map();
  for (const coverage of digest.softCoverage) {
    const status = coverageMatchesFormalItem(coverage.label, formalItems) ? "formal" : coverage.sourceCount >= 2 ? "watched" : "insufficient";
    byLabel.set(coverage.label, {
      label: coverage.label,
      status,
      sourceCount: coverage.sourceCount,
      evidenceTypes: coverage.evidenceTypes,
      sourceIds: coverage.topSourceIds,
      note: status === "formal" ? "已进入正式雷达结论。" : "已扫描到公开证据，但方向分化或证据强度不足，暂未升为正式结论。",
    });
  }
  for (const item of explicit) {
    const label = stringValue(item.label);
    if (!label) continue;
    const base = byLabel.get(label);
    const explicitSourceIds = stringArray(item.sourceIds).filter((id) => digest.citations.some((source) => source.id === id)).slice(0, 5);
    const explicitEvidenceTypes = enumArray(item.evidenceTypes, Object.keys(EVIDENCE_WEIGHTS));
    const sourceCount = typeof item.sourceCount === "number" && item.sourceCount > 0 ? item.sourceCount : (base?.sourceCount ?? 0);
    const status = coverageMatchesFormalItem(label, formalItems) ? "formal" : sourceCount >= 2 ? "watched" : "insufficient";
    byLabel.set(label, {
      label,
      status,
      sourceCount,
      evidenceTypes: explicitEvidenceTypes.length ? explicitEvidenceTypes : (base?.evidenceTypes ?? []),
      sourceIds: explicitSourceIds.length ? explicitSourceIds : (base?.sourceIds ?? []),
      note: status === "formal" ? "已进入正式雷达结论。" : scrubCoverageNote(stringValue(item.note) || base?.note || "", status),
    });
  }
  return [...byLabel.values()];
}

function coverageMatchesFormalItem(label, formalItems) {
  const labelText = stringValue(label);
  return arrayValue(formalItems).some((item) => {
    const itemText = [item.title, ...arrayValue(item.industries), ...arrayValue(item.companies)].join(" ");
    const labelKey = cleanStageKey(labelText);
    const itemKeys = [item.title, ...arrayValue(item.industries)].map(cleanStageKey).filter(Boolean);
    if (itemKeys.some((key) => key === labelKey || key.includes(labelKey) || labelKey.includes(key))) return true;
    const labelCanonical = canonicalIndustryKey(labelText);
    const itemCanonicals = unique([item.title, ...arrayValue(item.industries)].map(canonicalIndustryKey).filter(Boolean));
    return itemCanonicals.includes(labelCanonical) && coverageCanonicalMatchAllowed(labelText, itemText, labelCanonical);
  });
}

function coverageCanonicalMatchAllowed(labelText, itemText, canonical) {
  if (!canonical) return false;
  if (canonical === "地产链") {
    if (/物业/.test(labelText) && !/物业/.test(itemText)) return false;
    return /地产链|房地产|地产开发|房企|钢铁|水泥|建材|玻璃/.test(`${labelText} ${itemText}`);
  }
  if (canonical === "金融高股息") return cleanStageKey(labelText) === cleanStageKey(itemText);
  return true;
}

function scrubCoverageNote(note, status) {
  if (status === "formal") return "已进入正式雷达结论。";
  if (/正式|已进入|已形成|形成.*判断|形成.*结论/.test(note)) return status === "watched" ? "已扫描到公开证据，但方向分化或证据强度不足，暂未升为正式结论。" : "证据不足，暂未升为正式结论。";
  return note || (status === "watched" ? "已扫描到公开证据，但方向分化或证据强度不足，暂未升为正式结论。" : "证据不足，暂未升为正式结论。");
}

function radarLists(value) {
  return arrayValue(value)
    .map((item) => {
      const record = isRecord(item) ? item : {};
      return {
        label: stringValue(record.label),
        companies: ahCompanies(record.companies).slice(0, 8),
        note: stringValue(record.note),
      };
    })
    .filter((item) => item.label);
}

function mergeRadarLists(primary, fallback) {
  const byLabel = new Map();
  for (const list of fallback) {
    const existing = byLabel.get(list.label);
    byLabel.set(list.label, {
      label: list.label,
      companies: uniqueCompaniesByName(existing?.companies?.length ? existing.companies : (list.companies ?? [])).slice(0, 8),
      note: existing?.note || stringValue(list.note) || "",
    });
  }
  for (const list of primary) {
    const existing = byLabel.get(list.label);
    if (!existing) continue;
    byLabel.set(list.label, {
      ...existing,
      note: existing.note || stringValue(list.note) || "",
    });
  }
  return [...byLabel.values()].filter((item) => item.companies.length || item.note);
}

function classifySource(source) {
  const text = `${source.source ?? ""} ${source.query ?? ""} ${source.title ?? ""} ${source.summary ?? ""}`;
  const sourceType =
    source.sourceType ||
    (/财报|业绩预告|年报|季报|一季报|净利润|毛利率|现金流/.test(text)
      ? "announcement"
      : /价格|库存|产能|开工率|销量|装机|发电量|出口|订单|运价|猪价|钢铁|水泥|DRAM|NAND/i.test(text)
        ? "hard_data"
        : /统计局|协会|工信部|海关|发改委|中汽协|乘联会|药监局/.test(text)
          ? "official"
          : /板块|概念|资金流|涨跌幅|成交额/.test(text)
            ? "market"
            : /研报|券商|评级/.test(text)
              ? "research"
              : "news");
  const weight = source.weight ?? EVIDENCE_WEIGHTS[sourceType] ?? 2;
  const baseScore = weight * 10 + (/营收|净利润|价格|库存|销量|订单|现金流|同比|环比/.test(text) ? 8 : 0) + (/泡沫|过剩|亏损|下滑|衰退|停牌|异动/.test(text) ? 4 : 0);
  const score = typeof source.score === "number" && Number.isFinite(source.score) ? source.score : baseScore + anySearchScoreBonus(source);
  return {
    source: stringValue(source.source),
    query: stringValue(source.query),
    title: stringValue(source.title),
    url: stringValue(source.url),
    publishedAt: stringValue(source.publishedAt) || undefined,
    summary: stringValue(source.summary) || undefined,
    sourceType,
    signalType: stringValue(source.signalType) || undefined,
    weight,
    score,
    company: stringValue(source.company) || undefined,
    code: stringValue(source.code) || undefined,
    market: stringValue(source.market) || undefined,
    industry: stringValue(source.industry) || undefined,
    evidenceProfile: stringValue(source.evidenceProfile) || undefined,
    anysearchTags: Array.isArray(source.anysearchTags) ? source.anysearchTags.map(stringValue).filter(Boolean).slice(0, 6) : undefined,
    anysearchContentTypes: Array.isArray(source.anysearchContentTypes) ? source.anysearchContentTypes.map(stringValue).filter(Boolean).slice(0, 6) : undefined,
    anysearchFreshness: stringValue(source.anysearchFreshness) || undefined,
    anysearchSource: stringValue(source.anysearchSource) || undefined,
    qualityScore: numericValue(source.qualityScore),
    cached: typeof source.cached === "boolean" ? source.cached : undefined,
  };
}

function anySearchScoreBonus(source) {
  if (source.source !== "AnySearch") return 0;
  let bonus = 0;
  const quality = numericValue(source.qualityScore);
  if (quality !== undefined) {
    const normalized = quality > 1 ? quality / 100 : quality;
    if (normalized >= 0.9) bonus += 14;
    else if (normalized >= 0.85) bonus += 10;
    else if (normalized >= 0.75) bonus += 5;
    else if (normalized < 0.55) bonus -= 12;
  }
  const anysearchSource = stringValue(source.anysearchSource).toLowerCase();
  const anysearchContentTypes = new Set(Array.isArray(source.anysearchContentTypes) ? source.anysearchContentTypes.map((item) => stringValue(item).toLowerCase()).filter(Boolean) : []);
  if (anysearchSource === "data" || anysearchSource === "doc" || anysearchContentTypes.has("data") || anysearchContentTypes.has("doc")) bonus += 8;
  else if (anysearchSource === "academic" || anysearchContentTypes.has("academic")) bonus += 6;
  else if (anysearchSource === "news" || anysearchContentTypes.has("news")) bonus += 3;
  else if (anysearchSource === "web" || anysearchContentTypes.has("web")) bonus += 1;
  bonus += publishedAtBonus(source.publishedAt);
  if (isRecord(source.anysearchSignalScores)) {
    const authority = numericValue(source.anysearchSignalScores.authority);
    const freshness = numericValue(source.anysearchSignalScores.freshness);
    if (authority !== undefined && authority >= 25) bonus += 4;
    if (freshness !== undefined && freshness >= 10) bonus += 3;
  }
  return bonus;
}

function publishedAtBonus(value) {
  const text = stringValue(value);
  if (!text) return 0;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = (Date.now() - timestamp) / 86400000;
  if (ageDays <= 7) return 8;
  if (ageDays <= 30) return 4;
  if (ageDays <= 90) return 1;
  return 0;
}

function dedupeSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    const key = source.url || `${source.source}|${source.title}`;
    if (!source.source || !source.query || !source.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferTopic(source) {
  const text = `${source.query} ${source.title} ${source.summary ?? ""} ${source.industry ?? ""}`;
  return TOPIC_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "其他待验证方向";
}

function summarizeBreakdown(sources) {
  return sources.reduce((sum, source) => {
    sum[source.sourceType] = (sum[source.sourceType] ?? 0) + 1;
    return sum;
  }, {});
}

function summarizePreviousScan(scan) {
  return {
    id: scan.id,
    generatedAt: scan.generatedAt,
    asOfDate: scan.asOfDate,
    executiveSummary: arrayValue(scan.executiveSummary).slice(0, 5),
    solidGrowth: arrayValue(scan.solidGrowth).map((item) => item.title).slice(0, 8),
    bubbleRisks: arrayValue(scan.bubbleRisks).map((item) => item.title).slice(0, 8),
    upcomingGrowth: arrayValue(scan.upcomingGrowth).map((item) => item.title).slice(0, 8),
    decliningIndustries: arrayValue(scan.decliningIndustries).map((item) => item.title).slice(0, 8),
    industryPackets: arrayValue(scan.industryPackets).map((packet) => ({ industry: packet.industry, evidenceHash: packet.evidenceHash, sourceCount: packet.sourceCount })).slice(0, 120),
  };
}

function previousRadarTitles(scan) {
  if (!scan) return new Set();
  return new Set([...arrayValue(scan.solidGrowth), ...arrayValue(scan.sustainability), ...arrayValue(scan.bubbleRisks), ...arrayValue(scan.upcomingGrowth), ...arrayValue(scan.decliningIndustries)].map((item) => item.title).filter(Boolean));
}

function buildChangeLog(previousScan, scan) {
  if (!previousScan) return ["首次生成雷达扫描，后续刷新将与本次结果比较并说明变化原因。"];
  const previous = radarItemStageMap(previousScan);
  const current = radarItemStageMap(scan);
  const added = [...current.entries()].filter(([key]) => !previous.has(key)).map(([, item]) => item);
  const changed = [...current.entries()]
    .filter(([key, item]) => previous.has(key) && previous.get(key).stage !== item.stage)
    .map(([key, item]) => ({ previous: previous.get(key), current: item }));
  const upgraded = changed.filter(({ previous, current }) => (STAGE_PRIORITY[current.stage] ?? 0) > (STAGE_PRIORITY[previous.stage] ?? 0));
  const downgraded = changed.filter(({ previous, current }) => (STAGE_PRIORITY[current.stage] ?? 0) < (STAGE_PRIORITY[previous.stage] ?? 0));
  const retained = [...current.entries()].filter(([key, item]) => previous.has(key) && previous.get(key).stage === item.stage).map(([, item]) => item);
  const removed = [...previous.entries()].filter(([key]) => !current.has(key)).map(([, item]) => item);
  return [
    ...added.slice(0, 8).map((item) => `新增：${item.title}（${item.stage}）。`),
    ...upgraded.slice(0, 8).map(({ previous, current }) => `升级：${current.title}（${previous.stage} → ${current.stage}）。`),
    ...downgraded.slice(0, 8).map(({ previous, current }) => `降级：${current.title}（${previous.stage} → ${current.stage}）。`),
    ...retained.slice(0, 8).map((item) => `维持：${item.title}（${item.stage}）。`),
    ...removed.slice(0, 8).map((item) => `撤销：${item.title}（上次 ${item.stage}）。`),
  ].filter(Boolean);
}

function radarItemStageMap(scan) {
  const result = new Map();
  for (const [stage, items] of [
    ["扎实增长", scan.solidGrowth],
    ["继续观察", scan.sustainability],
    ["泡沫风险", scan.bubbleRisks],
    ["即将增长", scan.upcomingGrowth],
    ["衰退", scan.decliningIndustries],
  ]) {
    for (const item of arrayValue(items)) {
      const key = primaryRadarItemKey(item);
      const title = stringValue(item.title);
      if (!key || !title) continue;
      const itemStage = stageForRadarSectionItem(item, stage);
      const existing = result.get(key);
      if (!existing || (STAGE_PRIORITY[itemStage] ?? 0) >= (STAGE_PRIORITY[existing.stage] ?? 0)) {
        result.set(key, { title, stage: itemStage });
      }
    }
  }
  return result;
}

function radarJsonShape() {
  const item = {
    title: "细分产业",
    industries: ["行业"],
    companies: ["A/H 公司"],
    thesis: "一句话结论",
    drivers: ["驱动因素"],
    evidence: ["证据摘要"],
    conclusionStrength: "正式结论 | 观察 | 证据不足",
    evidenceGaps: [],
    driverTags: ["需求", "价格"],
    sustainabilityTier: "短期催化 | 中期景气 | 长期护城河",
    sourceIds: ["S1", "S2"],
    evidenceTypes: ["announcement", "hard_data"],
    supportingSourceCount: 3,
    confidence: "高 | 中 | 低",
    durability: "短期 | 中期 | 长期 | 不确定",
    riskLevel: "低 | 中 | 高",
    changeReason: "相比上次的变化原因",
    counterEvidenceConditions: ["反证条件"],
    turningPoints: ["潜在拐点"],
  };
  return {
    title: "行业雷达扫描",
    asOfDate: "YYYY-MM-DD",
    confidenceSummary: "总体置信度",
    changeLog: ["新增/升级/降级/维持/撤销"],
    executiveSummary: ["3-5条核心结论"],
    coverageReview: [{ label: "覆盖方向", status: "formal | watched | insufficient", sourceCount: 5, evidenceTypes: ["hard_data"], sourceIds: ["S1"], note: "复核说明" }],
    solidGrowth: [item],
    sustainability: [item],
    bubbleRisks: [item],
    upcomingGrowth: [item],
    decliningIndustries: [item],
    representativeCompanies: [{ label: "扎实增长产业中的代表公司", companies: ["A/H 公司"], note: "说明" }],
    stageCompanies: [{ label: "上升产业中的领军人物", companies: ["A/H 公司"], note: "说明" }],
    limitations: ["证据缺口"],
  };
}

function ahCompanies(value) {
  return stringArray(value).filter((company) => isEligibleRepresentativeCompany(company));
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function enumArray(value, allowed) {
  const allowedSet = new Set(allowed);
  return unique(stringArray(value).filter((item) => allowedSet.has(item)));
}

function keywordOverlapScore(left, right) {
  const rightText = String(right).toLocaleLowerCase();
  return unique(String(left).split(/[\s,，、。；;:：()（）[\]【】"'“”]+/).filter((token) => token.length >= 2)).reduce((score, token) => score + (rightText.includes(token.toLocaleLowerCase()) ? 1 : 0), 0);
}

function fingerprint(values) {
  const text = values.map((source) => `${source.url}|${source.title}|${source.source}|${source.publishedAt ?? ""}`).sort().join("\n");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildRadarD1Sql(radar, evidence, jobId) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS industries (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, level INTEGER NOT NULL);`,
    `CREATE TABLE IF NOT EXISTS evidence_items (id TEXT PRIMARY KEY, source_type TEXT NOT NULL, title TEXT NOT NULL, content TEXT, url TEXT, published_at TEXT, fetched_at TEXT NOT NULL, related_company_id TEXT, related_industry_id TEXT, related_theme_id TEXT, confidence REAL, raw_value TEXT);`,
    `CREATE TABLE IF NOT EXISTS indicator_values (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, indicator_name TEXT NOT NULL, value REAL, period TEXT, source TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS radar_runs (id TEXT PRIMARY KEY, market TEXT NOT NULL DEFAULT 'A/H', run_time TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL);`,
    `CREATE TABLE IF NOT EXISTS radar_items (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, industry_id TEXT, theme_id TEXT, stage TEXT NOT NULL, conclusion TEXT, confidence REAL, risk REAL, growth_score REAL, momentum_score REAL, evidence_score REAL, valuation_risk REAL, bubble_risk REAL, decline_risk REAL, evidence_count INTEGER NOT NULL DEFAULT 0);`,
  ];
  const runId = safeId(`radar_run_${jobId || radar.id || radar.generatedAt}`);
  statements.push(
    `INSERT OR REPLACE INTO radar_runs (id, market, run_time, model, status) VALUES (${sql(runId)}, 'A/H', ${sql(radar.generatedAt)}, ${sql(radar.model)}, 'completed');`,
  );
  for (const packet of arrayValue(radar.industryPackets)) {
    const industry = stringValue(packet.industry);
    if (!industry) continue;
    const industryId = industryIdForName(industry);
    const scores = isRecord(packet.scores) ? packet.scores : {};
    const risk = Math.max(Number(scores.valuationRisk) || 0, Number(scores.bubbleRisk) || 0, Number(scores.declineRisk) || 0);
    statements.push(`INSERT OR REPLACE INTO industries (id, name, parent_id, level) VALUES (${sql(industryId)}, ${sql(industry)}, NULL, 2);`);
    statements.push(
      [
        `INSERT OR REPLACE INTO radar_items (id, run_id, industry_id, theme_id, stage, conclusion, confidence, risk, growth_score, momentum_score, evidence_score, valuation_risk, bubble_risk, decline_risk, evidence_count) VALUES (`,
        [
          sql(safeId(`${runId}_${industryId}`)),
          sql(runId),
          sql(industryId),
          "NULL",
          sql(stringValue(packet.stage) || "证据不足"),
          sql(`${industry}：${stringValue(packet.group) || "全行业扫描"}`),
          numberSql(scores.confidence),
          numberSql(risk),
          numberSql(scores.growth),
          numberSql(scores.momentum),
          numberSql(scores.evidence),
          numberSql(scores.valuationRisk),
          numberSql(scores.bubbleRisk),
          numberSql(scores.declineRisk),
          numberSql(packet.sourceCount),
        ].join(", "),
        `);`,
      ].join(""),
    );
    for (const [name, value] of Object.entries(scores)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      statements.push(
        `INSERT OR REPLACE INTO indicator_values (id, entity_type, entity_id, indicator_name, value, period, source, created_at) VALUES (${sql(safeId(`${runId}_${industryId}_${name}`))}, 'industry', ${sql(industryId)}, ${sql(name)}, ${numberSql(value)}, ${sql(radar.asOfDate)}, 'radar_scoring', ${sql(radar.generatedAt)});`,
      );
    }
  }
  for (const source of arrayValue(radar.evidenceSources).slice(0, 160)) {
    const sourceId = safeId(`${runId}_${source.id || fingerprint([source])}`);
    const industry = inferRadarTopicFromText(`${source.query ?? ""} ${source.title ?? ""} ${source.summary ?? ""}`);
    const industryId = industry ? industryIdForName(industry) : null;
    if (industryId) statements.push(`INSERT OR IGNORE INTO industries (id, name, parent_id, level) VALUES (${sql(industryId)}, ${sql(industry)}, NULL, 2);`);
    statements.push(
      `INSERT OR REPLACE INTO evidence_items (id, source_type, title, content, url, published_at, fetched_at, related_industry_id, confidence, raw_value) VALUES (${sql(sourceId)}, ${sql(source.sourceType || "news")}, ${sql(source.title || "未命名证据")}, ${sql(source.summary || source.query || "")}, ${sql(source.url || "")}, ${sql(source.publishedAt || "")}, ${sql(radar.generatedAt)}, ${industryId ? sql(industryId) : "NULL"}, ${numberSql(source.score)}, ${sql(source.signalType || "")});`,
    );
  }
  for (const fact of [...arrayValue(evidence.financialFacts), ...arrayValue(evidence.industryFacts)].slice(0, 260)) {
    const industry = stringValue(fact.industry) || inferRadarTopicFromText(`${fact.title ?? ""} ${fact.summary ?? ""} ${fact.metric ?? ""}`);
    const industryId = industry ? industryIdForName(industry) : "market";
    const metric = stringValue(fact.metric) || stringValue(fact.name) || stringValue(fact.signalType) || "fact";
    const value = numericValue(fact.value) ?? numericValue(fact.yoy);
    if (value === undefined) continue;
    statements.push(`INSERT OR IGNORE INTO industries (id, name, parent_id, level) VALUES (${sql(industryId)}, ${sql(industry || "市场")}, NULL, 2);`);
    statements.push(
      `INSERT OR REPLACE INTO indicator_values (id, entity_type, entity_id, indicator_name, value, period, source, created_at) VALUES (${sql(safeId(`${runId}_${industryId}_${metric}_${stringValue(fact.company)}_${stringValue(fact.publishedAt)}`))}, 'industry', ${sql(industryId)}, ${sql(metric)}, ${numberSql(value)}, ${sql(stringValue(fact.publishedAt) || radar.asOfDate)}, ${sql(stringValue(fact.source) || "evidence")}, ${sql(radar.generatedAt)});`,
    );
  }
  return `${statements.join("\n")}\n`;
}

function inferRadarTopicFromText(text) {
  for (const [label, pattern] of TOPIC_RULES) {
    if (pattern.test(String(text))) return label;
  }
  return "";
}

function industryIdForName(name) {
  return safeId(`industry_${name}`);
}

function safeId(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || `id_${fingerprint([{ title: value }])}`;
}

function sql(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function numberSql(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "NULL";
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    args[arg.slice(2)] = argv[index + 1]?.startsWith("--") ? true : argv[++index];
  }
  return args;
}

function requiredArg(args, key) {
  const value = args[key];
  if (!value || value === true) throw new Error(`Missing --${key}`);
  return value;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readOptionalJsonFile(path) {
  if (!path) return null;
  const text = readFileSync(path, "utf8").trim();
  if (!text || text === "null") return null;
  return JSON.parse(text);
}

function writeJsonFile(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function writeTextFile(path, value) {
  writeFileSync(path, value, "utf8");
}

function stableJsonStringify(value) {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right, "en"))
    .reduce((result, key) => {
      const next = stableJsonValue(value[key]);
      if (next !== undefined) result[key] = next;
      return result;
    }, {});
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringArray(value) {
  return arrayValue(value).map((item) => stringValue(item)).filter(Boolean);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numericValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function trimText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
