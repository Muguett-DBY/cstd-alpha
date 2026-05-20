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
  contentTypes?: AnySearchContentType[];
  freshness?: AnySearchFreshness;
};

export type AnySearchEvidence = {
  source: "AnySearch";
  query: string;
  title: string;
  url: string;
  summary: string;
  content?: string;
  sourceType: SupplementalSourceType;
  signalType: "external_search";
  weight: number;
  topic?: string;
  publishedAt?: string;
  qualityScore?: number;
  score?: number;
  anysearchSource?: string;
  anysearchRequestId?: string;
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
    published_at?: string;
  }>;
  metadata?: {
    request_id?: string;
    cached?: boolean;
  };
};

const ANYSEARCH_URL = "https://api.anysearch.com/v1/search";
const MAX_SUMMARY_CHARS = 520;
const MAX_CONTENT_CHARS = 1200;

export function buildAnySearchRequestBody(query: AnySearchQuery) {
  return {
    query: query.query,
    max_results: query.maxResults ?? 5,
    domains: query.domains ?? ["finance", "business"],
    content_types: query.contentTypes ?? ["news", "web"],
    zone: "cn",
    language: "zh-CN",
    constraint: { freshness: query.freshness ?? "month" },
  };
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
      publishedAt: cleanText(raw.published_at) || undefined,
      qualityScore: numberValue(raw.quality_score),
      score: numberValue(raw.score),
      anysearchSource: cleanText(raw.source) || undefined,
      anysearchRequestId: cleanText(metadata.request_id) || undefined,
      cached: typeof metadata.cached === "boolean" ? metadata.cached : false,
    });
  }
  return items;
}

export function anySearchEvidenceToReportEvidence(items: AnySearchEvidence[], retrievedAt = new Date().toISOString()): EvidenceItem[] {
  return items.map((item) => ({
    title: `AnySearch 外部搜索：${item.title}`,
    source: "AnySearch 外部搜索",
    url: item.url,
    retrievedAt,
    freshness: item.publishedAt ? "latest-public" : "stale",
    notes: [
      item.topic ? `主题：${item.topic}` : "",
      item.summary,
      typeof item.qualityScore === "number" ? `quality_score=${item.qualityScore}` : "",
      item.anysearchRequestId ? `request_id=${item.anysearchRequestId}` : "",
      "仅作为外部搜索线索，不能替代财报、公告、价格或销量硬数据。",
    ]
      .filter(Boolean)
      .join("；"),
  }));
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

function cleanText(value: unknown) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function trimText(value: string, maxLength: number) {
  const text = cleanText(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
