import { describe, expect, test } from "vitest";
import { formatCollectedEvidenceForAgent, internalToolLabel, naturalToolStatusLabel } from "./assistant-tools";

describe("assistant tool labels", () => {
  test("uses neutral market-data wording for the generic quote tool", () => {
    expect(internalToolLabel("read_tencent_quote")).toBe("实时行情");
    expect(naturalToolStatusLabel({ id: "quote-1", name: "read_tencent_quote", query: "300750", reason: "查宁德时代行情" })).toBe("正在读取实时行情...");
  });

  test("places structured internal evidence before search leads in the model evidence window", () => {
    const searchLeads = Array.from({ length: 20 }, (_, index) => ({
      source: "Tavily" as const,
      query: "AI 算力",
      title: `搜索线索 ${index + 1}`,
      summary: "行业搜索摘要",
      url: `https://example.com/${index + 1}`,
      sourceType: "news" as const,
      signalType: "external_search" as const,
      weight: 1,
    }));
    const formatted = formatCollectedEvidenceForAgent([
      ...searchLeads,
      {
        source: "CSTD Alpha",
        query: "300308",
        title: "实时行情快照",
        summary: "中际旭创(300308) 最新行情",
        url: "",
        sourceType: "official",
        signalType: "external_search",
        weight: 3,
      },
      {
        source: "CSTD Alpha",
        query: "300308",
        title: "财务报表",
        summary: "中际旭创(300308) 同口径财报",
        url: "",
        sourceType: "official",
        signalType: "external_search",
        weight: 4,
      },
    ]);

    expect(formatted).toContain("E1 财务报表");
    expect(formatted).toContain("E2 实时行情快照");
    expect(formatted).toContain("搜索线索 20");
  });
});
