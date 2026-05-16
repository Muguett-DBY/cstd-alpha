import { describe, expect, test } from "vitest";
import { buildCompanyNewsQuery, buildIndustryNewsQuery, classifyNewsSentiment, filterRecentNews, parseGoogleNewsRss, summarizeNewsSentiment } from "./news";

describe("news helpers", () => {
  test("parses Google News RSS items into compact news rows", () => {
    const xml = `
      <rss><channel>
        <item>
          <title><![CDATA[贵州茅台净利润增长超预期 - 财经网]]></title>
          <link>https://news.google.com/rss/articles/abc?oc=5</link>
          <source url="https://example.com">财经网</source>
          <pubDate>Fri, 15 May 2026 01:20:00 GMT</pubDate>
          <description><![CDATA[贵州茅台发布业绩公告。]]></description>
        </item>
      </channel></rss>`;

    const rows = parseGoogleNewsRss(xml);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "贵州茅台净利润增长超预期",
      source: "财经网",
      summary: "贵州茅台发布业绩公告。",
    });
    expect(rows[0].publishedAt).toBe("2026-05-15T01:20:00.000Z");
  });

  test("parses RSS items with a fallback source name", () => {
    const xml = `
      <rss><channel>
        <item>
          <title><![CDATA[贵州茅台关于回购股份实施进展]]></title>
          <link><![CDATA[https://example.com/news]]></link>
          <description><![CDATA[公司披露回购进展。]]></description>
        </item>
      </channel></rss>`;

    const rows = parseGoogleNewsRss(xml, 8, "百度新闻");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "贵州茅台关于回购股份实施进展",
      source: "百度新闻",
      url: "https://example.com/news",
    });
  });

  test("infers known source names from RSS item URLs when source is empty", () => {
    const xml = `
      <rss><channel>
        <item>
          <title><![CDATA[贵州茅台公告列表 _ 数据中心 _ 东方财富网]]></title>
          <link><![CDATA[https://data.eastmoney.com/notices/stock/600519.html]]></link>
          <description><![CDATA[回购进展情况。]]></description>
        </item>
      </channel></rss>`;

    const rows = parseGoogleNewsRss(xml, 8, "百度新闻");

    expect(rows[0]).toMatchObject({
      source: "东方财富",
      title: "贵州茅台公告列表 _ 数据中心 _ 东方财富网",
    });
  });

  test("classifies clearly positive, negative and neutral headlines", () => {
    expect(classifyNewsSentiment("公司业绩预增并宣布回购股份").sentiment).toBe("positive");
    expect(classifyNewsSentiment("公司遭监管处罚且利润大幅下滑").sentiment).toBe("negative");
    expect(classifyNewsSentiment("公司召开年度股东大会").sentiment).toBe("neutral");
    expect(classifyNewsSentiment("公司召开年度股东大会").sentimentLabel).toBe("中性");
  });

  test("does not overstate generic or risk-heavy real estate industry headlines", () => {
    expect(classifyNewsSentiment("【行业研究】2026年房地产开发经营行业分析").sentiment).toBe("neutral");
    expect(classifyNewsSentiment("【行业研究】2026年房地产开发经营行业分析|房地产市场_新浪财经", "增长大增提升回升复苏改善创新高新高").sentiment).toBe(
      "neutral",
    );
    expect(classifyNewsSentiment("机构评级|长江证券给予万科A“增持”评级 未给出目标价").sentiment).toBe("neutral");
    expect(classifyNewsSentiment("万科A(000002)公告列表 _ 数据中心 _ 东方财富网").sentiment).toBe("neutral");
    expect(classifyNewsSentiment("房地产政策改善但房企风险仍高，债务压力待化解").sentiment).toBe("negative");
    expect(classifyNewsSentiment("为何北京对房产崩盘数据讳莫如深？").sentiment).toBe("negative");
    expect(classifyNewsSentiment("1300亿消费电子龙头业绩爆雷，市值蒸发近200亿").sentiment).toBe("negative");
  });

  test("keeps recent news and summarizes positive/negative split", () => {
    const rows = [
      { title: "近期利好", publishedAt: "2026-05-01T00:00:00.000Z" },
      { title: "旧闻", publishedAt: "2025-12-01T00:00:00.000Z" },
      { title: "无日期" },
    ];

    expect(filterRecentNews(rows, 120, 8, new Date("2026-05-15T00:00:00.000Z")).map((item) => item.title)).toEqual(["近期利好", "无日期"]);

    const summary = summarizeNewsSentiment([
      { id: "1", title: "业绩增长", url: "#", source: "A", sentiment: "positive", sentimentLabel: "偏利好", sentimentReason: "增长", confidence: 0.7 },
      { id: "2", title: "处罚", url: "#", source: "B", sentiment: "negative", sentimentLabel: "偏利空", sentimentReason: "处罚", confidence: 0.7 },
      { id: "3", title: "会议", url: "#", source: "C", sentiment: "neutral", sentimentLabel: "中性", sentimentReason: "中性", confidence: 0.4 },
    ]);

    expect(summary).toMatchObject({ total: 3, positive: 1, negative: 1, neutral: 1, overallLabel: "样本偏少，整体中性", sourceCount: 3 });
    expect(summary.sources).toEqual(["A", "B", "C"]);
  });

  test("keeps small positive-only samples neutral at the summary level", () => {
    const summary = summarizeNewsSentiment([
      { id: "1", title: "政策改善", url: "#", source: "A", sentiment: "positive", sentimentLabel: "偏利好", sentimentReason: "改善", confidence: 0.6 },
      { id: "2", title: "成交新高", url: "#", source: "B", sentiment: "positive", sentimentLabel: "偏利好", sentimentReason: "新高", confidence: 0.6 },
      { id: "3", title: "行业回暖", url: "#", source: "C", sentiment: "positive", sentimentLabel: "偏利好", sentimentReason: "回暖", confidence: 0.6 },
    ]);

    expect(summary).toMatchObject({ positivePct: 100, overall: "neutral", overallLabel: "样本偏少，整体中性" });
  });

  test("falls back from placeholder industry labels to company-name inference", () => {
    const query = buildIndustryNewsQuery("所属行业", { name: "贵州茅台", listingPlace: "沪A" });
    expect(query).toContain("食品饮料 白酒");
    expect(query).toContain("近三年");
    expect(query).toContain("供需");
  });

  test("uses different windows for company events and industry cycle news", () => {
    expect(buildCompanyNewsQuery({ name: "万科A", code: "000002", listingPlace: "深A" })).toContain("近六个月");
    expect(buildCompanyNewsQuery({ name: "万科A", code: "000002", listingPlace: "深A" })).toContain("监管");
    expect(buildIndustryNewsQuery("房地产 / 房地产开发", { name: "万科A", listingPlace: "深A" })).toContain("房地产 房地产开发 行业 近三年");
  });

  test("keeps detailed industry terms ahead of broad parent industries", () => {
    const query = buildIndustryNewsQuery("电子 / 消费电子", { name: "小米集团-W", listingPlace: "港股" });
    expect(query).toContain("电子 消费电子 行业");
    expect(query).toContain("竞争格局");
  });
});
