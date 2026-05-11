import { verifySessionCookie } from "../_shared/auth";
import { callDeepSeekReport } from "../_shared/deepseek";
import { fetchPublicCompanyEvidence } from "../_shared/providers";
import type { CompanyCandidate, ReportGenerationMetrics } from "../../src/shared/report";

type Env = {
  AUTH_SECRET: string;
  DEEPSEEK_API_KEY: string;
  REPORT_CACHE?: KVNamespace;
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
const SERVER_REPORT_CACHE_VERSION = "v1-cost-cache";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const body = (await request.json().catch(() => null)) as ReportRequest | null;
  const company = body?.company;
  const companyName = company?.name?.trim() || body?.companyName?.trim();
  if (!companyName) return json({ error: "请先搜索并选择一个候选公司。" }, 400);
  if (!env.DEEPSEEK_API_KEY) return json({ error: "DEEPSEEK_API_KEY is not configured." }, 500);
  const cacheMode = body?.forceRefresh || body?.cacheMode === "refresh" ? "refresh" : "prefer-cache";
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const cacheKey = await buildReportCacheKey({ company, companyName, ticker: body?.ticker, market: body?.market });

  return streamNdjson(async (emit) => {
    if (cacheMode === "prefer-cache") {
      const cached = await readReportCache(env, cacheKey);
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
    emit({ type: "progress", stage: "deepseek_scoring", label: "DeepSeek 评分生成", detail: "V4 Pro max thinking 正在生成 20 项评分、红线封顶和估值结构。", percent: 62 });

    const modelMetrics: { modelCalls?: number; tokenUsage?: ReportGenerationMetrics["tokenUsage"] } = { modelCalls: 0 };
    const report = await callDeepSeekReport({
      apiKey: env.DEEPSEEK_API_KEY,
      evidence,
      language: "zh-CN",
      onProgress: (progress) => emit({ type: "progress", ...progress }),
      metrics: modelMetrics,
    });

    emit({ type: "progress", stage: "validation", label: "结构校验", detail: "正在校验 20 项评分、红线封顶、模板章节和导出结构。", percent: 90 });
    emit({ type: "progress", stage: "done", label: "报告完成", detail: "深度报告已生成，可在网页查看或导出 DOCX。", percent: 100 });
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
  }, { startedAtMs, startedAt });
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
  report: unknown;
  evidence: unknown;
  metrics?: ReportGenerationMetrics;
  cachedAt: string;
  expiresAt: string;
};

function streamNdjson(task: (emit: StreamEmit) => Promise<void>, options: { startedAtMs: number; startedAt: string }) {
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit: StreamEmit = (event) => {
        const payload =
          event.type === "progress" || event.type === "heartbeat"
            ? {
                ...event,
                at: event.at ?? new Date().toISOString(),
                startedAt: event.startedAt ?? options.startedAt,
                elapsedMs: event.elapsedMs ?? Date.now() - options.startedAtMs,
              }
            : event;
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      keepalive = setInterval(() => {
        emit({ type: "heartbeat", stage: "working", label: "仍在生成", detail: "模型仍在分析，连接保持中。", percent: 75 });
      }, 10_000);

      task(emit)
        .catch((error) => {
          emit(errorEvent(error));
        })
        .finally(() => {
          if (keepalive) clearInterval(keepalive);
          controller.close();
        });
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
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

async function buildReportCacheKey(input: { company?: CompanyCandidate; companyName: string; ticker?: string; market?: string }) {
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

async function readReportCache(env: Env, cacheKey: string): Promise<ReportCachePayload | null> {
  const kvCached = await readKvReportCache(env, cacheKey);
  if (kvCached) return kvCached;
  return readEdgeReportCache(cacheKey);
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
    env.REPORT_CACHE?.put(cacheKey, text, { expirationTtl: SERVER_REPORT_CACHE_TTL_SECONDS }) ?? Promise.resolve(),
    writeEdgeReportCache(cacheKey, text),
  ]);
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

function normalizeCachedPayload(value: unknown): ReportCachePayload | null {
  if (!isRecord(value) || !value.report || !value.evidence) return null;
  const cachedAt = typeof value.cachedAt === "string" ? value.cachedAt : "";
  const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt : "";
  if (!cachedAt || !expiresAt || Date.parse(expiresAt) <= Date.now()) return null;
  return {
    version: typeof value.version === "string" ? value.version : undefined,
    report: value.report,
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
