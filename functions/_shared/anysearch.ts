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
  source: "AnySearch" | "SearXNG" | "Exa" | "Tavily" | "GDELT" | "ArXiv" | "SemanticScholar";
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
  exaRequestId?: string;
  exaSearchType?: string;
  exaCostDollars?: number;
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

type ExaSearchResponse = {
  requestId?: string;
  searchType?: string;
  results?: Array<{
    title?: string;
    url?: string;
    publishedDate?: string | null;
    highlights?: string[];
    highlightScores?: number[];
    summary?: string;
    text?: string;
  }>;
  costDollars?: {
    total?: number;
  };
};

type TavilySearchResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    raw_content?: string | null;
  }>;
  response_time?: number | string;
  usage?: {
    credits?: number;
  };
  request_id?: string;
};

type GdeltResponse = {
  articles?: Array<{
    title?: string;
    url?: string;
    seendate?: string;
    domain?: string;
    sourceCountry?: string;
    language?: string;
  }>;
};

type SemanticScholarResponse = {
  data?: Array<{
    title?: string;
    url?: string;
    abstract?: string;
    year?: number;
    venue?: string;
    publicationDate?: string;
    citationCount?: number;
  }>;
};

const ANYSEARCH_URL = "https://api.anysearch.com/v1/search";
export const EXA_SEARCH_URL = "https://api.exa.ai/search";
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const GDELT_SEARCH_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const ARXIV_SEARCH_URL = "https://export.arxiv.org/api/query";
const SEMANTIC_SCHOLAR_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
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

export function buildExaSearchRequestBody(query: AnySearchQuery) {
  return {
    query: query.query,
    type: "auto",
    numResults: Math.min(Math.max(query.maxResults ?? 10, 1), 10),
    contents: {
      highlights: true,
    },
    category: query.contentTypes?.includes("news") ? "news" : undefined,
  };
}

export function buildTavilySearchRequestBody(query: AnySearchQuery) {
  return {
    query: query.query,
    search_depth: "basic",
    topic: "finance",
    max_results: Math.min(Math.max(query.maxResults ?? 8, 1), 10),
    time_range: query.freshness ?? "month",
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_usage: true,
  };
}

export function buildGdeltSearchUrl(query: AnySearchQuery) {
  const url = new URL(GDELT_SEARCH_URL);
  url.searchParams.set("query", addEnglishSearchAliases(query.query));
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "hybridrel");
  url.searchParams.set("maxrecords", String(Math.min(Math.max(query.maxResults ?? 8, 1), 10)));
  url.searchParams.set("timespan", gdeltTimespan(query.freshness));
  return url.toString();
}

export function buildArxivSearchUrl(query: AnySearchQuery) {
  const url = new URL(ARXIV_SEARCH_URL);
  url.searchParams.set("search_query", buildArxivSearchQuery(query.query));
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(Math.min(Math.max(query.maxResults ?? 5, 1), 5)));
  url.searchParams.set("sortBy", "submittedDate");
  url.searchParams.set("sortOrder", "descending");
  return url.toString();
}

export function buildSemanticScholarSearchUrl(query: AnySearchQuery) {
  const url = new URL(SEMANTIC_SCHOLAR_SEARCH_URL);
  url.searchParams.set("query", query.query);
  url.searchParams.set("limit", String(Math.min(Math.max(query.maxResults ?? 5, 1), 5)));
  url.searchParams.set("fields", "title,url,abstract,year,venue,publicationDate,citationCount");
  return url.toString();
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

export async function fetchExaEvidence({
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
  const normalizedApiKey = apiKey?.trim();
  if (!normalizedApiKey) return [];
  const evidence: AnySearchEvidence[] = [];
  for (const query of queries) {
    try {
      const response = await fetchImpl(EXA_SEARCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": normalizedApiKey },
        signal,
        body: JSON.stringify(buildExaSearchRequestBody(query)),
      });
      if (!response.ok) {
        await response.text().catch(() => "");
        continue;
      }
      const payload = (await response.json().catch(() => null)) as ExaSearchResponse | null;
      evidence.push(...normalizeExaResults(payload, query));
    } catch {
      continue;
    }
  }
  return dedupeAnySearchEvidence(evidence);
}

export async function fetchTavilyEvidence({
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
  const normalizedApiKey = apiKey?.trim();
  if (!normalizedApiKey) return [];
  const evidence: AnySearchEvidence[] = [];
  for (const query of queries) {
    try {
      const response = await fetchImpl(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${normalizedApiKey}` },
        signal,
        body: JSON.stringify(buildTavilySearchRequestBody(query)),
      });
      if (!response.ok) {
        await response.text().catch(() => "");
        continue;
      }
      const payload = (await response.json().catch(() => null)) as TavilySearchResponse | null;
      evidence.push(...normalizeTavilyResults(payload, query));
    } catch {
      continue;
    }
  }
  return dedupeAnySearchEvidence(evidence);
}

export async function fetchGdeltEvidence({
  queries,
  fetchImpl = fetch,
  signal,
}: {
  queries: AnySearchQuery[];
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}) {
  const evidence: AnySearchEvidence[] = [];
  for (const query of queries) {
    try {
      const response = await fetchImpl(buildGdeltSearchUrl(query), {
        headers: { accept: "application/json", "user-agent": "CSTD Alpha/1.0" },
        signal,
      });
      if (!response.ok) {
        await response.text().catch(() => "");
        continue;
      }
      const payload = (await response.json().catch(() => null)) as GdeltResponse | null;
      evidence.push(...normalizeGdeltResults(payload, query));
    } catch {
      continue;
    }
  }
  return dedupeAnySearchEvidence(evidence);
}

export async function fetchArxivEvidence({
  queries,
  fetchImpl = fetch,
  signal,
}: {
  queries: AnySearchQuery[];
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}) {
  const evidence: AnySearchEvidence[] = [];
  for (const query of queries) {
    try {
      const response = await fetchImpl(buildArxivSearchUrl(query), {
        headers: { accept: "application/atom+xml, application/xml, text/xml", "user-agent": "CSTD Alpha/1.0" },
        signal,
      });
      if (!response.ok) continue;
      const payload = await response.text().catch(() => "");
      evidence.push(...normalizeArxivResults(payload, query));
    } catch {
      continue;
    }
  }
  return dedupeAnySearchEvidence(evidence);
}

export async function fetchSemanticScholarEvidence({
  queries,
  fetchImpl = fetch,
  signal,
}: {
  queries: AnySearchQuery[];
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}) {
  const evidence: AnySearchEvidence[] = [];
  for (const query of queries) {
    try {
      const response = await fetchImpl(buildSemanticScholarSearchUrl(query), {
        headers: { accept: "application/json", "user-agent": "CSTD Alpha/1.0" },
        signal,
      });
      if (!response.ok) continue;
      const payload = (await response.json().catch(() => null)) as SemanticScholarResponse | null;
      evidence.push(...normalizeSemanticScholarResults(payload, query));
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

export function normalizeExaResults(payload: unknown, context: AnySearchQuery): AnySearchEvidence[] {
  const record = isRecord(payload) ? payload : {};
  const requestId = cleanText(record.requestId);
  const searchType = cleanText(record.searchType);
  const costDollars = isRecord(record.costDollars) ? numberValue(record.costDollars.total) : undefined;
  const results = Array.isArray(record.results) ? record.results : [];
  const items: AnySearchEvidence[] = [];
  for (const raw of results) {
    if (!isRecord(raw)) continue;
    const title = cleanText(raw.title);
    const url = cleanText(raw.url);
    if (!title || !url) continue;
    const highlights = Array.isArray(raw.highlights) ? raw.highlights.map(cleanText).filter(Boolean) : [];
    const summary = cleanText(raw.summary) || highlights.join(" ");
    const sourceType = inferSupplementalSourceType(url);
    items.push({
      source: "Exa",
      query: context.query,
      title,
      url,
      summary: trimText(summary || cleanText(raw.text), MAX_SUMMARY_CHARS),
      content: trimText([summary, cleanText(raw.text)].filter(Boolean).join(" "), MAX_CONTENT_CHARS) || undefined,
      sourceType,
      signalType: "external_search",
      weight: sourceType === "official" ? 4 : 3,
      topic: context.topic,
      tags: context.tags,
      contentTypes: context.contentTypes,
      freshness: context.freshness,
      publishedAt: cleanText(raw.publishedDate) || undefined,
      qualityScore: averageNumberArray(raw.highlightScores),
      anysearchSource: "exa",
      exaRequestId: requestId || undefined,
      exaSearchType: searchType || undefined,
      exaCostDollars: costDollars,
      cached: false,
    });
  }
  return items;
}

export function normalizeTavilyResults(payload: unknown, context: AnySearchQuery): AnySearchEvidence[] {
  const record = isRecord(payload) ? payload : {};
  const requestId = cleanText(record.request_id);
  const usageCredits = isRecord(record.usage) ? numberValue(record.usage.credits) : undefined;
  const results = Array.isArray(record.results) ? record.results : [];
  const items: AnySearchEvidence[] = [];
  for (const raw of results) {
    if (!isRecord(raw)) continue;
    const title = cleanText(raw.title);
    const url = cleanText(raw.url);
    if (!title || !url) continue;
    const content = cleanText(raw.content);
    const rawContent = cleanText(raw.raw_content);
    const sourceType = inferSupplementalSourceType(url);
    const score = numberValue(raw.score);
    items.push({
      source: "Tavily",
      query: context.query,
      title,
      url,
      summary: trimText(content || rawContent, MAX_SUMMARY_CHARS),
      content: trimText([content, rawContent].filter(Boolean).join(" "), MAX_CONTENT_CHARS) || undefined,
      sourceType,
      signalType: "external_search",
      weight: sourceType === "official" ? 4 : 3,
      topic: context.topic,
      tags: context.tags,
      contentTypes: context.contentTypes,
      freshness: context.freshness,
      qualityScore: score,
      score: usageCredits,
      anysearchSource: "tavily",
      anysearchRequestId: requestId || undefined,
      contentType: context.contentTypes?.includes("news") ? "news" : "web",
      cached: false,
    });
  }
  return items;
}

export function normalizeGdeltResults(payload: unknown, context: AnySearchQuery): AnySearchEvidence[] {
  const record = isRecord(payload) ? payload : {};
  const articles = Array.isArray(record.articles) ? record.articles : [];
  const items: AnySearchEvidence[] = [];
  for (const raw of articles) {
    if (!isRecord(raw)) continue;
    const title = cleanText(raw.title);
    const url = cleanText(raw.url);
    if (!title || !url) continue;
    const domain = cleanText(raw.domain) || hostFromUrl(url);
    const country = cleanText(raw.sourceCountry);
    const language = cleanText(raw.language);
    const seenDate = cleanText(raw.seendate);
    items.push({
      source: "GDELT",
      query: context.query,
      title,
      url,
      summary: trimText([`Global news mention from ${domain || "unknown domain"}.`, country ? `Source country: ${country}.` : "", language ? `Language: ${language}.` : ""].filter(Boolean).join(" "), MAX_SUMMARY_CHARS),
      sourceType: "news",
      signalType: "external_search",
      weight: 1,
      topic: context.topic,
      tags: context.tags,
      contentTypes: context.contentTypes,
      freshness: context.freshness,
      publishedAt: normalizeGdeltDate(seenDate),
      anysearchSource: domain || undefined,
      contentType: "news",
      cached: false,
    });
  }
  return items;
}

export function normalizeArxivResults(payload: unknown, context: AnySearchQuery): AnySearchEvidence[] {
  const xml = typeof payload === "string" ? payload : "";
  const entries = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
  const items: AnySearchEvidence[] = [];
  for (const entry of entries) {
    const title = xmlText(entry, "title");
    const id = xmlText(entry, "id");
    const summary = xmlText(entry, "summary");
    const published = xmlText(entry, "published") || xmlText(entry, "updated");
    const link = xmlLinkHref(entry) || id;
    if (!title || !link) continue;
    items.push({
      source: "ArXiv",
      query: context.query,
      title,
      url: link,
      summary: trimText(summary, MAX_SUMMARY_CHARS),
      content: trimText(summary, MAX_CONTENT_CHARS) || undefined,
      sourceType: "news",
      signalType: "external_search",
      weight: 2,
      topic: context.topic,
      tags: context.tags,
      contentTypes: context.contentTypes,
      freshness: context.freshness,
      publishedAt: published || undefined,
      anysearchSource: "arxiv",
      contentType: "academic",
      cached: false,
    });
  }
  return items;
}

export function normalizeSemanticScholarResults(payload: unknown, context: AnySearchQuery): AnySearchEvidence[] {
  const record = isRecord(payload) ? payload : {};
  const results = Array.isArray(record.data) ? record.data : [];
  const items: AnySearchEvidence[] = [];
  for (const raw of results) {
    if (!isRecord(raw)) continue;
    const title = cleanText(raw.title);
    const url = cleanText(raw.url);
    if (!title || !url) continue;
    const abstract = cleanText(raw.abstract);
    const venue = cleanText(raw.venue);
    const year = numberValue(raw.year);
    const citationCount = numberValue(raw.citationCount);
    items.push({
      source: "SemanticScholar",
      query: context.query,
      title,
      url,
      summary: trimText([abstract, venue ? `Venue: ${venue}.` : "", year ? `Year: ${year}.` : "", typeof citationCount === "number" ? `Citations: ${citationCount}.` : ""].filter(Boolean).join(" "), MAX_SUMMARY_CHARS),
      content: trimText(abstract, MAX_CONTENT_CHARS) || undefined,
      sourceType: "news",
      signalType: "external_search",
      weight: 2,
      topic: context.topic,
      tags: context.tags,
      contentTypes: context.contentTypes,
      freshness: context.freshness,
      publishedAt: cleanText(raw.publicationDate) || (year ? `${year}-01-01` : undefined),
      anysearchSource: "semanticscholar",
      contentType: "academic",
      cached: false,
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
      item.source === "GDELT" ? "GDELT 为免费全球新闻补召回来源。" : "",
      item.source === "Tavily" ? "Tavily 为 AI 搜索补强来源，默认 basic 深度，不能替代官方硬数据。" : "",
      item.source === "ArXiv" || item.source === "SemanticScholar" ? "学术检索只证明技术/论文线索，不能证明公司财务或商业化领先。" : "",
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

function averageNumberArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  if (!numbers.length) return undefined;
  return numbers.reduce((sum, item) => sum + item, 0) / numbers.length;
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

function gdeltTimespan(freshness: AnySearchFreshness | undefined) {
  if (freshness === "day") return "1day";
  if (freshness === "week") return "1week";
  if (freshness === "year") return "3months";
  return "1month";
}

function buildArxivSearchQuery(query: string) {
  const tokens = cleanText(addEnglishSearchAliases(query))
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}_-]+/gu, ""))
    .filter(Boolean)
    .slice(0, 8);
  return tokens.length ? tokens.map((token) => `all:${token}`).join("+AND+") : "all:investment";
}

function addEnglishSearchAliases(value: string) {
  let query = cleanText(value);
  const aliases: Array<[RegExp, string]> = [
    [/宁德时代/g, "CATL Contemporary Amperex Technology overseas policy risk"],
    [/贵州茅台|茅台/g, "Kweichow Moutai baijiu wholesale price earnings"],
    [/优必选/g, "UBTECH humanoid robot Walker brain cerebellum control"],
    [/港股互联网/g, "Hong Kong internet stocks Tencent Alibaba Meituan buyback profit valuation"],
    [/人形机器人/g, "humanoid robot supply chain actuator reducer sensor"],
    [/光伏/g, "China solar photovoltaic polysilicon module inventory"],
    [/AI服务器|AI 服务器/g, "AI server optical module PCB liquid cooling HBM memory"],
    [/半导体/g, "semiconductor chip equipment materials HBM"],
    [/白酒/g, "Chinese baijiu wholesale price inventory demand"],
    [/银行股|银行/g, "bank stocks dividend net interest margin credit risk"],
  ];
  for (const [pattern, alias] of aliases) {
    if (pattern.test(query) && !query.toLowerCase().includes(alias.toLowerCase().split(/\s+/)[0])) query = `${query} ${alias}`;
  }
  return query;
}

function normalizeGdeltDate(value: string) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?Z?$/);
  if (!match) return value || undefined;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

function xmlText(entry: string, tag: string) {
  const match = entry.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return xmlUnescape(match?.[1] || "");
}

function xmlLinkHref(entry: string) {
  const alternate = entry.match(/<link\b(?=[^>]*rel=["']alternate["'])(?=[^>]*href=["']([^"']+)["'])[^>]*>/i);
  if (alternate?.[1]) return xmlUnescape(alternate[1]);
  const first = entry.match(/<link\b(?=[^>]*href=["']([^"']+)["'])[^>]*>/i);
  return first?.[1] ? xmlUnescape(first[1]) : "";
}

function xmlUnescape(value: string) {
  return cleanText(
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

function hostFromUrl(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function inferSupplementalSourceType(value: unknown): SupplementalSourceType {
  const source = cleanText(value).toLowerCase();
  return source === "doc" ||
    source === "data" ||
    source === "academic" ||
    /sec\.gov|hkexnews\.hk|sse\.com\.cn|szse\.cn|cninfo\.com\.cn|stats\.gov\.cn|pbc\.gov\.cn|ndrc\.gov\.cn/.test(source)
    ? "official"
    : "news";
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
