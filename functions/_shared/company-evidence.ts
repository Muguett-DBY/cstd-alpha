import type { EvidenceItem } from "../../src/shared/report";
import { fetchPublicCompanyEvidence, type EvidenceBundle } from "./providers";
import { sha256, watchlistRowToItem, type WatchlistRow } from "./user-research-db";

export type CompanyEvidenceItem = EvidenceItem & {
  id: string;
  evidenceType: "financial" | "quote" | "external_search" | "official" | "news" | "other";
};

export type CompanyEvidencePackage = {
  version: 1;
  userId: string;
  watchlistId: string;
  companyKey: string;
  evidenceHash: string;
  stableHash: string;
  freshHash: string;
  fetchedAt: string;
  stableFacts: unknown;
  freshSignals: unknown;
  evidence: Omit<EvidenceBundle, "evidence"> & { evidence: CompanyEvidenceItem[] };
};

export type CompanyEvidenceEnv = {
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
};

const COMPANY_EVIDENCE_PREFIX = "user-research/v1/company-evidence";
const LATEST_EVIDENCE_STATUS = "ready";

export async function ensureCompanyEvidenceSchema(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS company_evidence_packages (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        user_key TEXT NOT NULL,
        watchlist_id TEXT NOT NULL,
        company_name TEXT NOT NULL,
        ticker TEXT NOT NULL,
        market TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        stable_hash TEXT NOT NULL,
        fresh_hash TEXT NOT NULL,
        object_key TEXT NOT NULL,
        status TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error_message TEXT,
        UNIQUE(user_key, watchlist_id)
      )`,
    )
    .run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_company_evidence_user ON company_evidence_packages (user_key, updated_at DESC)`).run();
}

export async function fetchAndStoreCompanyEvidence({
  env,
  userId,
  watchlist,
  signal,
}: {
  env: Required<Pick<CompanyEvidenceEnv, "REPORT_LIBRARY_DB" | "REPORT_LIBRARY_BUCKET">>;
  userId: string;
  watchlist: WatchlistRow;
  signal?: AbortSignal;
}) {
  await ensureCompanyEvidenceSchema(env.REPORT_LIBRARY_DB);
  const evidence = await fetchPublicCompanyEvidence({
    companyName: watchlist.company_name,
    ticker: watchlist.ticker,
    market: watchlist.market,
    company: watchlistRowToItem(watchlist).company,
    signal,
  });
  const pkg = await buildCompanyEvidencePackage({ userId, watchlistId: watchlist.id, evidence });
  await writeCompanyEvidencePackage(env, userId, watchlist, pkg);
  return pkg;
}

export async function readCompanyEvidencePackage(env: CompanyEvidenceEnv, userId: string, watchlist: WatchlistRow): Promise<CompanyEvidencePackage | null> {
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) return null;
  await ensureCompanyEvidenceSchema(env.REPORT_LIBRARY_DB);
  const row = await env.REPORT_LIBRARY_DB.prepare(
    `SELECT object_key
     FROM company_evidence_packages
     WHERE user_key = ?1 AND watchlist_id = ?2 AND status = ?3`,
  )
    .bind(userId, watchlist.id, LATEST_EVIDENCE_STATUS)
    .first<{ object_key: string }>();
  if (!row?.object_key) return null;
  const object = await env.REPORT_LIBRARY_BUCKET.get(row.object_key).catch(() => null);
  if (!object) return null;
  const payload = (await object.json().catch(() => null)) as CompanyEvidencePackage | null;
  return payload && payload.evidenceHash ? payload : null;
}

export async function getOrCreateCompanyEvidencePackage(env: CompanyEvidenceEnv, userId: string, watchlist: WatchlistRow, signal?: AbortSignal) {
  const cached = await readCompanyEvidencePackage(env, userId, watchlist);
  if (cached) return cached;
  if (!env.REPORT_LIBRARY_DB || !env.REPORT_LIBRARY_BUCKET) {
    const evidence = await fetchPublicCompanyEvidence({
      companyName: watchlist.company_name,
      ticker: watchlist.ticker,
      market: watchlist.market,
      company: watchlistRowToItem(watchlist).company,
      signal,
    });
    return buildCompanyEvidencePackage({ userId, watchlistId: watchlist.id, evidence });
  }
  return fetchAndStoreCompanyEvidence({ env: { REPORT_LIBRARY_DB: env.REPORT_LIBRARY_DB, REPORT_LIBRARY_BUCKET: env.REPORT_LIBRARY_BUCKET }, userId, watchlist, signal });
}

export async function writeCompanyEvidencePackage(
  env: Required<Pick<CompanyEvidenceEnv, "REPORT_LIBRARY_DB" | "REPORT_LIBRARY_BUCKET">>,
  userId: string,
  watchlist: WatchlistRow,
  pkg: CompanyEvidencePackage,
) {
  await ensureCompanyEvidenceSchema(env.REPORT_LIBRARY_DB);
  const objectKey = companyEvidenceObjectKey(userId, watchlist.id, pkg.evidenceHash);
  await env.REPORT_LIBRARY_BUCKET.put(objectKey, JSON.stringify(pkg), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { ticker: watchlist.ticker, market: watchlist.market, evidenceHash: pkg.evidenceHash },
  });
  const now = new Date().toISOString();
  await env.REPORT_LIBRARY_DB.prepare(
    `INSERT INTO company_evidence_packages (
      id, user_id, user_key, watchlist_id, company_name, ticker, market, evidence_hash, stable_hash, fresh_hash, object_key, status, fetched_at, updated_at, error_message
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL)
    ON CONFLICT(user_key, watchlist_id) DO UPDATE SET
      user_id = excluded.user_id,
      company_name = excluded.company_name,
      ticker = excluded.ticker,
      market = excluded.market,
      evidence_hash = excluded.evidence_hash,
      stable_hash = excluded.stable_hash,
      fresh_hash = excluded.fresh_hash,
      object_key = excluded.object_key,
      status = excluded.status,
      fetched_at = excluded.fetched_at,
      updated_at = excluded.updated_at,
      error_message = NULL`,
  )
    .bind(
      await sha256(`${userId}:${watchlist.id}:company-evidence`),
      userId,
      userId,
      watchlist.id,
      watchlist.company_name,
      watchlist.ticker,
      watchlist.market,
      pkg.evidenceHash,
      pkg.stableHash,
      pkg.freshHash,
      objectKey,
      LATEST_EVIDENCE_STATUS,
      pkg.fetchedAt,
      now,
    )
    .run();
  return objectKey;
}

export async function writeCompanyEvidenceFailure(db: D1Database, userId: string, watchlist: WatchlistRow, error: unknown) {
  await ensureCompanyEvidenceSchema(db);
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error ?? "证据包刷新失败");
  await db
    .prepare(
      `INSERT INTO company_evidence_packages (
        id, user_id, user_key, watchlist_id, company_name, ticker, market, evidence_hash, stable_hash, fresh_hash, object_key, status, fetched_at, updated_at, error_message
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', '', '', '', 'failed_retryable', ?8, ?9, ?10)
      ON CONFLICT(user_key, watchlist_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at,
        error_message = excluded.error_message`,
    )
    .bind(await sha256(`${userId}:${watchlist.id}:company-evidence`), userId, userId, watchlist.id, watchlist.company_name, watchlist.ticker, watchlist.market, now, now, message.slice(0, 500))
    .run();
}

export async function buildCompanyEvidencePackage({ userId, watchlistId, evidence }: { userId: string; watchlistId: string; evidence: EvidenceBundle }): Promise<CompanyEvidencePackage> {
  const normalizedEvidence = withStableEvidenceIds(evidence.evidence);
  const stableFacts = stableCompanyFacts(evidence);
  const freshSignals = freshCompanySignals(evidence, normalizedEvidence);
  const stableHash = await hashStable(stableFacts);
  const freshHash = await hashStable(freshSignals);
  const evidenceHash = await hashStable({ company: evidence.company, stableHash, freshHash });
  return {
    version: 1,
    userId,
    watchlistId,
    companyKey: `${evidence.company.market || ""}:${evidence.company.ticker || evidence.company.name}`,
    evidenceHash,
    stableHash,
    freshHash,
    fetchedAt: evidence.retrievedAt,
    stableFacts,
    freshSignals,
    evidence: {
      ...evidence,
      evidence: normalizedEvidence,
      facts: {
        ...evidence.facts,
        companyEvidence: {
          evidenceHash,
          stableHash,
          freshHash,
          note: "模板分析使用公司证据包；关键结论必须引用 E1/E2 这类证据编号或明确来源类型。",
        },
      },
    },
  };
}

export function companyEvidenceObjectKey(userId: string, watchlistId: string, evidenceHash: string) {
  return `${COMPANY_EVIDENCE_PREFIX}/${safeKey(userId)}/${safeKey(watchlistId)}/${evidenceHash}.json`;
}

function withStableEvidenceIds(items: EvidenceItem[]): CompanyEvidenceItem[] {
  return [...items]
    .sort((left, right) => evidenceSortKey(left).localeCompare(evidenceSortKey(right)))
    .map((item, index) => ({ ...item, id: `E${index + 1}`, evidenceType: classifyEvidenceType(item) }));
}

function stableCompanyFacts(evidence: EvidenceBundle) {
  const facts = evidence.facts as Record<string, unknown>;
  return {
    company: evidence.company,
    selectedCompany: facts.selectedCompany,
    financialTenYear: facts.financialTenYear,
    eastmoney: facts.eastmoney,
    sec: facts.sec,
    fundamentals: facts.fundamentals,
  };
}

function freshCompanySignals(evidence: EvidenceBundle, items: CompanyEvidenceItem[]) {
  const facts = evidence.facts as Record<string, unknown>;
  return {
    retrievedAt: evidence.retrievedAt,
    quote: facts.quote,
    summary: facts.summary,
    externalSearch: facts.externalSearch,
    sources: items.map(({ id, title, source, url, freshness, notes, evidenceType }) => ({ id, title, source, url, freshness, notes, evidenceType })),
  };
}

function classifyEvidenceType(item: EvidenceItem): CompanyEvidenceItem["evidenceType"] {
  const text = `${item.title} ${item.source} ${item.notes}`.toLowerCase();
  if (/financial|finance|财务|财报|cashflow|income|balance|sec edgar/.test(text)) return "financial";
  if (/quote|price|行情|报价|估值|market/.test(text)) return "quote";
  if (/anysearch|外部搜索/.test(text)) return "external_search";
  if (/公告|official|investor|交易所|披露/.test(text)) return "official";
  if (/news|新闻|舆情/.test(text)) return "news";
  return "other";
}

async function hashStable(value: unknown) {
  return sha256(stableStringify(value));
}

function evidenceSortKey(item: EvidenceItem) {
  return [item.source || "", item.title || "", item.url || "", item.freshness || ""].join("\u0001");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeKey(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "unknown";
}
