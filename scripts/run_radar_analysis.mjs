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
  /\([A-Z]{1,6}\.(O|N|NASDAQ|NYSE|US)\)/i,
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
  if (args["mock-model-output"]) {
    modelPayload = readJsonFile(args["mock-model-output"]);
  } else {
    modelPayload = await callDeepSeek(body);
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
  };
  if (args["output-radar"]) writeJsonFile(args["output-radar"], cachePayload);
  if (args["output-job"]) writeJsonFile(args["output-job"], job);
  if (args["output-d1-sql"]) writeTextFile(args["output-d1-sql"], buildRadarD1Sql(radar, evidence, jobId));
}

function buildRadarRequestBody(digest, structuredFacts, previousScan, asOfDate, industryScope) {
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
        content: JSON.stringify({
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
        content: JSON.stringify({
          asOfDate: asOfDate || new Date().toISOString().slice(0, 10),
          previousScan: previousScan ? summarizePreviousScan(previousScan) : null,
          analysisScope: compactIndustryScopeForModel(industryScope),
          evidenceDigest: compactDigestForModel(digest),
          structuredFacts: {
            financialFacts: structuredFacts.financialFacts.slice(0, 40).map(compactFinancialFact),
            industryFacts: structuredFacts.industryFacts.slice(0, 50).map(compactIndustryFact),
            companyCandidates: structuredFacts.companyCandidates.slice(0, 40).map(compactCompanyCandidate),
          },
        }),
      },
    ],
  };
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
  const content = payload.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new Error("DeepSeek returned empty content");
  return JSON.parse(jsonrepair(content));
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
        evidenceGaps: stringArray(record.evidenceGaps).slice(0, 6),
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
  const citations = dedupeSources(sources.map(classifySource))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, 160)
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
  const solidGrowth = reuseUnchangedRadarItems(radarItems(record.solidGrowth, previousTitles, digest), previousScan?.solidGrowth, unchangedIndustries, digest);
  const sustainability = reuseUnchangedRadarItems(radarItems(record.sustainability, previousTitles, digest), previousScan?.sustainability, unchangedIndustries, digest);
  const bubbleRisks = reuseUnchangedRadarItems(radarItems(record.bubbleRisks, previousTitles, digest), previousScan?.bubbleRisks, unchangedIndustries, digest);
  const upcomingGrowth = reuseUnchangedRadarItems(radarItems(record.upcomingGrowth, previousTitles, digest), previousScan?.upcomingGrowth, unchangedIndustries, digest);
  const decliningIndustries = reuseUnchangedRadarItems(radarItems(record.decliningIndustries, previousTitles, digest), previousScan?.decliningIndustries, unchangedIndustries, digest);
  const formalItems = [...solidGrowth, ...sustainability, ...bubbleRisks, ...upcomingGrowth, ...decliningIndustries];
  const coverageReview = radarCoverageReview(record.coverageReview, digest, formalItems);
  const stageByIndustry = buildIndustryStageMap({ solidGrowth, sustainability, bubbleRisks, upcomingGrowth, decliningIndustries });
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
    confidenceSummary: stringValue(record.confidenceSummary) || "置信度按财报公告、价格/销量硬数据、市场数据和新闻线索的交叉验证强弱生成。",
    fromCache: false,
    executiveSummary: stringArray(record.executiveSummary).slice(0, 8),
    solidGrowth,
    sustainability,
    bubbleRisks,
    upcomingGrowth,
    decliningIndustries,
    representativeCompanies: radarLists(record.representativeCompanies),
    stageCompanies: radarLists(record.stageCompanies),
    limitations: stringArray(record.limitations).slice(0, 8),
  };
  return {
    ...scan,
    changeLog: stringArray(record.changeLog).slice(0, 8).length ? stringArray(record.changeLog).slice(0, 8) : buildChangeLog(previousScan, scan),
  };
}

function radarItems(value, previousTitles, digest) {
  return arrayValue(value)
    .map((item) => {
      const record = isRecord(item) ? item : {};
      const title = stringValue(record.title);
      if (!title) return null;
      const confidence = enumValue(record.confidence, ["低", "中", "高"], "中");
      const sourceIds = sourceIdsForItem(record, digest);
      const normalizedEvidence = stringArray(record.evidence).slice(0, 8).map(formatExtremePercentEvidence);
      return {
        title,
        industries: stringArray(record.industries).slice(0, 5),
        companies: ahCompanies(record.companies).slice(0, 6),
        thesis: stringValue(record.thesis),
        drivers: stringArray(record.drivers).slice(0, 8),
        evidence: normalizedEvidence,
        conclusionStrength: enumValue(record.conclusionStrength, CONCLUSION_STRENGTHS, confidence === "高" ? "正式结论" : "观察"),
        evidenceGaps: evidenceGapsForItem(record, normalizedEvidence),
        driverTags: enumArray(record.driverTags, DRIVER_TAGS),
        sustainabilityTier: enumValue(record.sustainabilityTier, SUSTAINABILITY_TIERS, "中期景气"),
        durability: enumValue(record.durability, ["短期", "中期", "长期", "不确定"], "不确定"),
        riskLevel: enumValue(record.riskLevel, ["低", "中", "高"], "中"),
        confidence,
        evidenceTypes: enumArray(record.evidenceTypes, Object.keys(EVIDENCE_WEIGHTS)),
        supportingSourceCount: typeof record.supportingSourceCount === "number" ? record.supportingSourceCount : sourceIds.length,
        sourceIds,
        changeReason: stringValue(record.changeReason) || (previousTitles.has(title) ? "延续上次判断，等待新证据确认强弱。" : "本次证据包新增或强化该方向。"),
        counterEvidenceConditions: stringArray(record.counterEvidenceConditions).slice(0, 6),
        turningPoints: stringArray(record.turningPoints).slice(0, 6),
      };
    })
    .filter(Boolean);
}

function reuseUnchangedRadarItems(currentItems, previousItems, unchangedIndustries, digest) {
  const seen = new Set(currentItems.map((item) => item.title));
  const reusable = arrayValue(previousItems)
    .filter((item) => isRecord(item) && !seen.has(item.title) && stringArray(item.industries).some((industry) => unchangedIndustries.has(industry)))
    .slice(0, 6)
    .map((item) => ({
      ...item,
      sourceIds: sourceIdsForItem(item, digest),
      changeReason: "本轮全行业扫描已完成，该行业证据 hash 未明显变化，复用上次稳定结论。",
    }));
  return [...currentItems, ...reusable];
}

function buildIndustryStageMap(sections) {
  const stageByIndustry = new Map();
  for (const [stage, items] of [
    ["扎实增长", sections.solidGrowth],
    ["继续观察", sections.sustainability],
    ["泡沫风险", sections.bubbleRisks],
    ["即将增长", sections.upcomingGrowth],
    ["衰退", sections.decliningIndustries],
  ]) {
    for (const item of items) {
      if (item.title && !stageByIndustry.has(item.title)) stageByIndustry.set(item.title, stage);
      for (const industry of item.industries ?? []) {
        if (!stageByIndustry.has(industry)) stageByIndustry.set(industry, stage);
      }
    }
  }
  return stageByIndustry;
}

function normalizeRadarIndustryPacket(packet, stageByIndustry) {
  const scores = scoreIndustryPacket(packet);
  return {
    group: packet.group,
    industry: packet.industry,
    status: packet.status,
    changeStatus: packet.changeStatus,
    stage: stageByIndustry.get(packet.industry) || fallbackIndustryStage(packet, scores),
    evidenceHash: packet.evidenceHash,
    sourceCount: packet.sourceCount,
    evidenceTypes: packet.evidenceTypes,
    signalTypes: packet.signalTypes,
    evidenceGaps: packet.evidenceGaps,
    themes: packet.themes,
    scores,
  };
}

function fallbackIndustryStage(packet, scores) {
  if ((packet.sourceCount ?? 0) <= 0 || scores.evidence < 28) return "证据不足";
  const growthPressure = Math.max(scores.growth, scores.momentum);
  if (scores.bubbleRisk >= 64 && growthPressure >= 50) return "泡沫风险";
  if (scores.declineRisk >= 68 && growthPressure < 58) return "衰退";
  if (scores.declineRisk >= 68 && growthPressure >= 58) return "继续观察";
  if (/现金流|高股息|公用事业|电信|高速|银行|保险/.test(`${packet.group} ${packet.industry}`) && scores.declineRisk < 50) return "平稳现金流";
  if (scores.growth >= 68 && scores.bubbleRisk < 56 && scores.declineRisk < 52) return "扎实增长";
  if (scores.growth >= 54 || scores.momentum >= 58) return "继续观察";
  return "证据不足";
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
  const positiveSignals = Math.min(8, keywordCount(text, /增长|上涨|改善|扩张|预增|回升|景气|订单|出口|涨价|放量|利润|同比|环比/g));
  const riskSignals = Math.min(8, keywordCount(text, /泡沫|过热|透支|估值|连板|停牌|炒作|拥挤|高估/g));
  const declineSignals = Math.min(8, keywordCount(text, /下滑|亏损|过剩|去库|衰退|萎缩|价格下跌|需求弱|开工率低|减值/g));
  const hardSignalBonus = hardSignalCount * 7;
  const changeStatusBonus = packet.changeStatus === "new" ? 18 : packet.changeStatus === "changed" ? 14 : 5;
  const previousSourceCount = typeof packet.previousSourceCount === "number" ? packet.previousSourceCount : sourceCount;
  const sourceDelta = sourceCount - previousSourceCount;
  const growth = clampScore(18 + evidence * 0.24 + hardSignalBonus + positiveSignals * 4 - declineSignals * 5 - packet.evidenceGaps.length * 2);
  const momentum = clampScore(18 + changeStatusBonus + Math.min(6, Math.max(0, sourceDelta)) * 6 + positiveSignals * 3 + Math.min(10, sourceCount) * 1.5 - declineSignals * 3);
  const bubbleRisk = clampScore(12 + riskSignals * 13 + (packet.evidenceTypes.includes("market") ? 18 : 0) + (/机器人|低空|AI应用|商业航天/.test(`${packet.group} ${packet.industry}`) ? 8 : 0));
  const structuralDeclineBonus = /过剩|衰退|地产|光伏|传统/.test(`${packet.group} ${packet.industry}`) ? 18 : 0;
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
      return { id: source.id, matched, score: source.weight + keywordOverlapScore(text, sourceText) };
    })
    .filter((source) => source.matched)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((source) => source.id);
  const evidenceMentioned = unique(stringArray(record.evidence).flatMap((line) => [...String(line).matchAll(/\bS\d+\b/g)].map((match) => match[0]))).filter((id) => valid.has(id));
  const explicit = stringArray(record.sourceIds)
    .filter((id) => valid.has(id))
    .map((id) => digest.citations.find((source) => source.id === id))
    .filter(Boolean)
    .filter((source) => keywordOverlapScore(text, `${source.title} ${source.summary ?? ""} ${source.query}`) > 0)
    .map((source) => source.id);
  const inferred = digest.citations
    .map((source) => {
      const overlap = keywordOverlapScore(text, `${source.title} ${source.summary ?? ""} ${source.query}`);
      return { id: source.id, overlap, score: overlap * 10 + source.weight };
    })
    .filter((source) => source.overlap > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((source) => source.id);
  return unique([...companyMatched, ...evidenceMentioned, ...inferred, ...explicit]).slice(0, 5);
}

function formatExtremePercentEvidence(text) {
  return String(text).replace(/同比\s*([+-]?\d+(?:\.\d+)?)%/g, (match, rawValue) => {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || Math.abs(value) < 1000) return match;
    const sign = value > 0 ? "+" : "";
    return `同比大幅变化（原始${sign}${value}%，低基数/一次性因素需核验）`;
  });
}

function evidenceGapsForItem(record, evidence) {
  const gaps = enumArray(record.evidenceGaps, EVIDENCE_GAPS);
  const text = [record.title, record.thesis, ...stringArray(record.drivers), ...evidence].join(" ");
  if (/低基数|一次性因素需核验|原始[+-]?\d{4,}(?:\.\d+)?%/.test(text)) {
    if (!/现金流|经营现金流|OCF/i.test(text)) gaps.push("缺现金流");
    if (!/价格|销量|订单|库存|产能|多源|行业硬数据/.test(text)) gaps.push("缺多源验证");
  }
  return unique(gaps);
}

function stripTicker(company) {
  return String(company).replace(/\s*\([^)]*\)\s*/g, "").trim();
}

function radarCoverageReview(value, digest, formalItems) {
  const formalText = formalItems.flatMap((item) => [item.title, ...item.industries, ...item.companies]).join(" ");
  const explicit = arrayValue(value)
    .map((item) => (isRecord(item) ? item : null))
    .filter(Boolean);
  const byLabel = new Map();
  for (const coverage of digest.softCoverage) {
    const status = keywordOverlapScore(coverage.label, formalText) > 0 ? "formal" : coverage.sourceCount >= 2 ? "watched" : "insufficient";
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
    byLabel.set(label, {
      label,
      status: enumValue(item.status, ["formal", "watched", "insufficient"], "watched"),
      sourceCount: typeof item.sourceCount === "number" && item.sourceCount > 0 ? item.sourceCount : (base?.sourceCount ?? 0),
      evidenceTypes: explicitEvidenceTypes.length ? explicitEvidenceTypes : (base?.evidenceTypes ?? []),
      sourceIds: explicitSourceIds.length ? explicitSourceIds : (base?.sourceIds ?? []),
      note: stringValue(item.note) || base?.note || "",
    });
  }
  return [...byLabel.values()];
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
  const previous = previousRadarTitles(previousScan);
  const current = previousRadarTitles(scan);
  const added = [...current].filter((title) => !previous.has(title));
  const retained = [...current].filter((title) => previous.has(title));
  const removed = [...previous].filter((title) => !current.has(title));
  return [
    added.length ? `新增：${added.slice(0, 5).join("、")}。` : "",
    retained.length ? `维持：${retained.slice(0, 5).join("、")}。` : "",
    removed.length ? `撤销或降级：${removed.slice(0, 5).join("、")}。` : "",
  ].filter(Boolean);
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
  return stringArray(value).filter((company) => !NON_AH_PATTERNS.some((pattern) => pattern.test(company)));
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
