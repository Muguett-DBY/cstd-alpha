import type { ResearchWorkbenchItem } from "../../src/shared/research-workbench";
import { getOrCreateCompanyEvidencePackage, type CompanyEvidencePackage } from "./company-evidence";
import type { AssistantEnv } from "./assistant-db";
import type { WatchlistRow } from "./user-research-db";
import type { ResearchThesisCitation, ResearchThesisEvidence } from "./research-thesis";
import type { RadarScan } from "../../src/shared/radar";

type IndustryPacketRow = {
  industry_id: string | null;
  stage: string;
  conclusion: string | null;
  confidence: number | null;
  risk: number | null;
  growth_score: number | null;
  momentum_score: number | null;
  evidence_score: number | null;
  evidence_count: number;
  run_time: string;
};

type IndustryEvidenceRow = {
  title: string;
  source_type: string;
  content: string | null;
  url: string | null;
  published_at: string | null;
  confidence: number | null;
};

type IndustryIndicatorRow = {
  indicator_name: string;
  value: number;
  period: string | null;
  source: string | null;
};

export async function loadResearchThesisEvidence(
  env: AssistantEnv,
  userKey: string,
  item: ResearchWorkbenchItem,
  signal?: AbortSignal,
): Promise<ResearchThesisEvidence> {
  if (!env.REPORT_LIBRARY_DB) throw new Error("REPORT_LIBRARY_DB is not configured.");
  if (item.entityType === "company") {
    const watchlist = await readWatchlistRow(env.REPORT_LIBRARY_DB, userKey, item.entityId);
    if (!watchlist) throw new Error("研究对象未关联到自选公司，无法读取公司证据包。");
    const pkg = await getOrCreateCompanyEvidencePackage(env, userKey, watchlist, signal);
    return companyPackageToResearchEvidence(pkg);
  }
  return readIndustryResearchEvidence(env, item);
}

export function companyPackageToResearchEvidence(pkg: CompanyEvidencePackage): ResearchThesisEvidence {
  const citations = pkg.evidence.evidence.slice(0, 24).map<ResearchThesisCitation>((item, index) => ({
    id: `E${index + 1}`,
    title: item.title,
    sourceType: item.evidenceType,
    summary: item.notes,
    ...(item.url ? { url: item.url } : {}),
    ...(item.retrievedAt ? { publishedAt: item.retrievedAt } : {}),
  }));
  return {
    evidenceHash: pkg.materialHash || pkg.evidenceHash,
    asOf: pkg.fetchedAt,
    summary: [
      `公司：${pkg.evidence.company.name}（${pkg.evidence.company.ticker || "无代码"} / ${pkg.evidence.company.market || "未知市场"}）`,
      `稳定事实：${boundedJson(pkg.stableFacts, 7_000)}`,
      `近期信号：${boundedJson(pkg.freshSignals, 4_000)}`,
    ].join("\n"),
    citations,
  };
}

export function industryRowsToResearchEvidence({
  title,
  packet,
  radarCitations = [],
  sourceRows,
  indicatorRows,
}: {
  title: string;
  packet: Omit<IndustryPacketRow, "industry_id"> | null;
  radarCitations?: Array<Omit<ResearchThesisCitation, "id">>;
  sourceRows: IndustryEvidenceRow[];
  indicatorRows: IndustryIndicatorRow[];
}): ResearchThesisEvidence {
  const sourceCitations = sourceRows.slice(0, 20).map<Omit<ResearchThesisCitation, "id">>((row) => ({
    title: row.title,
    sourceType: row.source_type || "news",
    summary: row.content || "来源未提供摘要。",
    ...(row.url ? { url: row.url } : {}),
    ...(row.published_at ? { publishedAt: row.published_at } : {}),
  }));
  const indicatorCitations = indicatorRows.slice(0, 12).map<Omit<ResearchThesisCitation, "id">>((row) => ({
    title: `${row.indicator_name}（${row.period || "最新"}）`,
    sourceType: "indicator",
    summary: `${row.indicator_name}=${formatNumber(row.value)}；来源=${row.source || "结构化指标库"}`,
    ...(row.period ? { publishedAt: row.period } : {}),
  }));
  const citations = dedupeCitations([...radarCitations, ...sourceCitations, ...indicatorCitations])
    .slice(0, 32)
    .map((item, index) => ({ id: `E${index + 1}`, ...item }));
  const asOf = packet?.run_time || sourceRows[0]?.published_at || new Date().toISOString();
  const packetSummary = packet
    ? `阶段=${packet.stage}；结论=${packet.conclusion || "无"}；增长=${formatNumber(packet.growth_score)}；动量=${formatNumber(packet.momentum_score)}；风险=${formatNumber(packet.risk)}；置信=${formatNumber(packet.confidence)}；证据评分=${formatNumber(packet.evidence_score)}；全量证据=${packet.evidence_count}条`
    : "最新雷达没有该行业的正式数据包，以下仅使用关联来源和指标形成低置信论点。";
  return {
    evidenceHash: `${title}:${asOf}:${packet?.evidence_count ?? citations.length}`,
    asOf,
    summary: `行业：${title}\n雷达摘要：${packetSummary}`,
    citations,
  };
}

async function readWatchlistRow(db: D1Database, userKey: string, id: string) {
  return db.prepare(
    `SELECT id, user_id, user_key, company_name, ticker, market, exchange_name, listing_place, market_type, source, report_library_id, added_at
     FROM user_watchlist WHERE user_key = ?1 AND id = ?2`,
  ).bind(userKey, id).first<WatchlistRow>();
}

export function radarScanToResearchCitations(radar: RadarScan | null | undefined, industry: string) {
  if (!radar) return [];
  const industryKey = normalizedIndustryKey(industry);
  const packet = radar.industryPackets?.find((entry) => normalizedIndustryKey(entry.industry) === industryKey);
  const sectionItems = [
    ...radar.solidGrowth,
    ...radar.sustainability,
    ...radar.bubbleRisks,
    ...radar.upcomingGrowth,
    ...radar.decliningIndustries,
  ].filter((item) =>
    normalizedIndustryKey(item.title) === industryKey
    || item.industries.some((name) => normalizedIndustryKey(name) === industryKey),
  );
  const sourceIds = new Set([
    ...(packet?.sourceIds ?? []),
    ...sectionItems.flatMap((item) => item.sourceIds ?? []),
  ]);
  const sources = radar.evidenceSources ?? [];
  const matchedSources = sourceIds.size
    ? sources
      .filter((source) => sourceIds.has(source.id))
      .sort((left, right) => {
        const sourceOrder = [...sourceIds];
        return sourceOrder.indexOf(left.id) - sourceOrder.indexOf(right.id);
      })
    : focusedIndustrySources(sources, industry);
  return matchedSources
    .map<Omit<ResearchThesisCitation, "id">>((source) => ({
      title: source.title,
      sourceType: source.sourceType,
      summary: source.summary || source.query || "来源未提供摘要。",
      ...(source.url ? { url: source.url } : {}),
      ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
    }));
}

async function readIndustryResearchEvidence(env: AssistantEnv, item: ResearchWorkbenchItem) {
  const db = env.REPORT_LIBRARY_DB;
  if (!db) throw new Error("REPORT_LIBRARY_DB is not configured.");
  const packet = await db.prepare(
    `SELECT ri.industry_id, ri.stage, ri.conclusion, ri.confidence, ri.risk, ri.growth_score, ri.momentum_score,
            ri.evidence_score, ri.evidence_count, rr.run_time
     FROM radar_items ri
     JOIN radar_runs rr ON rr.id = ri.run_id
     LEFT JOIN industries i ON i.id = ri.industry_id
     WHERE rr.id = (SELECT id FROM radar_runs ORDER BY run_time DESC LIMIT 1)
       AND (i.name = ?1 OR ri.industry_id = ?2)
     ORDER BY ri.evidence_score DESC LIMIT 1`,
  ).bind(item.title, item.entityId).first<IndustryPacketRow>().catch(() => null);
  const industryId = packet?.industry_id || item.entityId;
  const [sources, indicators, cachedRadar] = await Promise.all([
    db.prepare(
      `SELECT title, source_type, content, url, published_at, confidence
       FROM evidence_items WHERE related_industry_id = ?1
       ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 24`,
    ).bind(industryId).all<IndustryEvidenceRow>().catch(() => ({ results: [] })),
    db.prepare(
      `SELECT indicator_name, value, period, source
       FROM indicator_values WHERE entity_type = 'industry' AND entity_id = ?1
       ORDER BY created_at DESC LIMIT 16`,
    ).bind(industryId).all<IndustryIndicatorRow>().catch(() => ({ results: [] })),
    readLatestRadarScan(env.REPORT_CACHE),
  ]);
  return industryRowsToResearchEvidence({
    title: item.title,
    packet,
    radarCitations: radarScanToResearchCitations(cachedRadar, item.title),
    sourceRows: sources.results ?? [],
    indicatorRows: indicators.results ?? [],
  });
}

async function readLatestRadarScan(cache?: KVNamespace) {
  if (!cache) return null;
  for (const key of ["radar-scan:v2:latest", "radar-scan:v1:latest"]) {
    const payload = await cache.get<{ radar?: RadarScan }>(key, "json").catch(() => null);
    if (payload?.radar) return payload.radar;
  }
  return null;
}

function boundedJson(value: unknown, maxChars: number) {
  const text = JSON.stringify(value ?? {});
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function formatNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(2)).toString() : "NA";
}

function dedupeCitations(citations: Array<Omit<ResearchThesisCitation, "id">>) {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.url || ""}|${citation.title}|${citation.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedIndustryKey(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[\s\-_/、（）()]+/g, "");
}

function focusedIndustrySources(sources: NonNullable<RadarScan["evidenceSources"]>, industry: string) {
  const keywords = industry
    .split(/[\s\-_/、（）()]+/)
    .map((item) => item.trim().toLocaleLowerCase())
    .filter((item) => item.length >= 2);
  if (!keywords.length) return [];
  return sources
    .map((source) => {
      const text = `${source.query} ${source.title} ${source.summary || ""}`.toLocaleLowerCase();
      const keywordScore = keywords.reduce((score, keyword) => score + (text.includes(keyword) ? 1 : 0), 0);
      return { source, keywordScore };
    })
    .filter((entry) => entry.keywordScore > 0)
    .sort((left, right) => right.keywordScore - left.keywordScore || (right.source.weight ?? 0) - (left.source.weight ?? 0))
    .slice(0, 10)
    .map((entry) => entry.source);
}
