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
  const coverage = evidenceCoverageSummary(evidence);
  const body = {
    model: "deepseek-v4-flash",
    reasoning_effort: "max",
    temperature: 0.08,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          [
            "CSTD Alpha watchlist ranking cache anchor. You are a strict A/H/US stock ranking analyst.",
            "Score only from the supplied public evidence package. Never reuse old report-library scores.",
            "Separate company quality from investment attractiveness. Great companies can be poor buys when valuation already prices in growth.",
            "CompanyQualityScore measures business quality, not whether the stock is cheap. Do not cut quality below 75 solely for high valuation or missing forward guidance when hard financial data shows strong profitability, cash flow and low leverage.",
            "Penalize weak evidence, leverage, cash-flow weakness, governance risk, valuation bubble, cyclicality and business deterioration.",
            "InvestmentAttractivenessScore >=80 is rare: it requires attractive valuation, clear catalysts, downside protection, and no major evidence gap.",
            "For an excellent but expensive company, a typical output is high CompanyQualityScore and medium InvestmentAttractivenessScore, not low scores for both.",
            "If you write valuation is high/expensive/safety margin limited/market expectation is already full, investmentAttractivenessScore must be <=62.",
            "If evidence lacks segment data, forward guidance, valuation or current hard financial facts, cap companyQualityScore at 80 and investmentAttractivenessScore at 62.",
            "Ignore placeholder sources that say unavailable, no data, fallback returned no data, or symbol search only.",
            "The JSON object MUST include top-level numeric fields: companyQualityScore, investmentAttractivenessScore, overallScore. Do not nest scores under scores/result/output.",
            "If you cannot decide exactly, still return conservative numeric scores instead of omitting fields.",
            "Return only valid JSON.",
          ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          kind: "watchlist-ranking-score",
          scoringScale: "0-100",
          outputSchema: {
            required: ["companyQualityScore", "investmentAttractivenessScore", "overallScore", "verdict", "summary", "keyPoints", "riskFlags"],
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
            "If evidence lacks cash-flow, debt, valuation or current financial facts, cap companyQualityScore at 72 and investmentAttractivenessScore at 58.",
            "If the company is high quality but valuation is high or safety margin is limited, keep companyQualityScore high but cap investmentAttractivenessScore at 62.",
            "If the evidence package itself has obvious gaps, do not compensate with brand fame; cap companyQualityScore at 80 and investmentAttractivenessScore at 62.",
            "If usableEvidenceCount < 4 or usableHardEvidenceCount < 2, companyQualityScore must be <=78 and investmentAttractivenessScore must be <=62.",
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
          evidenceCoverage: coverage,
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
  return applyEvidenceCoverageCaps(normalizeGeneratedRanking(JSON.parse(jsonrepair(content))), coverage);
}

export function normalizeGeneratedRanking(value: unknown): GeneratedWatchlistRanking {
  const record = isRecord(value) ? value : {};
  const records = candidateRankingRecords(record);
  const cqsRaw = firstNumberValue(records, ["companyQualityScore", "company_quality_score", "qualityScore", "quality_score", "quality", "公司质量分", "公司质量评分", "公司质量", "质量分", "质量评分", "质量"]);
  const iasRaw = firstNumberValue(records, [
    "investmentAttractivenessScore",
    "investment_attractiveness_score",
    "attractivenessScore",
    "attractiveness_score",
    "investmentScore",
    "investment_score",
    "attractiveness",
    "投资吸引力分",
    "投资吸引力评分",
    "投资吸引力",
    "吸引力分",
    "吸引力评分",
    "吸引力",
  ]);
  const rawOverall = firstNumberValue(records, ["overallScore", "overall_score", "totalScore", "total_score", "overall", "score", "综合分", "综合评分", "综合", "总分", "总评分"]);
  const cqs = clampScore(Number.isFinite(cqsRaw) ? cqsRaw : 50);
  const ias = clampScore(Number.isFinite(iasRaw) ? iasRaw : 40);
  return applyRankingRiskCaps({
    companyQualityScore: cqs,
    investmentAttractivenessScore: ias,
    overallScore: clampScore(Number.isFinite(rawOverall) ? rawOverall : cqs * 0.55 + ias * 0.45),
    verdict: sanitizeRankingNarrative(firstStringValue(records, ["verdict", "conclusion", "结论", "评级"]) || "观察"),
    summary: sanitizeRankingNarrative(firstStringValue(records, ["summary", "摘要", "理由", "分析"]) || "已基于当前证据包完成自选股评分，仍需结合证据缺口复核。"),
    keyPoints: firstStringArray(records, ["keyPoints", "positives", "主要得分点", "得分点", "优势"]).slice(0, 8),
    riskFlags: firstStringArray(records, ["riskFlags", "risks", "风险与反证", "风险点", "风险"]).slice(0, 8),
  });
}

export function sanitizeRankingNarrative(text: string) {
  return text
    .replace(/[^。；;\n]*(?:公司质量|质量|投资吸引力|吸引力|整体|综合)[^。；;\n]{0,24}(?:评分|得分|分数|[0-9]{1,3}分)[^。；;\n]*(?:。|；|;)?/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[，。,；;\s]+/, "")
    .trim();
}

function applyRankingRiskCaps(ranking: GeneratedWatchlistRanking): GeneratedWatchlistRanking {
  const text = `${ranking.verdict}\n${ranking.summary}\n${ranking.keyPoints.join("\n")}\n${ranking.riskFlags.join("\n")}`;
  let companyQualityScore = ranking.companyQualityScore;
  let investmentAttractivenessScore = ranking.investmentAttractivenessScore;
  let overallCap = 100;
  const weakCashFlowOrLoss = /自由现金流[^，。；\n]*(为负|转负|负值)|经营现金流[^，。；\n]*(为负|转负|负值)|现金流[^，。；\n]*恶化|持续亏损|持续巨亏|连续[^，。；\n]*亏损|巨额亏损|亏损[0-9一二三四五六七八九十百千万亿]|尚未盈利|仍未盈利|仍处于亏损|未实现盈利|盈利未现|净亏损/.test(text);
  const explicitAvoid = /严重|危机|建议回避|回避|不宜投资|不宜买入|暂不宜投资|退市|资不抵债|债务展期|价值陷阱|质量极差/.test(text);
  const severeNegative = explicitAvoid || weakCashFlowOrLoss;
  const strongFinancialQuality = /财务.*(极为)?强劲|盈利能力.*(强|优秀|极强)|自由现金流.*(极高|充裕|强劲|健康)|经营现金流.*(强劲|充裕|健康)|净利率.*(高达|超过|接近)|资产负债率.*(低|下降)|低杠杆|现金流质量高/.test(text);

  const extremelyExpensive = /估值极高|估值泡沫|市盈率.*(?:[8-9]\d|[1-9]\d{2,})|PE.*(?:[8-9]\d|[1-9]\d{2,})|PB.*(?:1[2-9]|[2-9]\d)|市净率.*(?:1[2-9]|[2-9]\d)/i.test(text);
  const expensiveOrLimitedMargin = /估值(偏高|较高|不低|高|中高|泡沫|已充分|较充分)|安全边际(有限|不足)|预期已(较)?充分|市盈率.*(高|不低)|PE.*(高|不低)|自由现金流收益率.*低/.test(text);
  if (expensiveOrLimitedMargin) {
    investmentAttractivenessScore = Math.min(investmentAttractivenessScore, extremelyExpensive ? 45 : 62);
    if (extremelyExpensive) overallCap = Math.min(overallCap, 65);
  }
  if (/证据(未包含|不足|缺|缺乏|缺少)|无法评估|未提供|待核实|需谨慎|证据包未/.test(text)) {
    companyQualityScore = Math.min(companyQualityScore, extremelyExpensive ? 78 : 80);
    investmentAttractivenessScore = Math.min(investmentAttractivenessScore, 62);
  }
  if (weakCashFlowOrLoss) {
    companyQualityScore = Math.min(companyQualityScore, 60);
    investmentAttractivenessScore = Math.min(investmentAttractivenessScore, 45);
    overallCap = Math.min(overallCap, 49);
  }
  if (explicitAvoid) {
    investmentAttractivenessScore = Math.min(investmentAttractivenessScore, 45);
    overallCap = Math.min(overallCap, 49);
  }
  if (strongFinancialQuality && !severeNegative) {
    const nextQualityScore = Math.max(companyQualityScore, 78);
    companyQualityScore = nextQualityScore;
    if (expensiveOrLimitedMargin && !extremelyExpensive) {
      const nextAttractivenessScore = Math.max(investmentAttractivenessScore, 55);
      investmentAttractivenessScore = nextAttractivenessScore;
    }
  }

  const recalculatedOverall = clampScore(companyQualityScore * 0.55 + investmentAttractivenessScore * 0.45);
  const cappedOverall = Math.min(overallCap, recalculatedOverall);
  return {
    ...ranking,
    companyQualityScore: clampScore(companyQualityScore),
    investmentAttractivenessScore: clampScore(investmentAttractivenessScore),
    overallScore: clampScore(cappedOverall),
  };
}

export function rankingCacheReusable(row: Pick<WatchlistRankingRow, "status" | "evidence_hash"> | null | undefined, evidenceHash?: string, forceRefresh = false) {
  return !forceRefresh && row?.status === "completed" && !!evidenceHash && row.evidence_hash === evidenceHash;
}

function compactEvidence(evidence: EvidenceBundle) {
  const usableSources = evidence.evidence.filter(isUsableEvidenceItem);
  return {
    retrievedAt: evidence.retrievedAt,
    facts: evidence.facts,
    sources: usableSources.slice(0, 40).map((item, index) => ({
      id: `E${index + 1}`,
      title: item.title,
      source: item.source,
      freshness: item.freshness,
      notes: item.notes,
    })),
  };
}

export function evidenceCoverageSummary(evidence: EvidenceBundle) {
  const usableItems = evidence.evidence.filter(isUsableEvidenceItem);
  const hardItems = usableItems.filter(isHardEvidenceItem);
  const sourceFamilies = Array.from(new Set(usableItems.map((item) => sourceFamily(item.source || item.title || "unknown")))).sort();
  const hardSourceFamilies = Array.from(new Set(hardItems.map((item) => sourceFamily(item.source || item.title || "unknown")))).sort();
  return {
    totalEvidenceCount: evidence.evidence.length,
    usableEvidenceCount: usableItems.length,
    usableHardEvidenceCount: hardItems.length,
    sourceFamilies,
    hardSourceFamilies,
    ignoredPlaceholderCount: evidence.evidence.length - usableItems.length,
  };
}

export function applyEvidenceCoverageCaps(ranking: GeneratedWatchlistRanking, coverage: ReturnType<typeof evidenceCoverageSummary>): GeneratedWatchlistRanking {
  let companyQualityScore = ranking.companyQualityScore;
  let investmentAttractivenessScore = ranking.investmentAttractivenessScore;

  if (coverage.usableEvidenceCount < 4 || coverage.usableHardEvidenceCount < 2 || coverage.sourceFamilies.length < 2) {
    companyQualityScore = Math.min(companyQualityScore, 78);
    investmentAttractivenessScore = Math.min(investmentAttractivenessScore, 62);
  }
  if (coverage.usableEvidenceCount <= 2 || coverage.usableHardEvidenceCount <= 1) {
    companyQualityScore = Math.min(companyQualityScore, 72);
    investmentAttractivenessScore = Math.min(investmentAttractivenessScore, 55);
  }

  const overallScore = clampScore(Math.min(ranking.overallScore, companyQualityScore * 0.55 + investmentAttractivenessScore * 0.45));
  return {
    ...ranking,
    companyQualityScore: clampScore(companyQualityScore),
    investmentAttractivenessScore: clampScore(investmentAttractivenessScore),
    overallScore,
  };
}

function isUsableEvidenceItem(item: { title?: string; source?: string; notes?: string }) {
  const text = `${item.title || ""} ${item.source || ""} ${item.notes || ""}`.toLowerCase();
  if (/symbol search|public company identity|suggest endpoint/.test(text)) return false;
  if (/unavailable|no usable|returned no data|no data|does not expose|fallback was unavailable/.test(text)) return false;
  return true;
}

function isHardEvidenceItem(item: { title?: string; source?: string; notes?: string }) {
  const text = `${item.title || ""} ${item.source || ""} ${item.notes || ""}`.toLowerCase();
  return /financial|finance|财务|财报|cashflow|income|balance|sec edgar|quote|price|行情|报价|估值|market|fundamentals|companyfacts/.test(text);
}

function sourceFamily(source: string) {
  const normalized = source.toLowerCase();
  if (normalized.includes("eastmoney")) return "eastmoney";
  if (normalized.includes("yahoo")) return "yahoo";
  if (normalized.includes("sec")) return "sec";
  if (normalized.includes("stooq")) return "stooq";
  if (normalized.includes("anysearch")) return "anysearch";
  if (normalized.includes("searx")) return "searxng";
  return source.slice(0, 48).toLowerCase();
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

function candidateRankingRecords(record: Record<string, unknown>) {
  const candidates = [record];
  for (const key of ["scores", "score", "ranking", "result", "output", "data"]) {
    const value = record[key];
    if (isRecord(value)) candidates.push(value);
  }
  return candidates;
}

function firstNumberValue(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = numberValue(record[key]);
      if (Number.isFinite(value)) return value;
    }
  }
  return Number.NaN;
}

function firstStringValue(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = stringValue(record[key]);
      if (value) return value;
    }
  }
  return "";
}

function firstStringArray(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = stringArray(record[key]);
      if (value.length) return value;
    }
  }
  return [];
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
