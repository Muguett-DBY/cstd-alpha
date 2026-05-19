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
}

function buildRadarRequestBody(digest, structuredFacts, previousScan, asOfDate, industryScope) {
  return {
    model: DEEPSEEK_MODEL,
    response_format: { type: "json_object" },
    stream: false,
    temperature: 0.12,
    max_tokens: 7000,
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
            financialFacts: structuredFacts.financialFacts,
            industryFacts: structuredFacts.industryFacts,
            companyCandidates: structuredFacts.companyCandidates,
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
    if (previous?.evidenceHash && previous.evidenceHash === packet.evidenceHash) unchanged.push({ ...packet, changeStatus: "unchanged" });
    else changed.push({ ...packet, changeStatus: previous ? "changed" : "new" });
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
    sources: packet.sources.slice(0, 8).map((source) => ({
      source: source.source,
      title: trimText(source.title, 140),
      sourceType: source.sourceType,
      signalType: source.signalType,
      publishedAt: source.publishedAt,
    })),
    financialFacts: packet.financialFacts.slice(0, 6),
    industryFacts: packet.industryFacts.slice(0, 6),
    companyCandidates: packet.companyCandidates.slice(0, 6),
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
    .map((packet) => ({
      topic: packet.industry,
      score: packet.sourceCount || 0,
      sourceIds: [],
      evidenceTypes: packet.evidenceTypes ?? [],
      signalTypes: packet.signalTypes ?? [],
      summary: `${packet.industry}已完成扫描，当前结构化证据 ${packet.sourceCount ?? 0} 条。`,
      signals: [],
      evidenceHash: packet.evidenceHash,
      group: packet.group,
    }));
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
  const citationIds = new Set(digest.packets.slice(0, 18).flatMap((packet) => packet.sourceIds.slice(0, 6)));
  const prioritized = [...digest.citations.filter((source) => citationIds.has(source.id)), ...digest.citations.filter((source) => !citationIds.has(source.id))].slice(0, 120);
  return {
    sourceFingerprint: digest.sourceFingerprint,
    sourceCount: digest.sourceCount,
    evidenceBreakdown: digest.evidenceBreakdown,
    softCoverage: digest.softCoverage,
    packets: digest.packets.slice(0, 18).map((packet) => ({
      ...packet,
      sourceIds: packet.sourceIds.slice(0, 6),
      signals: packet.signals.slice(0, 5).map((signal) => trimText(signal, 220)),
    })),
    citations: prioritized.map((source) => ({
      id: source.id,
      source: source.source,
      sourceType: source.sourceType,
      signalType: source.signalType,
      query: source.query,
      title: trimText(source.title, 150),
      summary: source.summary ? trimText(source.summary, 220) : undefined,
      url: source.url,
      publishedAt: source.publishedAt,
      company: source.company,
      code: source.code,
      market: source.market,
      industry: source.industry,
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
    industryPackets: [...industryScope.changed, ...industryScope.unchanged].map((packet) => ({
      group: packet.group,
      industry: packet.industry,
      status: packet.status,
      changeStatus: packet.changeStatus,
      evidenceHash: packet.evidenceHash,
      sourceCount: packet.sourceCount,
      evidenceTypes: packet.evidenceTypes,
      signalTypes: packet.signalTypes,
      evidenceGaps: packet.evidenceGaps,
    })),
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
      return {
        title,
        industries: stringArray(record.industries).slice(0, 5),
        companies: ahCompanies(record.companies).slice(0, 6),
        thesis: stringValue(record.thesis),
        drivers: stringArray(record.drivers).slice(0, 8),
        evidence: stringArray(record.evidence).slice(0, 8),
        conclusionStrength: enumValue(record.conclusionStrength, CONCLUSION_STRENGTHS, confidence === "高" ? "正式结论" : "观察"),
        evidenceGaps: enumArray(record.evidenceGaps, EVIDENCE_GAPS),
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

function sourceIdsForItem(record, digest) {
  const valid = new Set(digest.citations.map((source) => source.id));
  const explicit = stringArray(record.sourceIds).filter((id) => valid.has(id)).slice(0, 5);
  if (explicit.length) return explicit;
  const text = [record.title, record.thesis, ...stringArray(record.industries), ...stringArray(record.companies)].join(" ");
  return digest.citations
    .map((source) => ({ id: source.id, score: keywordOverlapScore(text, `${source.title} ${source.summary ?? ""} ${source.query}`) + source.weight }))
    .filter((source) => source.score > 1)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((source) => source.id);
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
    byLabel.set(label, {
      label,
      status: enumValue(item.status, ["formal", "watched", "insufficient"], "watched"),
      sourceCount: typeof item.sourceCount === "number" ? item.sourceCount : 0,
      evidenceTypes: enumArray(item.evidenceTypes, Object.keys(EVIDENCE_WEIGHTS)),
      sourceIds: stringArray(item.sourceIds).filter((id) => digest.citations.some((source) => source.id === id)).slice(0, 5),
      note: stringValue(item.note),
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
    score: weight * 10 + (/营收|净利润|价格|库存|销量|订单|现金流|同比|环比/.test(text) ? 8 : 0) + (/泡沫|过剩|亏损|下滑|衰退|停牌|异动/.test(text) ? 4 : 0),
    company: stringValue(source.company) || undefined,
    code: stringValue(source.code) || undefined,
    market: stringValue(source.market) || undefined,
    industry: stringValue(source.industry) || undefined,
  };
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

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringArray(value) {
  return arrayValue(value).map((item) => stringValue(item)).filter(Boolean);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
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
