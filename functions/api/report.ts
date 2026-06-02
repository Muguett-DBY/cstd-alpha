import { verifySessionCookie } from "../_shared/auth";
import { callDeepSeekReport } from "../_shared/deepseek";
import { fetchPublicCompanyEvidence } from "../_shared/providers";
import type { CompanyCandidate, InvestmentReport, ReportGenerationMetrics } from "../../src/shared/report";
import { buildReportLibraryEntry, validateLibraryReport } from "../../src/shared/report-library";

type Env = {
  AUTH_SECRET: string;
  OPENCODE_ZEN_API_KEY?: string;
  OPENCODE_GO_API_KEY?: string;
  REPORT_CACHE?: KVNamespace;
  REPORT_LIBRARY_DB?: D1Database;
  REPORT_LIBRARY_BUCKET?: R2Bucket;
  TUSHARE_TOKEN?: string;
};

type ReportRequest = {
  company?: CompanyCandidate;
  companyName?: string;
  ticker?: string;
  market?: string;
  language?: "zh-CN" | "en";
  forceRefresh?: boolean;
  cacheMode?: "prefer-cache" | "refresh";
};

const SERVER_REPORT_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SERVER_REPORT_CACHE_VERSION = "v7-score-placeholder-cleanup";
const REPORT_GENERATION_LOCK_TTL_SECONDS = 30 * 60;
const REPORT_GENERATION_LOCK_WAIT_TIMEOUT_MS = 28 * 60 * 1000;
const REPORT_GENERATION_LOCK_POLL_MS = 5 * 1000;
const REPORT_GENERATION_LOCK_HEARTBEAT_MS = 2 * 60 * 1000;
const REPORT_GENERATION_LOCK_STALE_MS = 6 * 60 * 1000;
const REPORT_GENERATION_LOCK_MESSAGE = "同一家公司报告正在生成中，正在等待共享缓存写入，本次不会重复调用 DeepSeek。";

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const body = (await request.json().catch(() => null)) as ReportRequest | null;
  const company = body?.company;
  const companyName = company?.name?.trim() || body?.companyName?.trim();
  if (!companyName) return json({ error: "请先搜索并选择一个候选公司。" }, 400);
  const cacheMode = body?.forceRefresh || body?.cacheMode === "refresh" ? "refresh" : "prefer-cache";
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const cacheKeys = await buildReportCacheKeys({ company, companyName, ticker: body?.ticker, market: body?.market });
  const cacheKey = cacheKeys.primary;
  const priorCached = await readReportCache(env, cacheKeys);

  return streamNdjson(async (emit, signal) => {
    let lock: ReportGenerationLock | null = null;
    try {
    if (cacheMode === "prefer-cache") {
      const cached = priorCached;
      if (cached) {
        emit({
          type: "progress",
          stage: "server_cache_hit",
          label: "命中共享缓存",
          detail: "已复用 30 天内生成过的完整报告，本次不会调用 DeepSeek。",
          percent: 100,
          evidenceCount: cachedEvidenceCount(cached),
        });
        emit({
          type: "final",
          report: cached.report,
          evidence: cached.evidence,
          metrics: buildCacheHitMetrics(startedAtMs, startedAt, cached.metrics, cached.cachedAt),
        });
        return;
      }
    }

    lock = await acquireReportGenerationLock(env, cacheKey, companyName, startedAt);
    if (!lock.acquired) {
      if (cacheMode === "prefer-cache") {
        const cached = await readReportCache(env, cacheKeys);
        if (cached) {
          emit({
            type: "progress",
            stage: "server_cache_hit",
            label: "命中共享缓存",
            detail: "同公司生成任务已完成，已复用共享缓存，本次不会调用 DeepSeek。",
            percent: 100,
            evidenceCount: cachedEvidenceCount(cached),
          });
          emit({
            type: "final",
            report: cached.report,
            evidence: cached.evidence,
            metrics: buildCacheHitMetrics(startedAtMs, startedAt, cached.metrics, cached.cachedAt),
          });
          return;
        }
      }
      emit({
        type: "progress",
        stage: "generation_locked",
        label: "同公司报告正在生成",
        detail: REPORT_GENERATION_LOCK_MESSAGE,
        percent: 3,
      });
      const cached = await waitForLockedReportCache(env, cacheKeys, emit);
      if (cached) {
        emit({
          type: "progress",
          stage: "server_cache_hit",
          label: "命中共享缓存",
          detail: "已有生成任务完成，已自动复用共享缓存，本次不会调用 DeepSeek。",
          percent: 100,
          evidenceCount: cachedEvidenceCount(cached),
        });
        emit({
          type: "final",
          report: cached.report,
          evidence: cached.evidence,
          metrics: buildCacheHitMetrics(startedAtMs, startedAt, cached.metrics, cached.cachedAt),
        });
        return;
      }
      lock = await acquireReportGenerationLock(env, cacheKey, companyName, startedAt);
      if (!lock.acquired) {
        throw Object.assign(new Error("已有报告生成任务尚未完成，请稍后再点生成。"), {
          code: "REPORT_GENERATION_WAIT_TIMEOUT",
          retryable: true,
        });
      }
      emit({
        type: "progress",
        stage: "generation_lock_takeover",
        label: "接管生成任务",
        detail: "上一轮生成锁已无心跳，本次将重新读取公开数据并生成报告。",
        percent: 4,
      });
    }

    emit({
      type: "progress",
      stage: cacheMode === "refresh" ? "cache_refresh" : "cache_miss",
      label: cacheMode === "refresh" ? "刷新最新数据" : "未命中本地缓存",
      detail: cacheMode === "refresh" ? "正在绕过本地缓存，重新读取公开数据。" : "本次需要重新读取公开数据并调用模型。",
      percent: 3,
    });
    emit({ type: "progress", stage: "confirmed", label: "已确认公司", detail: company ? `${company.name} / ${company.code} / ${company.listingPlace}` : companyName, percent: 5 });
    emit({ type: "progress", stage: "market_data", label: "读取行情数据", detail: "正在读取公开行情、交易所与估值快照。", percent: 18 });
    emit({ type: "progress", stage: "financial_data", label: "读取财务数据", detail: "正在读取利润表、现金流量表、资产负债表与公开财务时间序列。", percent: 32 });

    const evidence = await fetchPublicCompanyEvidence({
      companyName,
      ticker: company?.code || body?.ticker?.trim() || undefined,
      market: company?.listingPlace || body?.market?.trim() || undefined,
      company,
      tushareToken: env.TUSHARE_TOKEN,
      signal,
    });

    if (hasSecEvidence(evidence.facts)) {
      emit({
        type: "progress",
        stage: "us_sec_fallback",
        label: "美股财报来源切换",
        detail: "Yahoo 或东方财富美股财务数据不可用时，已使用 SEC EDGAR/官方财报补充财务证据。",
        percent: 44,
        evidenceCount: evidence.evidence.length,
      });
    }

    emit({
      type: "progress",
      stage: "evidence_ready",
      label: "证据包完成",
      detail: `已整理 ${evidence.evidence.length} 条公开证据，开始深度评分。`,
      percent: 48,
      evidenceCount: evidence.evidence.length,
    });
    emit({ type: "progress", stage: "deepseek_scoring", label: "OpenCode Go 评分生成", detail: "DeepSeek Flash max reasoning 正在生成 20 项评分、红线封顶和估值结构。", percent: 62 });

    const modelMetrics: { modelCalls?: number; tokenUsage?: ReportGenerationMetrics["tokenUsage"] } = { modelCalls: 0 };
    const report = await callDeepSeekReport({
      opencodeZenApiKey: env.OPENCODE_ZEN_API_KEY,
      opencodeGoApiKey: env.OPENCODE_GO_API_KEY,
      evidence,
      language: "zh-CN",
      signal,
      onProgress: (progress) => emit({ type: "progress", ...progress }),
      metrics: modelMetrics,
      priorReport: priorCached?.report ?? null,
    });

    emit({ type: "progress", stage: "validation", label: "结构校验", detail: "正在校验 20 项评分、红线封顶和模板章节结构。", percent: 90 });
    emit({ type: "progress", stage: "done", label: "报告完成", detail: "深度报告已生成，可在网页查看完整报告。", percent: 100 });
    const metrics = buildMetrics(startedAtMs, startedAt, modelMetrics.modelCalls ?? 0, cacheMode, modelMetrics.tokenUsage);
    await writeReportCache(env, cacheKey, {
      version: SERVER_REPORT_CACHE_VERSION,
      report,
      evidence,
      metrics,
      cachedAt: metrics.completedAt,
      expiresAt: new Date(Date.now() + SERVER_REPORT_CACHE_TTL_SECONDS * 1000).toISOString(),
    });
    emit({
      type: "final",
      report,
      evidence,
      metrics,
    });
    } finally {
      await lock?.release();
    }
  }, { startedAtMs, startedAt, waitUntil });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

type ProgressEvent = {
  type: "progress";
  stage: string;
  label: string;
  detail: string;
  percent: number;
  at?: string;
  startedAt?: string;
  elapsedMs?: number;
  evidenceCount?: number;
};

type HeartbeatEvent = {
  type: "heartbeat";
  stage: string;
  label: string;
  detail: string;
  percent: number;
  at?: string;
  startedAt?: string;
  elapsedMs?: number;
};

type ErrorEvent = {
  type: "error";
  error: string;
  code?: string;
  retryable?: boolean;
};

type FinalEvent = { type: "final"; report: unknown; evidence: unknown; metrics: ReportGenerationMetrics };

type StreamEmit = (event: ProgressEvent | HeartbeatEvent | FinalEvent | ErrorEvent) => void;

type ReportCachePayload = {
  version?: string;
  report: InvestmentReport;
  evidence: unknown;
  metrics?: ReportGenerationMetrics;
  cachedAt: string;
  expiresAt: string;
};

type ReportCacheKeys = {
  primary: string;
  readKeys: string[];
  libraryIds: string[];
};

type ReportLibraryRow = {
  id: string;
  company_name: string;
  ticker: string | null;
  market: string | null;
  industry: string | null;
  sector: string | null;
  cqs: number;
  ias: number;
  conclusion: InvestmentReport["conclusion"];
  qualitative_band: string;
  position_advice: string;
  valuation_view: string;
  as_of: string;
  imported_at: string;
  evidence_count: number;
  score_item_count: number;
  object_key: string;
  report_hash: string;
};

type ReportLockPayload = {
  owner: string;
  companyName: string;
  startedAt: string;
  refreshedAt?: string;
  expiresAt: string;
};

type ReportGenerationLock = {
  acquired: boolean;
  release: () => Promise<void>;
};

function streamNdjson(
  task: (emit: StreamEmit, signal: AbortSignal) => Promise<void>,
  options: { startedAtMs: number; startedAt: string; waitUntil?: (promise: Promise<unknown>) => void },
) {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const buffered: Uint8Array[] = [];

  const emit: StreamEmit = (event) => {
    if (closed) return;
    const payload =
      event.type === "progress" || event.type === "heartbeat"
        ? {
            ...event,
            at: event.at ?? new Date().toISOString(),
            startedAt: event.startedAt ?? options.startedAt,
            elapsedMs: event.elapsedMs ?? Date.now() - options.startedAtMs,
          }
        : event;
    const chunk = encoder.encode(`${JSON.stringify(payload)}\n`);
    if (controller) {
      controller.enqueue(chunk);
    } else {
      buffered.push(chunk);
    }
  };

  const keepalive = setInterval(() => {
    emit({ type: "heartbeat", stage: "working", label: "仍在生成", detail: "模型仍在分析，连接保持中。", percent: 75 });
  }, 10_000);

  const taskPromise = task(emit, abortController.signal)
    .catch((error) => {
      if (!isAbortError(error)) emit(errorEvent(error));
    })
    .finally(() => {
      if (keepalive) clearInterval(keepalive);
      closed = true;
      try {
        controller?.close();
      } catch {
        // The client may have already canceled the stream.
      }
    });
  options.waitUntil?.(taskPromise);

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      for (const chunk of buffered.splice(0)) streamController.enqueue(chunk);
    },
    cancel() {
      closed = true;
      if (keepalive) clearInterval(keepalive);
      // Do not abort the expensive report task on passive stream cancellation.
      // Browsers and edge connections can drop long responses even while the user
      // still expects the shared cache to be written for reuse.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function isAbortError(error: unknown) {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

function buildMetrics(
  startedAtMs: number,
  startedAt: string,
  modelCalls: number,
  cacheMode: "prefer-cache" | "refresh",
  tokenUsage?: ReportGenerationMetrics["tokenUsage"],
): ReportGenerationMetrics {
  const completedAt = new Date();
  return {
    startedAt,
    completedAt: completedAt.toISOString(),
    elapsedMs: Math.max(0, completedAt.getTime() - startedAtMs),
    modelCalls,
    cacheMode,
    tokenUsage,
  };
}

function buildCacheHitMetrics(startedAtMs: number, startedAt: string, cachedMetrics: ReportGenerationMetrics | undefined, cachedAt: string): ReportGenerationMetrics {
  const completedAt = new Date();
  return {
    startedAt,
    completedAt: completedAt.toISOString(),
    elapsedMs: Math.max(0, completedAt.getTime() - startedAtMs),
    modelCalls: 0,
    cacheMode: "prefer-cache",
    cacheHit: true,
    cachedAt,
    sourceElapsedMs: cachedMetrics?.elapsedMs,
    tokenUsage: cachedMetrics?.tokenUsage,
  };
}

async function buildReportCacheKeys(input: { company?: CompanyCandidate; companyName: string; ticker?: string; market?: string }) {
  const primary = await buildCanonicalReportCacheKey(input);
  const legacy = await buildLegacyReportCacheKey(input);
  const libraryIds = await buildReportLibraryReadIds(input);
  return {
    primary,
    readKeys: Array.from(new Set([primary, legacy])),
    libraryIds,
  };
}

async function buildCanonicalReportCacheKey(input: { company?: CompanyCandidate; companyName: string; ticker?: string; market?: string }) {
  const company = input.company;
  const raw = JSON.stringify({
    version: SERVER_REPORT_CACHE_VERSION,
    identity: canonicalCompanyCacheIdentity({
      name: company?.name ?? input.companyName,
      code: company?.code ?? input.ticker,
      listingPlace: company?.listingPlace ?? input.market,
    }),
  });
  return `report:${SERVER_REPORT_CACHE_VERSION}:${await sha256(raw)}`;
}

async function buildLegacyReportCacheKey(input: { company?: CompanyCandidate; companyName: string; ticker?: string; market?: string }) {
  const company = input.company;
  const raw = JSON.stringify({
    version: SERVER_REPORT_CACHE_VERSION,
    id: company?.id,
    name: company?.name ?? input.companyName,
    code: company?.code ?? input.ticker,
    listingPlace: company?.listingPlace ?? input.market,
    marketType: company?.marketType,
    source: company?.source,
  });
  return `report:${SERVER_REPORT_CACHE_VERSION}:${await sha256(raw)}`;
}

function canonicalCompanyCacheIdentity(input: { name?: string; code?: string; listingPlace?: string }) {
  const market = normalizeCacheIdentityPart(input.listingPlace);
  const code = normalizeCacheIdentityPart(input.code);
  const name = normalizeCacheIdentityPart(input.name);
  return code ? `${market || "UNKNOWN"}:${code}` : `${market || "UNKNOWN"}:${name}`;
}

function normalizeCacheIdentityPart(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

async function buildReportLibraryReadIds(input: { company?: CompanyCandidate; companyName: string; ticker?: string; market?: string }) {
  const company = input.company;
  const identities = [
    ...reportLibraryIdentityCandidates(company?.listingPlace ?? input.market, company?.code ?? input.ticker, company?.name ?? input.companyName),
    ...reportLibraryIdentityCandidates(company?.marketType, company?.code ?? input.ticker, company?.name ?? input.companyName),
  ];
  return Promise.all(Array.from(new Set(identities)).map((identity) => sha256(identity)));
}

function reportLibraryIdentityFromParts(market: unknown, ticker: unknown, name: unknown) {
  const normalizedMarket = normalizeCacheIdentityPart(market);
  const normalizedTicker = normalizeCacheIdentityPart(ticker);
  const normalizedName = normalizeCacheIdentityPart(name);
  return normalizedTicker ? `${normalizedMarket}:${normalizedTicker}` : `${normalizedMarket}:${normalizedName}`;
}

function canonicalReportLibraryIdentityFromParts(market: unknown, ticker: unknown, name: unknown) {
  return reportLibraryIdentityFromParts(canonicalReportLibraryMarket(market, ticker), ticker, name);
}

function reportLibraryIdentityCandidates(market: unknown, ticker: unknown, name: unknown) {
  const normalizedMarket = normalizeCacheIdentityPart(market);
  const canonicalMarket = canonicalReportLibraryMarket(market, ticker);
  const markets = new Set([normalizedMarket, canonicalMarket, ...reportLibraryMarketAliases(normalizedMarket, ticker)].filter(Boolean));
  return Array.from(markets).map((candidateMarket) => reportLibraryIdentityFromParts(candidateMarket, ticker, name));
}

function canonicalReportLibraryMarket(market: unknown, ticker: unknown) {
  const normalizedMarket = normalizeCacheIdentityPart(market);
  const normalizedTicker = normalizeCacheIdentityPart(ticker);
  if (/^(HK|HKG|港股|香港)$/i.test(normalizedMarket) || /HONG\s*KONG/i.test(normalizedMarket)) return "HK";
  if (/^(US|USA|美股|NASDAQ|NYSE|AMEX)$/i.test(normalizedMarket) || /UNITED\s*STATES/i.test(normalizedMarket)) return "US";
  if (!/^\d{6}$/.test(normalizedTicker)) return normalizedMarket;

  const looksLikeAShare =
    !normalizedMarket ||
    /^(A|A股|ASTOCK|SH-A|SZ-A|沪A|深A|STAR MARKET|CHINEXT)$/i.test(normalizedMarket) ||
    /上海|深圳|证券交易所|科创|创业|沪|深/i.test(normalizedMarket);
  if (!looksLikeAShare) return normalizedMarket;
  if (/^(688|689)/.test(normalizedTicker)) return "STAR MARKET";
  if (/^(300|301)/.test(normalizedTicker)) return "CHINEXT";
  if (/^[69]/.test(normalizedTicker)) return "SH-A";
  if (/^[023]/.test(normalizedTicker)) return "SZ-A";
  return normalizedMarket || "A";
}

function reportLibraryMarketAliases(normalizedMarket: string, ticker: unknown) {
  const canonicalMarket = canonicalReportLibraryMarket(normalizedMarket, ticker);
  const aliases = new Set<string>([canonicalMarket]);
  if (canonicalMarket === "SH-A") {
    aliases.add("沪A");
    aliases.add("上海证券交易所");
    aliases.add("ASTOCK");
  } else if (canonicalMarket === "SZ-A") {
    aliases.add("深A");
    aliases.add("深圳证券交易所");
    aliases.add("ASTOCK");
  } else if (canonicalMarket === "STAR MARKET") {
    aliases.add("科创板");
    aliases.add("沪A");
    aliases.add("ASTOCK");
  } else if (canonicalMarket === "CHINEXT") {
    aliases.add("创业板");
    aliases.add("深A");
    aliases.add("ASTOCK");
  } else if (canonicalMarket === "HK") {
    aliases.add("港股");
    aliases.add("HONG KONG");
  } else if (canonicalMarket === "US") {
    aliases.add("美股");
    aliases.add("USA");
  }
  return Array.from(aliases);
}

async function readReportCache(env: Env, cacheKeys: ReportCacheKeys | string | string[]): Promise<ReportCachePayload | null> {
  const lookup = normalizeReportCacheLookup(cacheKeys);
  const libraryCached = await readReportLibraryCache(env, lookup.libraryIds);
  if (libraryCached) return libraryCached;

  for (const cacheKey of lookup.readKeys) {
    const kvCached = await readKvReportCache(env, cacheKey);
    if (kvCached) return kvCached;
    const edgeCached = await readEdgeReportCache(cacheKey);
    if (edgeCached) return edgeCached;
  }
  return null;
}

function normalizeReportCacheLookup(cacheKeys: ReportCacheKeys | string | string[]): Pick<ReportCacheKeys, "readKeys" | "libraryIds"> {
  if (typeof cacheKeys === "string") return { readKeys: [cacheKeys], libraryIds: [] };
  if (Array.isArray(cacheKeys)) return { readKeys: cacheKeys, libraryIds: [] };
  return { readKeys: cacheKeys.readKeys, libraryIds: cacheKeys.libraryIds };
}

async function readReportLibraryCache(env: Env, ids: string[]): Promise<ReportCachePayload | null> {
  if (!hasDurableReportLibrary(env)) return null;
  for (const id of ids) {
    const row = await readReportLibraryIndexRow(env.REPORT_LIBRARY_DB, id);
    if (!row?.object_key) continue;
    const object = await env.REPORT_LIBRARY_BUCKET.get(row.object_key);
    if (!object) continue;
    const payload = await object.json().catch(() => null);
    if (!payload) continue;
    let report: InvestmentReport;
    try {
      report = validateLibraryReport(payload);
    } catch {
      continue;
    }
    return {
      version: SERVER_REPORT_CACHE_VERSION,
      report,
      evidence: evidenceBundleFromReport(report),
      cachedAt: row.imported_at,
      expiresAt: "2099-12-31T23:59:59.000Z",
    };
  }
  return null;
}

async function readKvReportCache(env: Env, cacheKey: string): Promise<ReportCachePayload | null> {
  try {
    const value = await env.REPORT_CACHE?.get<ReportCachePayload>(cacheKey, "json");
    return normalizeCachedPayload(value);
  } catch {
    return null;
  }
}

async function readEdgeReportCache(cacheKey: string): Promise<ReportCachePayload | null> {
  if (typeof caches === "undefined") return null;
  try {
    const response = await caches.default.match(cacheRequest(cacheKey));
    if (!response?.ok) return null;
    return normalizeCachedPayload(await response.json());
  } catch {
    return null;
  }
}

async function writeReportCache(env: Env, cacheKey: string, payload: ReportCachePayload) {
  const text = JSON.stringify(payload);
  await Promise.allSettled([
    writeReportLibraryCache(env, payload.report, payload.cachedAt),
    writeKvReportCache(env, cacheKey, text),
    writeEdgeReportCache(cacheKey, text),
  ]);
}

async function writeKvReportCache(env: Env, cacheKey: string, text: string) {
  await env.REPORT_CACHE?.put(cacheKey, text, { expirationTtl: SERVER_REPORT_CACHE_TTL_SECONDS });
}

async function writeReportLibraryCache(env: Env, report: InvestmentReport, importedAt: string) {
  if (!hasDurableReportLibrary(env)) return;
  const durableReport = validateLibraryReport(report);
  const id = await sha256(canonicalReportLibraryIdentityFromParts(durableReport.company.market, durableReport.company.ticker, durableReport.company.name));
  const reportJson = JSON.stringify(durableReport);
  const reportHash = await sha256(reportJson);
  const existing = await readReportLibraryIndexRow(env.REPORT_LIBRARY_DB, id);
  if (existing?.report_hash === reportHash) return;

  const entry = buildReportLibraryEntry(durableReport, id, importedAt);
  const objectKey = `report-library/v1/reports/${id}.json`;
  await env.REPORT_LIBRARY_BUCKET.put(objectKey, reportJson, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { reportHash },
  });
  await env.REPORT_LIBRARY_DB.prepare(
    `INSERT INTO report_library (
      id, company_name, ticker, market, industry, sector, cqs, ias, conclusion,
      qualitative_band, position_advice, valuation_view, as_of, imported_at,
      evidence_count, score_item_count, object_key, report_hash
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
    ON CONFLICT(id) DO UPDATE SET
      company_name = excluded.company_name,
      ticker = excluded.ticker,
      market = excluded.market,
      industry = excluded.industry,
      sector = excluded.sector,
      cqs = excluded.cqs,
      ias = excluded.ias,
      conclusion = excluded.conclusion,
      qualitative_band = excluded.qualitative_band,
      position_advice = excluded.position_advice,
      valuation_view = excluded.valuation_view,
      as_of = excluded.as_of,
      imported_at = excluded.imported_at,
      evidence_count = excluded.evidence_count,
      score_item_count = excluded.score_item_count,
      object_key = excluded.object_key,
      report_hash = excluded.report_hash`,
  )
    .bind(
      entry.id,
      entry.companyName,
      entry.ticker ?? null,
      entry.market ?? null,
      entry.industry ?? null,
      entry.sector ?? null,
      entry.cqs,
      entry.ias,
      entry.conclusion,
      entry.qualitativeBand,
      entry.positionAdvice,
      entry.valuationView,
      entry.asOf,
      entry.importedAt,
      entry.evidenceCount,
      entry.scoreItemCount,
      objectKey,
      reportHash,
    )
    .run();
}

async function readReportLibraryIndexRow(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT
        id, company_name, ticker, market, industry, sector, cqs, ias, conclusion,
        qualitative_band, position_advice, valuation_view, as_of, imported_at,
        evidence_count, score_item_count, object_key, report_hash
      FROM report_library
      WHERE id = ?1`,
    )
    .bind(id)
    .first<ReportLibraryRow>();
}

function evidenceBundleFromReport(report: InvestmentReport) {
  return {
    company: report.company,
    retrievedAt: report.asOf,
    evidence: report.evidence,
    facts: {},
  };
}

function hasDurableReportLibrary(env: Env): env is Env & { REPORT_LIBRARY_DB: D1Database; REPORT_LIBRARY_BUCKET: R2Bucket } {
  return Boolean(env.REPORT_LIBRARY_DB && env.REPORT_LIBRARY_BUCKET);
}

async function writeEdgeReportCache(cacheKey: string, text: string) {
  if (typeof caches === "undefined") return;
  await caches.default.put(
    cacheRequest(cacheKey),
    new Response(text, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${SERVER_REPORT_CACHE_TTL_SECONDS}`,
      },
    }),
  );
}

async function waitForLockedReportCache(env: Env, cacheKeys: ReportCacheKeys, emit: StreamEmit) {
  const deadline = Date.now() + REPORT_GENERATION_LOCK_WAIT_TIMEOUT_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    const cached = await readReportCache(env, cacheKeys);
    if (cached) return cached;

    const cacheKey = cacheKeys.primary;
    const lock = env.REPORT_CACHE ? await readReportLock(env.REPORT_CACHE, reportLockKey(cacheKey)) : null;
    if (!lock || !isActiveReportLock(lock)) return null;

    attempts += 1;
    emit({
      type: "progress",
      stage: "generation_locked_wait",
      label: "等待共享缓存",
      detail: "已有用户正在生成同一家公司报告，系统会在完成后自动复用结果。",
      percent: Math.min(95, 5 + attempts),
    });
    await delay(REPORT_GENERATION_LOCK_POLL_MS);
  }
  return null;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function acquireReportGenerationLock(env: Env, cacheKey: string, companyName: string, startedAt: string): Promise<ReportGenerationLock> {
  const cache = env.REPORT_CACHE;
  if (!cache) return { acquired: true, release: async () => undefined };

  try {
    const lockKey = reportLockKey(cacheKey);
    const existing = await readReportLock(cache, lockKey);
    if (existing && isActiveReportLock(existing)) {
      return { acquired: false, release: async () => undefined };
    }

    const owner = buildLockOwner();
    const payload: ReportLockPayload = {
      owner,
      companyName,
      startedAt,
      refreshedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + REPORT_GENERATION_LOCK_TTL_SECONDS * 1000).toISOString(),
    };
    await cache.put(lockKey, JSON.stringify(payload), { expirationTtl: REPORT_GENERATION_LOCK_TTL_SECONDS });
    const confirmed = await readReportLock(cache, lockKey);
    if (confirmed && confirmed.owner !== owner && isActiveReportLock(confirmed)) {
      return { acquired: false, release: async () => undefined };
    }

    const stopHeartbeat = startReportLockHeartbeat(cache, lockKey, payload);
    return {
      acquired: true,
      release: async () => {
        stopHeartbeat();
        await releaseReportGenerationLock(cache, lockKey, owner);
      },
    };
  } catch (error) {
    throw new Error("共享生成锁暂时不可用，请稍后重试。", { cause: error });
  }
}

async function readReportLock(cache: KVNamespace, lockKey: string): Promise<ReportLockPayload | null> {
  try {
    const value = await cache.get<ReportLockPayload>(lockKey, "json");
    if (!isRecord(value)) return null;
    const owner = typeof value.owner === "string" ? value.owner : "";
    const companyName = typeof value.companyName === "string" ? value.companyName : "";
    const startedAt = typeof value.startedAt === "string" ? value.startedAt : "";
    const refreshedAt = typeof value.refreshedAt === "string" ? value.refreshedAt : undefined;
    const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt : "";
    if (!owner || !companyName || !startedAt || !expiresAt) return null;
    return { owner, companyName, startedAt, refreshedAt, expiresAt };
  } catch {
    return null;
  }
}

function isActiveReportLock(lock: ReportLockPayload) {
  if (Date.parse(lock.expiresAt) <= Date.now()) return false;
  if (!lock.refreshedAt) return false;
  return Date.parse(lock.refreshedAt) + REPORT_GENERATION_LOCK_STALE_MS > Date.now();
}

function startReportLockHeartbeat(cache: KVNamespace, lockKey: string, initial: ReportLockPayload) {
  const refresh = async () => {
    const current = await readReportLock(cache, lockKey);
    if (current?.owner !== initial.owner) return;
    const payload: ReportLockPayload = {
      ...initial,
      refreshedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + REPORT_GENERATION_LOCK_TTL_SECONDS * 1000).toISOString(),
    };
    await cache.put(lockKey, JSON.stringify(payload), { expirationTtl: REPORT_GENERATION_LOCK_TTL_SECONDS });
  };
  const id = setInterval(() => {
    void refresh().catch(() => undefined);
  }, REPORT_GENERATION_LOCK_HEARTBEAT_MS);
  return () => clearInterval(id);
}

async function releaseReportGenerationLock(cache: KVNamespace, lockKey: string, owner: string) {
  try {
    const current = await readReportLock(cache, lockKey);
    if (current?.owner === owner) {
      await cache.delete(lockKey);
    }
  } catch {
    // Lock release is best-effort; the TTL prevents a stale lock from persisting.
  }
}

function reportLockKey(cacheKey: string) {
  return cacheKey.replace(/^report:/, "report-lock:");
}

function buildLockOwner() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeCachedPayload(value: unknown): ReportCachePayload | null {
  if (!isRecord(value) || !value.report || !value.evidence) return null;
  const cachedAt = typeof value.cachedAt === "string" ? value.cachedAt : "";
  const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt : "";
  if (!cachedAt || !expiresAt || Date.parse(expiresAt) <= Date.now()) return null;
  return {
    version: typeof value.version === "string" ? value.version : undefined,
    report: value.report as InvestmentReport,
    evidence: value.evidence,
    metrics: isRecord(value.metrics) ? (value.metrics as ReportGenerationMetrics) : undefined,
    cachedAt,
    expiresAt,
  };
}

function cachedEvidenceCount(cached: ReportCachePayload) {
  const evidence = isRecord(cached.evidence) ? cached.evidence.evidence : undefined;
  return Array.isArray(evidence) ? evidence.length : 0;
}

function cacheRequest(cacheKey: string) {
  return new Request(`https://cstd-alpha.local/__report-cache/${encodeURIComponent(cacheKey)}`, { method: "GET" });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorEvent(error: unknown): ErrorEvent {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  return {
    type: "error",
    error: error instanceof Error ? error.message : "报告生成失败。",
    code: typeof record.code === "string" ? record.code : undefined,
    retryable: typeof record.retryable === "boolean" ? record.retryable : undefined,
  };
}

function hasSecEvidence(facts: Record<string, unknown>) {
  const sec = facts.sec;
  return typeof sec === "object" && sec !== null;
}
