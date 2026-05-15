import { describe, expect, test } from "vitest";
import { buildIndustryNewsQuery, classifyNewsSentiment, parseGoogleNewsRss } from "./news";

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

  test("classifies clearly positive, negative and neutral headlines", () => {
    expect(classifyNewsSentiment("公司业绩预增并宣布回购股份").sentiment).toBe("positive");
    expect(classifyNewsSentiment("公司遭监管处罚且利润大幅下滑").sentiment).toBe("negative");
    expect(classifyNewsSentiment("公司召开年度股东大会").sentiment).toBe("neutral");
  });

  test("falls back from placeholder industry labels to company-name inference", () => {
    expect(buildIndustryNewsQuery("所属行业", { name: "贵州茅台", listingPlace: "沪A" })).toContain("食品饮料 白酒");
  });
});
