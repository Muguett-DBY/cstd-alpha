import { describe, expect, test } from "vitest";
import { DEFAULT_APP_VIEW } from "./App";
import { buildRadarSourceLibrary, radarCardInsights, radarChangeBuckets, radarRefreshFallbackMessage } from "./radar-ui";
import type { RadarCitation, RadarItem } from "./shared/radar";

describe("app initial workspace", () => {
  test("opens on the radar scan view by default", () => {
    expect(DEFAULT_APP_VIEW).toBe("radar");
  });

  test("keeps radar refresh fallback brief when an old scan is still visible", () => {
    expect(radarRefreshFallbackMessage(true, new Error("DeepSeek 429 internal provider text"))).toBe("本次刷新失败，已保留上次扫描。请稍后重试。");
  });

  test("groups radar change log into round change buckets", () => {
    const buckets = radarChangeBuckets([
      "新增或调整：固态电池。",
      "算力租赁由观察条目升级为高置信结论。",
      "本次未延续：光伏玻璃，需等待后续硬数据。",
      "延续判断：工业软件国产替代。",
    ]);

    expect(buckets.added).toEqual(["新增或调整：固态电池。"]);
    expect(buckets.upgraded).toEqual(["算力租赁由观察条目升级为高置信结论。"]);
    expect(buckets.downgraded).toEqual(["本次未延续：光伏玻璃，需等待后续硬数据。"]);
    expect(buckets.maintained).toEqual(["延续判断：工业软件国产替代。"]);
  });

  test("summarizes radar card strength, evidence gaps, and counter signals compatibly", () => {
    const item: RadarItem & Record<string, unknown> = {
      title: "算力租赁景气扩散",
      industries: ["算力"],
      companies: ["示例科技"],
      thesis: "需求继续扩散。",
      drivers: ["订单增长"],
      evidence: ["新闻线索增多"],
      durability: "长期",
      riskLevel: "中",
      confidence: "高",
      evidenceTypes: ["news"],
      supportingSourceCount: 2,
      sourceIds: ["S1", "S2"],
      changeReason: "由观察条目升级为正式结论。",
      turningPoints: ["订单落地低于预期"],
      evidenceGaps: ["缺少公告和硬数据交叉验证"],
      counterEvidence: ["价格战压缩毛利"],
    };

    const insights = radarCardInsights(item);

    expect(insights.strengthLabel).toBe("高强度结论");
    expect(insights.strengthDetail).toContain("高置信");
    expect(insights.strengthDetail).toContain("2 条证据");
    expect(insights.evidenceGaps).toEqual(["缺少公告和硬数据交叉验证"]);
    expect(insights.counterSignals).toEqual(["价格战压缩毛利", "订单落地低于预期"]);
    expect(insights.changeExplanation).toBe("由观察条目升级为正式结论。");
  });

  test("filters radar source library by industry and evidence type", () => {
    const sources: RadarCitation[] = [
      { id: "S1", source: "协会", query: "储能", title: "储能装机增长", url: "", sourceType: "official", weight: 1 },
      { id: "S2", source: "公告", query: "算力", title: "算力订单公告", url: "", sourceType: "announcement", weight: 1 },
      { id: "S3", source: "新闻", query: "算力", title: "算力价格波动", url: "", sourceType: "news", weight: 1 },
    ];
    const items: RadarItem[] = [
      radarItem({ title: "储能出海", industries: ["储能"], sourceIds: ["S1"] }),
      radarItem({ title: "算力租赁", industries: ["算力"], sourceIds: ["S2", "S3"] }),
    ];

    const library = buildRadarSourceLibrary(sources, items, { industry: "算力", evidenceType: "announcement" });

    expect(library.industries).toEqual(["储能", "算力"]);
    expect(library.evidenceTypes).toEqual(["official", "announcement", "news"]);
    expect(library.entries.map((entry) => entry.source.id)).toEqual(["S2"]);
    expect(library.entries[0]?.industries).toEqual(["算力"]);
  });

  test("falls back to source query for industry filters when source ids are missing", () => {
    const sources: RadarCitation[] = [{ id: "S1", source: "新闻", query: "机器人", title: "机器人订单线索", url: "", sourceType: "news", weight: 1 }];
    const items: RadarItem[] = [radarItem({ title: "机器人观察", industries: ["机器人"] })];

    const library = buildRadarSourceLibrary(sources, items, { industry: "机器人" });

    expect(library.entries.map((entry) => entry.source.id)).toEqual(["S1"]);
    expect(library.entries[0]?.industries).toEqual(["机器人"]);
  });
});

function radarItem(overrides: Partial<RadarItem>): RadarItem {
  return {
    title: "默认主题",
    industries: [],
    companies: [],
    thesis: "",
    drivers: [],
    evidence: [],
    durability: "不确定",
    riskLevel: "中",
    turningPoints: [],
    ...overrides,
  };
}
