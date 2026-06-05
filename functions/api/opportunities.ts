import { requireAdminSession, type AssistantEnv } from "../_shared/assistant-db";
import { json } from "../_shared/user-research-db";
import { listResearchItems, listResearchNotifications, ensureResearchWorkbenchSchema } from "../_shared/research-workbench-db";
import { opportunityFromRadarPacket, opportunityFromWatchlistRanking } from "../../src/shared/research-workbench";
import type { RadarIndustryPacket, RadarIndustryStage } from "../../src/shared/radar";
import type { WatchlistRankingEntry } from "../../src/shared/user-research";

type Env = AssistantEnv & {
  REPORT_LIBRARY_DB?: D1Database;
};

type RadarItemRow = {
  industry_name: string | null;
  theme_name: string | null;
  stage: string;
  conclusion: string | null;
  confidence: number | null;
  risk: number | null;
  growth_score: number | null;
  momentum_score: number | null;
  evidence_score: number | null;
  valuation_risk: number | null;
  bubble_risk: number | null;
  decline_risk: number | null;
  evidence_count: number;
};

type RankingRow = {
  id: string;
  watchlist_id: string;
  company_name: string;
  ticker: string;
  market: string;
  status: string;
  company_quality_score: number | null;
  investment_attractiveness_score: number | null;
  overall_score: number | null;
  verdict: string | null;
  summary: string | null;
  content_json: string | null;
  updated_at: string;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const { response, session } = await requireAdminSession(request, env);
  if (response) return response;
  if (!session) return json({ error: "Unauthorized." }, 401);
  if (!env.REPORT_LIBRARY_DB) return json({ error: "REPORT_LIBRARY_DB is not configured." }, 500);
  await ensureResearchWorkbenchSchema(env.REPORT_LIBRARY_DB);

  const [radarRows, rankingRows, researchItems, notifications] = await Promise.all([
    readLatestRadarRows(env.REPORT_LIBRARY_DB),
    readWatchlistRankingRows(env.REPORT_LIBRARY_DB, session.userId),
    listResearchItems(env.REPORT_LIBRARY_DB, session.userId),
    listResearchNotifications(env.REPORT_LIBRARY_DB, session.userId, 20),
  ]);
  const radarSignals = radarRows.map(radarPacketFromRow).map(opportunityFromRadarPacket);
  const companySignals = rankingRows.map(rankingEntryFromRow).map(opportunityFromWatchlistRanking);
  const opportunities = [...radarSignals, ...companySignals]
    .sort((left, right) => right.opportunityScore - left.opportunityScore || right.evidenceScore - left.evidenceScore)
    .slice(0, 80);
  const riskWorsening = opportunities
    .filter((item) => item.riskScore >= 65 || /风险|衰退|回避|泡沫/.test(item.reasons.join(" ")))
    .sort((left, right) => right.riskScore - left.riskScore)
    .slice(0, 20);
  return json({
    generatedAt: new Date().toISOString(),
    opportunities,
    topResearch: opportunities.slice(0, 20),
    riskWorsening,
    catalysts: opportunities.filter((item) => item.catalystScore >= 65).slice(0, 20),
    funnel: buildFunnel(researchItems),
    inbox: notifications,
    researchItems,
  });
};

async function readLatestRadarRows(db: D1Database) {
  const result = await db.prepare(
    `SELECT COALESCE(i.name, ri.industry_id, ri.theme_id, '未命名行业') AS industry_name,
            t.name AS theme_name,
            ri.stage, ri.conclusion, ri.confidence, ri.risk, ri.growth_score, ri.momentum_score,
            ri.evidence_score, ri.valuation_risk, ri.bubble_risk, ri.decline_risk, ri.evidence_count
     FROM radar_items ri
     JOIN radar_runs rr ON rr.id = ri.run_id
     LEFT JOIN industries i ON i.id = ri.industry_id
     LEFT JOIN themes t ON t.id = ri.theme_id
     WHERE rr.id = (SELECT id FROM radar_runs ORDER BY run_time DESC LIMIT 1)
     ORDER BY ri.evidence_score DESC, ri.growth_score DESC
     LIMIT 120`,
  ).all<RadarItemRow>().catch(() => ({ results: [] }));
  return result.results ?? [];
}

async function readWatchlistRankingRows(db: D1Database, userKey: string) {
  const result = await db.prepare(
    `SELECT id, watchlist_id, company_name, ticker, market, status, company_quality_score, investment_attractiveness_score,
            overall_score, verdict, summary, content_json, updated_at
     FROM watchlist_ranking_score
     WHERE user_key = ?1
     ORDER BY overall_score DESC, updated_at DESC
     LIMIT 120`,
  ).bind(userKey).all<RankingRow>().catch(() => ({ results: [] }));
  return result.results ?? [];
}

function radarPacketFromRow(row: RadarItemRow): RadarIndustryPacket {
  const industry = row.industry_name || row.theme_name || "未命名行业";
  return {
    group: row.theme_name || "雷达行业",
    industry,
    status: "scanned",
    stage: normalizeRadarStage(row.stage),
    evidenceHash: `${industry}:${row.stage}:${row.evidence_count}`,
    sourceCount: row.evidence_count || 0,
    evidenceTypes: [],
    signalTypes: [],
    evidenceGaps: row.evidence_count >= 3 ? [] : ["缺多源验证"],
    themes: row.theme_name ? [row.theme_name] : [],
    scores: {
      growth: row.growth_score ?? 0,
      momentum: row.momentum_score ?? 0,
      evidence: row.evidence_score ?? row.evidence_count * 3,
      valuationRisk: row.valuation_risk ?? 0,
      bubbleRisk: row.bubble_risk ?? 0,
      declineRisk: row.decline_risk ?? row.risk ?? 0,
      confidence: row.confidence ?? 0,
      change: 30,
    },
  };
}

function rankingEntryFromRow(row: RankingRow): WatchlistRankingEntry {
  const content = parseContent(row.content_json);
  return {
    id: row.id,
    watchlistId: row.watchlist_id,
    companyName: row.company_name,
    ticker: row.ticker,
    market: row.market,
    status: row.status as WatchlistRankingEntry["status"],
    companyQualityScore: row.company_quality_score ?? undefined,
    investmentAttractivenessScore: row.investment_attractiveness_score ?? undefined,
    overallScore: row.overall_score ?? undefined,
    verdict: row.verdict ?? undefined,
    summary: row.summary ?? undefined,
    keyPoints: content.keyPoints,
    riskFlags: content.riskFlags,
    updatedAt: row.updated_at,
  };
}

function parseContent(value: string | null): { keyPoints: string[]; riskFlags: string[] } {
  if (!value) return { keyPoints: [], riskFlags: [] };
  try {
    const parsed = JSON.parse(value) as { keyPoints?: unknown; riskFlags?: unknown };
    return {
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(String) : [],
      riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags.map(String) : [],
    };
  } catch {
    return { keyPoints: [], riskFlags: [] };
  }
}

function buildFunnel(items: Awaited<ReturnType<typeof listResearchItems>>) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.stage, (counts.get(item.stage) ?? 0) + 1);
  return ["screening", "deepResearch", "awaitingCatalyst", "opinionFormed", "archived"].map((stage) => ({ stage, count: counts.get(stage) ?? 0 }));
}

function normalizeRadarStage(value: string): RadarIndustryStage {
  return ["扎实增长", "即将增长", "泡沫风险", "衰退", "平稳现金流", "继续观察", "证据不足"].includes(value)
    ? value as RadarIndustryStage
    : "继续观察";
}
