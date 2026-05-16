import type { CompanyCandidate } from "./report";

export type NewsSentiment = "positive" | "negative" | "neutral";

export type NewsItem = {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  summary?: string;
  sentiment: NewsSentiment;
  sentimentLabel: string;
  sentimentReason: string;
  confidence: number;
};

export type NewsSentimentSummary = {
  total: number;
  positive: number;
  negative: number;
  neutral: number;
  positivePct: number;
  negativePct: number;
  neutralPct: number;
  overall: NewsSentiment;
  overallLabel: string;
  sourceCount: number;
  sources: string[];
};

export type CompanyNewsBundle = {
  company: CompanyCandidate;
  companyNews: NewsItem[];
  industryNews: NewsItem[];
  companySummary: NewsSentimentSummary;
  industrySummary: NewsSentimentSummary;
  companyQuery: string;
  industryQuery: string;
  industryLabel: string;
  fetchedAt: string;
  companyNewsError?: string;
  industryNewsError?: string;
};

const STRONG_POSITIVE_PATTERNS = [
  /利好/,
  /预增|扭亏|超预期|beat/i,
  /增持|回购|分红|派息/,
  /中标|签约|获批|批准|合作|扩产|投产/,
  /上调|upgrade|outperform|buy/i,
];

const WEAK_POSITIVE_PATTERNS = [/增长|大增|大涨|涨停|提升|回升|复苏|改善|企稳|回暖|底部|重估|创新高|新高/];

const STRONG_NEGATIVE_PATTERNS = [
  /利空/,
  /风险|隐忧|泥潭|崩盘|唱衰|出险|暴雷|爆雷|蒸发|债务|违约|危机|清盘|退市/,
  /下滑|下降|减少|承压|恶化|放缓|亏损|暴跌|跌停|下行|低迷|收缩|减值/,
  /减持|处罚|罚款|调查|问询|诉讼|违规|警示|监管/,
  /召回|事故|裁员|停产|禁令|制裁/,
  /下调|downgrade|underperform|miss|probe|fraud|recall/i,
];

const WEAK_NEGATIVE_PATTERNS = [/库存|去化|担保|流动性|调整|分化|压力/];

const GENERIC_RESEARCH_PATTERNS = [/行业研究|行业分析|市场分析|行业报告|行业报道|市场规模|发展趋势|研究报告|公告列表|数据中心/];
const LOW_SIGNAL_RATING_PATTERNS = [/机构评级|给予.+评级|维持.+评级|增持.+评级|买入.+评级/];
const LOW_SIGNAL_RATING_QUALIFIERS = [/未给出目标价|暂无目标价|维持|首次覆盖|评级列表/];

export function classifyNewsSentiment(title: string, summary = ""): Pick<NewsItem, "sentiment" | "sentimentLabel" | "sentimentReason" | "confidence"> {
  const text = `${title} ${summary}`.trim();
  const strongPositive = STRONG_POSITIVE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const weakPositive = WEAK_POSITIVE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const strongNegative = STRONG_NEGATIVE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const weakNegative = WEAK_NEGATIVE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const positiveMatches = strongPositive * 2 + weakPositive;
  const negativeMatches = strongNegative * 2 + weakNegative;

  if (isLowSignalRatingText(text)) {
    return {
      sentiment: "neutral",
      sentimentLabel: "中性",
      sentimentReason: "评级标题缺少目标价或上调等强验证信息，按中性处理。",
      confidence: 0.45,
    };
  }

  if (positiveMatches > negativeMatches) {
    if (strongPositive === 0 && isGenericResearchText(text)) {
      return {
        sentiment: "neutral",
        sentimentLabel: "中性",
        sentimentReason: "研究类标题只有弱方向词，按中性处理，避免把行业概览误判为利好。",
        confidence: 0.45,
      };
    }
    return {
      sentiment: "positive",
      sentimentLabel: "偏利好",
      sentimentReason: matchedReason(text, [...STRONG_POSITIVE_PATTERNS, ...WEAK_POSITIVE_PATTERNS]) || "标题包含业绩、订单、回购、增持或评级改善等正面线索。",
      confidence: confidenceScore(positiveMatches, negativeMatches),
    };
  }
  if (negativeMatches > positiveMatches) {
    return {
      sentiment: "negative",
      sentimentLabel: "偏利空",
      sentimentReason: matchedReason(text, [...STRONG_NEGATIVE_PATTERNS, ...WEAK_NEGATIVE_PATTERNS]) || "标题包含下滑、处罚、调查、减持或经营承压等负面线索。",
      confidence: confidenceScore(negativeMatches, positiveMatches),
    };
  }
  return {
    sentiment: "neutral",
    sentimentLabel: "中性",
    sentimentReason: "标题没有明显方向性词，按中性新闻处理。",
    confidence: 0.45,
  };
}

export function parseGoogleNewsRss(xml: string, limit = 8, defaultSource = "Google News"): Array<Omit<NewsItem, "sentiment" | "sentimentLabel" | "sentimentReason" | "confidence">> {
  return xml
    .split(/<item>/i)
    .slice(1)
    .map((chunk) => chunk.split(/<\/item>/i)[0] || "")
    .map((item) => {
      const title = decodeXml(readTag(item, "title"));
      const rawUrl = decodeXml(readTag(item, "link"));
      const source = normalizeSourceName(decodeXml(readTag(item, "source")) || sourceFromTitle(title) || sourceFromUrl(rawUrl) || defaultSource);
      const publishedAt = normalizeRssDate(decodeXml(readTag(item, "pubDate")));
      const summary = stripHtml(decodeXml(readTag(item, "description")));
      return {
        id: stableNewsId(title, rawUrl),
        title: cleanNewsTitle(title, source),
        url: rawUrl,
        source,
        publishedAt,
        summary,
      };
    })
    .filter((item) => item.title && item.url)
    .slice(0, limit);
}

export function decorateNewsSentiment(items: Array<Omit<NewsItem, "sentiment" | "sentimentLabel" | "sentimentReason" | "confidence">>): NewsItem[] {
  return items.map((item) => ({ ...item, ...classifyNewsSentiment(item.title, item.summary) }));
}

export function filterRecentNews<T extends { publishedAt?: string }>(items: T[], days = 120, limit = 8, now = new Date()): T[] {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const recentDated = items.filter((item) => {
    if (!item.publishedAt) return false;
    const time = Date.parse(item.publishedAt);
    return Number.isFinite(time) && time >= cutoff;
  });
  const undated = items.filter((item) => !item.publishedAt);
  return [...recentDated, ...undated].slice(0, limit);
}

export function summarizeNewsSentiment(items: NewsItem[]): NewsSentimentSummary {
  const total = items.length;
  const positive = items.filter((item) => item.sentiment === "positive").length;
  const negative = items.filter((item) => item.sentiment === "negative").length;
  const neutral = Math.max(0, total - positive - negative);
  const positivePct = percent(positive, total);
  const negativePct = percent(negative, total);
  const neutralPct = Math.max(0, 100 - positivePct - negativePct);
  const rawOverall: NewsSentiment = positive > negative ? "positive" : negative > positive ? "negative" : "neutral";
  const overall: NewsSentiment = conservativeOverall(rawOverall, { total, positive, negative });
  const sources = summarizeSources(items);
  return {
    total,
    positive,
    negative,
    neutral,
    positivePct,
    negativePct,
    neutralPct,
    overall,
    overallLabel: overallLabel(overall, { total, positive, negative }),
    sourceCount: sources.length,
    sources,
  };
}

export function buildCompanyNewsQuery(company: Pick<CompanyCandidate, "name" | "code" | "listingPlace">) {
  const suffix = marketNewsSuffix(company.listingPlace);
  return `${company.name} ${company.code} ${suffix} 近六个月 业绩 OR 公告 OR 监管 OR 回购 OR 事故 OR 股价`;
}

export function buildIndustryNewsQuery(industryLabel: string, company: Pick<CompanyCandidate, "name" | "listingPlace">) {
  const normalized = industryLabel && !isPlaceholderIndustry(industryLabel) ? industryLabel : inferIndustryFromCompanyName(company.name);
  const scopes = industrySearchScopes(normalized);
  return `${scopes.join(" ")} 行业 近三年 周期 OR 景气度 OR 政策 OR 供需 OR 价格 OR 竞争格局`;
}

export function inferIndustryFromCompanyName(companyName: string) {
  if (/茅台|五粮液|泸州老窖|汾酒|洋河|古井贡|酒鬼酒|水井坊|舍得/.test(companyName)) return "食品饮料 白酒";
  if (/伊利|蒙牛|光明乳业/.test(companyName)) return "食品饮料 乳制品";
  if (/美的|格力|海尔/.test(companyName)) return "家用电器";
  if (/腾讯|网易|快手|百度|阿里/.test(companyName)) return "互联网";
  return "所属行业";
}

function marketNewsSuffix(listingPlace: string) {
  if (/美股|US|NYSE|NASDAQ/i.test(listingPlace)) return "美股";
  if (/港|HK/i.test(listingPlace)) return "港股";
  return "A股";
}

function isPlaceholderIndustry(value: string) {
  return /^(未分类|所属行业|行业|行业待验证|待验证)$/i.test(value.trim());
}

function industrySearchScopes(industryLabel: string) {
  return Array.from(
    new Set(
      industryLabel
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  );
}

function readTag(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() || "";
}

function stripHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function sourceFromTitle(title: string) {
  const hyphenParts = title.split(" - ");
  if (hyphenParts.length > 1) return hyphenParts.at(-1)?.trim() || "";
  const underscoreParts = title.split("_").map((part) => part.trim()).filter(Boolean);
  const tail = underscoreParts.length > 1 ? underscoreParts.at(-1) || "" : "";
  return /^[\u4e00-\u9fa5A-Za-z0-9 .·-]{2,24}$/.test(tail) ? tail.replace(/\.{2,}$/, "").trim() : "";
}

function normalizeSourceName(source: string) {
  return (
    {
      东方财富网: "东方财富",
      英为财: "英为财情",
      新浪网: "新浪财经",
      手机新浪网: "新浪财经",
      新浪财经客户端: "新浪财经",
      新浪财经网: "新浪财经",
      上海证券报中国证券网: "上海证券报",
      证券时报网: "证券时报",
      百度文库: "百度文库",
    }[source] || source
  );
}

function sourceFromUrl(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const knownSources: Record<string, string> = {
      "eastmoney.com": "东方财富",
      "emwap.eastmoney.com": "东方财富",
      "data.eastmoney.com": "东方财富",
      "finance.sina.com.cn": "新浪财经",
      "stock.finance.sina.com.cn": "新浪财经",
      "quote.cfi.cn": "中财网",
      "cn.investing.com": "英为财情",
      "xueqiu.com": "雪球",
      "10jqka.com.cn": "同花顺",
      "stock.10jqka.com.cn": "同花顺",
      "cnstock.com": "上海证券报",
      "stcn.com": "证券时报",
      "cls.cn": "财联社",
      "yicai.com": "第一财经",
      "caixin.com": "财新",
      "thepaper.cn": "澎湃新闻",
      "baijiahao.baidu.com": "百家号",
      "hkexnews.hk": "港交所披露易",
      "sec.gov": "SEC",
      "prnewswire.com": "美通社",
      "reuters.com": "路透",
      "bloomberg.com": "彭博",
      "wsj.com": "华尔街日报",
      "cnbc.com": "CNBC",
    };
    if (knownSources[host]) return knownSources[host];
    const suffix = Object.keys(knownSources).find((domain) => host.endsWith(`.${domain}`));
    if (suffix) return knownSources[suffix];
    return "";
  } catch {
    return "";
  }
}

function cleanNewsTitle(title: string, source: string) {
  return title
    .replace(new RegExp(`\\s+-\\s+${escapeRegExp(source)}$`), "")
    .replace(new RegExp(`_${escapeRegExp(source)}(?:\\.{2,})?$`), "")
    .trim();
}

function normalizeRssDate(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function stableNewsId(title: string, url: string) {
  return `${title}|${url}`.toLowerCase();
}

function matchedReason(text: string, patterns: RegExp[]) {
  const pattern = patterns.find((item) => item.test(text));
  if (!pattern) return "";
  return `命中方向性关键词：${pattern.source.replace(/\\|\/|i/g, "").slice(0, 24)}`;
}

function confidenceScore(primary: number, opposite: number) {
  return Math.min(0.9, Math.max(0.55, 0.55 + (primary - opposite) * 0.15));
}

function isGenericResearchText(text: string) {
  return GENERIC_RESEARCH_PATTERNS.some((pattern) => pattern.test(text));
}

function isLowSignalRatingText(text: string) {
  return LOW_SIGNAL_RATING_PATTERNS.some((pattern) => pattern.test(text)) && LOW_SIGNAL_RATING_QUALIFIERS.some((pattern) => pattern.test(text));
}

function conservativeOverall(rawOverall: NewsSentiment, counts: { total: number; positive: number; negative: number }): NewsSentiment {
  if (counts.total === 0) return "neutral";
  if (counts.total < 5) {
    if (counts.negative >= 2 && counts.negative > counts.positive) return "negative";
    return "neutral";
  }
  return rawOverall;
}

function overallLabel(overall: NewsSentiment, counts: { total: number; positive: number; negative: number }) {
  if (counts.total > 0 && counts.total < 5 && overall === "neutral") return "样本偏少，整体中性";
  return overall === "positive" ? "整体偏利好" : overall === "negative" ? "整体偏利空" : "整体中性";
}

function percent(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function summarizeSources(items: NewsItem[]) {
  return Array.from(new Set(items.map((item) => item.source).filter(Boolean))).slice(0, 6);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
