import { describe, expect, test } from "vitest";
import { industryRelevanceTerms, unrelatedIndustryTerms } from "./company-news";

describe("company news relevance helpers", () => {
  test("uses Xiaomi business terms for consumer electronics industry news", () => {
    expect(industryRelevanceTerms("电子 消费电子 行业 近三年 周期 OR 景气度", "小米集团-W")).toEqual(
      expect.arrayContaining(["消费电子", "智能手机", "手机", "智能硬件", "IoT", "电动汽车"]),
    );
  });

  test("excludes unrelated farming and livestock industry terms for Xiaomi", () => {
    const excluded = unrelatedIndustryTerms("电子 消费电子 行业 近三年 周期 OR 景气度", "小米集团-W");
    expect(excluded).toEqual(expect.arrayContaining(["猪", "猪业", "生猪", "养殖", "畜牧"]));
    expect(excluded).not.toContain("消费电子");
  });

  test("uses real estate operating terms for Vanke industry news", () => {
    expect(industryRelevanceTerms("房地产 房地产开发 行业 近三年 周期 OR 景气度", "万科A")).toEqual(
      expect.arrayContaining(["房地产", "房地产开发", "房企", "楼市", "二手房", "新房"]),
    );
  });
});
