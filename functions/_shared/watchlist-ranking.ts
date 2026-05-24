import { jsonrepair } from "jsonrepair";
import type { EvidenceBundle } from "./providers";
import { sha256, type WatchlistRankingRow, type WatchlistRow } from "./user-research-db";

const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const WATCHLIST_RANKING_SCHEMA_VERSION = "v1";

export type WatchlistRankingEnv = {
  DEEPSEEK_API_KEY?: string;
  REPORT_LIBRARY_DB?: D1Database;
};

export type GeneratedWatchlistRanking = {
  companyQualityScore: number;
  investmentAttractivenessScore: number;
  overallScore: number;
  verdict: string;
  summary: string;
  keyPoints: string[];
  riskFlags: string[];
  modelUsed?: string;
};

export async function watchlistRankingJobId(userId: string, watchlistId: string) {
  return sha256(`watchlist-ranking:${WATCHLIST_RANKING_SCHEMA_VERSION}:${userId}:${watchlistId}`);
}

export async function writeWatchlistRankingRunning(db: D1Database, userId: string, watchlist: WatchlistRow, evidenceHash?: string) {
  const now = new Date().toISOString();
  const id = await watchlistRankingJobId(userId, watchlist.id);
  await db
    .prepare(
      `INSERT INTO watchlist_ranking_score (
        id, user_key, watchlist_id, company_name, ticker, market, status, model,
        company_quality_score, investment_attractiveness_score, overall_score, verdict, summary,
        content_json, evidence_hash, created_at, updated_at, started_at, completed_at, error_message
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', 'deepseek-v4-flash', NULL, NULL, NULL, '评分中', '后台正在基于公司证据包重新评分。', ?7, ?8, ?9, ?9, ?9, NULL, NULL)
      ON CONFLICT(user_key, watchlist_id) DO UPDATE SET
        status = 'running',
        model = 'deepseek-v4-flash',
        verdict = '评分中',
        summary = '后台正在基于公司证据包重新评分。',
        content_json = excluded.content_json,
        evidence_hash = excluded.evidence_hash,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        completed_at = NULL,
        error_message = NULL`,
    )
    .bind(id, userId, watchlist.id, watchlist.company_name, watchlist.ticker, watchlist.market, JSON.stringify({ keyPoints: [], riskFlags: [] }), evidenceHash ?? null, now)
    .run();
  return id;
}

export async function writeWatchlistRankingFailure(db: D1Database, userId: string, watchlistId: string, error: unknown, evidenceHash?: string) {
  const now = new Date().toISOString();
  const id = await watchlistRankingJobId(userId, watchlistId);
  await db
    .prepare(
      `UPDATE watchlist_ranking_score
       SET status = 'failed_retryable', updated_at = ?1, error_message = ?2, evidence_hash = COALESCE(?3, evidence_hash)
       WHERE user_key = ?4 AND id = ?5`,
    )
    .bind(now, error instanceof Error ? error.message : String(error ?? "自选评分失败。"), evidenceHash ?? null, userId, id)
    .run();
}

export async function writeCompletedWatchlistRanking(db: D1Database, userId: string, watchlist: WatchlistRow, generated: GeneratedWatchlistRanking, evidenceHash?: string) {
  const now = new Date().toISOString();
  const id = await watchlistRankingJobId(userId, watchlist.id);
  await db
    .prepare(
      `INSERT INTO watchlist_ranking_score (
        id, user_key, watchlist_id, company_name, ticker, market, status, model,
        company_quality_score, investment_attractiveness_score, overall_score, verdict, summary,
        content_json, evidence_hash, created_at, updated_at, started_at, completed_at, error_message
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'completed', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, COALESCE((SELECT started_at FROM watchlist_ranking_score WHERE user_key = ?2 AND watchlist_id = ?3), ?15), ?15, NULL)
      ON CONFLICT(user_key, watchlist_id) DO UPDATE SET
        status = 'completed',
        model = excluded.model,
        company_quality_score = excluded.company_quality_score,
        investment_attractiveness_score = excluded.investment_attractiveness_score,
        overall_score = excluded.overall_score,
        verdict = excluded.verdict,
        summary = excluded.summary,
        content_json = excluded.content_json,
        evidence_hash = excluded.evidence_hash,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        error_message = NULL`,
    )
    .bind(
      id,
      userId,
      watchlist.id,
      watchlist.company_name,
      watchlist.ticker,
      watchlist.market,
      generated.modelUsed || "deepseek-v4-flash",
      clampScore(generated.companyQualityScore),
      clampScore(generated.investmentAttractivenessScore),
      clampScore(generated.overallScore),
      generated.verdict.slice(0, 80),
      generated.summary.slice(0, 500),
      JSON.stringify({ keyPoints: generated.keyPoints.slice(0, 8), riskFlags: generated.riskFlags.slice(0, 8) }),
      evidenceHash ?? null,
      now,
    )
    .run();
  return id;
}

export async function requestWatchlistRankingScore(env: WatchlistRankingEnv, watchlist: WatchlistRow, evidence: EvidenceBundle): Promise<GeneratedWatchlistRanking> {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured.");
  const body = {
    model: "deepseek-v4-flash",
    reasoning_effort: "max",
    temperature: 0.08,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "CSTD Alpha watchlist ranking cache anchor. You are a strict A/H/US stock ranking analyst. Score only from the supplied public evidence package. Never reuse old report-library scores. Penalize weak evidence, leverage, cash-flow weakness, governance risk, valuation bubble, cyclicality and business deterioration. Return only valid JSON.",
      },
      {
        role: "user",
        content: JSON.stringify({
          kind: "watchlist-ranking-score",
          scoringScale: "0-100",
          outputSchema: {
            companyQualityScore: "0-100 number: business quality, moat, financial quality, governance, durability",
            investmentAttractivenessScore: "0-100 number: current price attractiveness, forward return/risk, catalysts, valuation discipline",
            overallScore: "0-100 number, weighted quality 55% and attractiveness 45% with risk caps",
            verdict: "short Chinese verdict",
            summary: "one concise Chinese paragraph",
            keyPoints: ["3-6 evidence-backed positives"],
            riskFlags: ["3-6 evidence-backed risks or evidence gaps"],
          },
          hardRules: [
            "Do not give high scores for famous companies without evidence.",
            "If evidence lacks cash-flow, debt, valuation or current financial facts, cap companyQualityScore at 72 and investmentAttractivenessScore at 65.",
            "If major red flags exist, cap overallScore at 49.",
            "If valuation is expensive and growth evidence is not strong, investmentAttractivenessScore must be lower than companyQualityScore.",
            "Every score must be explained by evidence ids or source types in keyPoints/riskFlags.",
          ],
          company: {
            name: watchlist.company_name,
            ticker: watchlist.ticker,
            market: watchlist.market,
          },
          evidence: compactEvidence(evidence),
        }),
      },
    ],
  };
  const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`DeepSeek watchlist ranking failed: ${response.status} ${text.slice(0, 300)}`);
  const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("DeepSeek 未返回自选排行评分。");
  return normalizeGeneratedRanking(JSON.parse(jsonrepair(content)));
}

export function normalizeGeneratedRanking(value: unknown): GeneratedWatchlistRanking {
  const record = isRecord(value) ? value : {};
  const cqs = clampScore(numberValue(record.companyQualityScore));
  const ias = clampScore(numberValue(record.investmentAttractivenessScore));
  const rawOverall = numberValue(record.overallScore);
  return {
    companyQualityScore: cqs,
    investmentAttractivenessScore: ias,
    overallScore: clampScore(Number.isFinite(rawOverall) ? rawOverall : cqs * 0.55 + ias * 0.45),
    verdict: stringValue(record.verdict) || "观察",
    summary: stringValue(record.summary) || "已基于当前证据包完成自选股评分，仍需结合证据缺口复核。",
    keyPoints: stringArray(record.keyPoints).slice(0, 8),
    riskFlags: stringArray(record.riskFlags).slice(0, 8),
  };
}

export function rankingCacheReusable(row: Pick<WatchlistRankingRow, "status" | "evidence_hash"> | null | undefined, evidenceHash?: string, forceRefresh = false) {
  return !forceRefresh && row?.status === "completed" && !!evidenceHash && row.evidence_hash === evidenceHash;
}

function compactEvidence(evidence: EvidenceBundle) {
  return {
    retrievedAt: evidence.retrievedAt,
    facts: evidence.facts,
    sources: evidence.evidence.slice(0, 40).map((item, index) => ({
      id: `E${index + 1}`,
      title: item.title,
      source: item.source,
      freshness: item.freshness,
      notes: item.notes,
    })),
  };
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function numberValue(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
