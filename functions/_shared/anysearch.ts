import type { EvidenceItem } from "../../src/shared/report";

export type AnySearchFreshness = "day" | "week" | "month" | "year";
export type AnySearchDomain =
  | "general"
  | "code"
  | "tech"
  | "fashion"
  | "travel"
  | "home"
  | "ecommerce"
  | "gaming"
  | "film"
  | "music"
  | "finance"
  | "academic"
  | "legal"
  | "business"
  | "ip"
  | "security"
  | "education"
  | "health"
  | "religion"
  | "geo"
  | "environment"
  | "energy";
export type AnySearchContentType = "web" | "news" | "code" | "doc" | "academic" | "data" | "image" | "video" | "audio";
export type SupplementalSourceType = "news" | "official";

export type AnySearchQuery = {
  query: string;
  topic?: string;
  sourceType?: SupplementalSourceType;
  maxResults?: number;
  domains?: AnySearchDomain[];
  tags?: string[];
  contentTypes?: AnySearchContentType[];
  freshness?: AnySearchFreshness;
};

export type AnySearchEvidence = {
  source: "AnySearch" | "SearXNG";
  query: string;
  title: string;
  url: string;
  summary: string;
  content?: string;
  sourceType: SupplementalSourceType;
  signalType: "external_search";
  weight: number;
  topic?: string;
  tags?: string[];
  contentTypes?: AnySearchContentType[];
  freshness?: AnySearchFreshness;
  publishedAt?: string;
  qualityScore?: number;
  score?: number;
  anysearchSource?: string;
  anysearchRequestId?: string;
  signalScores?: Record<string, number>;
  contentType?: string;
  cached?: boolean;
};

type FetchLike = typeof fetch;

type AnySearchResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    description?: string;
    content?: string;
    source?: string;
    score?: number;
    quality_score?: number;
    signal_scores?: Record<string, number>;
    published_at?: string;
  }>;
  metadata?: {
    request_id?: string;
    cached?: boolean;
  };
};

type SearxngResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    snippet?: string;
    engine?: string;
    score?: number;
    publishedDate?: string;
    published_date?: string;
  }>;
};

const ANYSEARCH_URL = "https://api.anysearch.com/v1/search";
const MAX_SUMMARY_CHARS = 520;
const MAX_CONTENT_CHARS = 1200;

export function buildAnySearchRequestBody(query: AnySearchQuery) {
  const body: Record<string, unknown> = {
    query: query.query,
    max_results: query.maxResults ?? 5,
    domains: query.domains ?? ["finance", "business"],
    content_types: query.contentTypes ?? ["news", "web"],
    zone: "cn",
    language: "zh-CN",
    constraint: { freshness: query.freshness ?? "month" },
  };
  if (query.tags?.length) body.tags = query.tags;
  return body;
}

export async function fetchAnySearchEvidence({
  queries,
  apiKey,
  fetchImpl = fetch,
  signal,
}: {
  queries: AnySearchQuery[];
  apiKey?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}) {
  const evidence: AnySearchEvidence[] = [];
  for (const query of queries) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const normalizedApiKey = apiKey?.trim().replace(/\\_/g, "_");
    if (normalizedApiKey) headers.authorization = `Bearer ${normalizedApiKey}`;
    try {
      const response = await fetchImpl(ANYSEARCH_URL, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify(buildAnySearchRequestBody(query)),
      });
      if (!response.ok) {
        await response.text().catch(() => "");
        continue;
      }
      const payload = (await response.json().catch(() => null)) as AnySearchResponse | null;
      evidence.push(...normalizeAnySearchResults(payload, query));
    } catch {
      continue;
    }
  }
  return dedupeAnySearchEvidence(evidence);
}

export async function fetchSearxngEvidence({
  queries,
  endpoints,
  fetchImpl = fetch,
  signal,
}: {
  queries: AnySearchQuery[];
  endpoints?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}) {
  const normalizedEndpoints = normalizeSearxngEndpoints(endpoints);
  if (!normalizedEndpoints.length) return [];
  const evidence: AnySearchEvidence[] = [];
  for (const query of queries) {
    for (const endpoint of normalizedEndpoints) {
      try {
        const response = await fetchImpl(buildSearxngSearchUrl(endpoint, query.query), {
          headers: { accept: "application/json", "user-agent": "CSTD Alpha/1.0" },
          signal,
        });
        if (!response.ok) continue;
        const payload = (await response.json().catch(() => null)) as SearxngResponse | null;
        const items = normalizeSearxngResults(payload, query);
        if (items.length) {
          evidence.push(...items);
          break;
        }
      } catch {
        continue;
      }
    }
  }
  return dedupeAnySearchEvidence(evidence);
}

export function normalizeAnySearchResults(payload: unknown, context: AnySearchQuery): AnySearchEvidence[] {
  const envelope = isRecord(payload) ? payload : {};
  const record = isRecord(envelope.data) ? envelope.data : envelope;
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const results = Array.isArray(record.results) ? record.results : [];
  const items: AnySearchEvidence[] = [];
  for (const raw of results) {
    if (!isRecord(raw)) continue;
    const title = cleanText(raw.title);
    const url = cleanText(raw.url);
    if (!title || !url) continue;
    const description = cleanText(raw.description);
    const content = cleanText(raw.content);
    const sourceType = context.sourceType ?? inferSupplementalSourceType(raw.source);
    items.push({
      source: "AnySearch",
      query: context.query,
      title,
      url,
      summary: trimText([description, content].filter(Boolean).join(" "), MAX_SUMMARY_CHARS),
      content: trimText(content, MAX_CONTENT_CHARS) || undefined,
      sourceType,
      signalType: "external_search",
      weight: sourceType === "official" ? 4 : 2,
      topic: context.topic,
      tags: context.tags,
      contentTypes: context.contentTypes,
      freshness: context.freshness,
      publishedAt: cleanText(raw.published_at) || undefined,
      qualityScore: numberValue(raw.quality_score),
      score: numberValue(raw.score),
      anysearchSource: cleanText(raw.source) || undefined,
      anysearchRequestId: cleanText(metadata.request_id) || undefined,
      signalScores: signalScoresValue(raw.signal_scores),
      contentType: cleanText(raw.source) || undefined,
      cached: typeof metadata.cached === "boolean" ? metadata.cached : false,
    });
  }
  return items;
}

export function anySearchEvidenceToReportEvidence(items: AnySearchEvidence[], retrievedAt = new Date().toISOString()): EvidenceItem[] {
  return items.map((item) => ({
    title: `${item.source} 外部搜索：${item.title}`,
    source: `${item.source} 外部搜索`,
    url: item.url,
    retrievedAt,
    freshness: item.publishedAt ? "latest-public" : "stale",
    notes: [
      item.topic ? `主题：${item.topic}` : "",
      item.tags?.length ? `检索标签：${item.tags.join(",")}` : "",
      item.contentTypes?.length ? `内容类型：${item.contentTypes.join(",")}` : "",
      item.freshness ? `时间窗口：${item.freshness}` : "",
      item.summary,
      typeof item.qualityScore === "number" ? `quality_score=${item.qualityScore}` : "",
      item.anysearchRequestId ? `request_id=${item.anysearchRequestId}` : "",
      item.source === "SearXNG" ? "SearXNG 为低权重补召回来源。" : "",
      "仅作为外部搜索线索，不能替代财报、公告、价格或销量硬数据。",
    ]
      .filter(Boolean)
      .join("；"),
  }));
}

function normalizeSearxngResults(payload: unknown, context: AnySearchQuery): AnySearchEvidence[] {
  const record = isRecord(payload) ? payload : {};
  const results = Array.isArray(record.results) ? record.results : [];
  const items: AnySearchEvidence[] = [];
  for (const raw of results) {
    if (!isRecord(raw)) continue;
    const title = cleanText(raw.title);
    const url = cleanText(raw.url);
    if (!title || !url) continue;
    const content = cleanText(raw.content) || cleanText(raw.snippet);
    const sourceType = inferSearxngSourceType(url, context.sourceType);
    items.push({
      source: "SearXNG",
      query: context.query,
      title,
      url,
      summary: trimText(content, MAX_SUMMARY_CHARS),
      content: trimText(content, MAX_CONTENT_CHARS) || undefined,
      sourceType,
      signalType: "external_search",
      weight: sourceType === "official" ? 3 : 1,
      topic: context.topic,
      tags: context.tags,
      contentTypes: context.contentTypes,
      freshness: context.freshness,
      publishedAt: cleanText(raw.publishedDate) || cleanText(raw.published_date) || undefined,
      score: numberValue(raw.score),
      anysearchSource: cleanText(raw.engine) || undefined,
      contentType: "web",
      cached: false,
    });
  }
  return items;
}

function normalizeSearxngEndpoints(value: string | undefined) {
  return (value || "")
    .split(/[\n,]/)
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter((item) => /^https?:\/\//i.test(item));
}

function buildSearxngSearchUrl(endpoint: string, query: string) {
  const url = new URL(`${endpoint}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "zh-CN");
  url.searchParams.set("categories", "general,news");
  return url.toString();
}

function inferSearxngSourceType(url: string, fallback: SupplementalSourceType | undefined): SupplementalSourceType {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  if (/(^|\.)sec\.gov$|(^|\.)sse\.com\.cn$|(^|\.)szse\.cn$|(^|\.)hkexnews\.hk$|(^|\.)gov\.cn$|(^|\.)eastmoney\.com$/.test(host)) return "official";
  return fallback ?? "news";
}

function dedupeAnySearchEvidence(items: AnySearchEvidence[]) {
  const seen = new Set<string>();
  const result: AnySearchEvidence[] = [];
  for (const item of items) {
    const key = item.url || `${item.query}|${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function inferSupplementalSourceType(value: unknown): SupplementalSourceType {
  const source = cleanText(value).toLowerCase();
  return source === "doc" || source === "data" || source === "academic" ? "official" : "news";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function signalScoresValue(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, item]) => (typeof item === "number" && Number.isFinite(item) ? [[key, item] as const] : []));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function cleanText(value: unknown) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function trimText(value: string, maxLength: number) {
  const text = cleanText(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
