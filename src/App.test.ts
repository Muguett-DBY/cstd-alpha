import { describe, expect, test } from "vitest";
import { DEFAULT_APP_VIEW } from "./App";
import { buildRadarSourceLibrary, radarCardInsights, radarChangeBuckets, radarPacketDisplayPlan, radarPacketGapExplanation, radarRefreshFallbackMessage } from "./radar-ui";
import type { RadarCitation, RadarIndustryPacket, RadarItem } from "./shared/radar";

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
      "新增航运物流为upcomingGrowth。",
    ]);

    expect(buckets.added).toEqual(["新增或调整：固态电池。", "新增航运物流为即将增长。"]);
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

  test("does not invent radar evidence gaps when the model leaves them empty", () => {
    const insights = radarCardInsights(
      radarItem({
        title: "创新药利润拐点",
        industries: ["创新药"],
        evidenceTypes: ["announcement"],
        supportingSourceCount: 4,
        confidence: "高",
        evidenceGaps: [],
      }),
    );

    expect(insights.evidenceGaps).toEqual([]);
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

  test("demotes weak evidence industries from default radar visual lists while keeping them searchable", () => {
    const packets: RadarIndustryPacket[] = [
      radarPacket({ industry: "消费电子/端侧AI", stage: "继续观察", sourceCount: 97, evidenceGaps: ["缺财报"] }),
      radarPacket({ industry: "低空经济", stage: "证据不足", sourceCount: 0, evidenceGaps: ["缺财报", "缺多源验证"] }),
      radarPacket({ industry: "地产链", stage: "衰退", sourceCount: 37, evidenceGaps: [] }),
      radarPacket({ industry: "光伏产业链", stage: "衰退", sourceCount: 23, evidenceGaps: [] }),
      radarPacket({ industry: "白酒", stage: "继续观察", sourceCount: 48, evidenceGaps: [] }),
      radarPacket({ industry: "轻工包装/造纸", stage: "证据不足", sourceCount: 0, evidenceGaps: ["缺财报", "缺多源验证"] }),
      radarPacket({ industry: "电网设备", stage: "继续观察", sourceCount: 31, evidenceGaps: ["缺订单"] }),
      radarPacket({ industry: "存储芯片", stage: "继续观察", sourceCount: 42, evidenceGaps: ["缺价格"] }),
      radarPacket({ industry: "煤电/火电", stage: "平稳现金流", sourceCount: 20, evidenceGaps: [] }),
      radarPacket({ industry: "机器人/具身智能", stage: "泡沫风险", sourceCount: 19, evidenceGaps: [] }),
      radarPacket({ industry: "银行", stage: "平稳现金流", sourceCount: 16, evidenceGaps: [] }),
      radarPacket({ industry: "航运物流", stage: "继续观察", sourceCount: 14, evidenceGaps: [] }),
      radarPacket({ industry: "食品饮料", stage: "证据不足", sourceCount: 0, evidenceGaps: ["缺财报"] }),
    ];

    const plan = radarPacketDisplayPlan(packets, {});
    const filteredPlan = radarPacketDisplayPlan(packets, { stage: "证据不足" });

    expect(plan.defaultRows).toHaveLength(10);
    expect(plan.defaultRows.map((packet) => packet.industry)).not.toContain("低空经济");
    expect(plan.defaultRows.map((packet) => packet.industry)).not.toContain("轻工包装/造纸");
    expect(plan.allRows.map((packet) => packet.industry)).toEqual(expect.arrayContaining(["低空经济", "轻工包装/造纸"]));
    expect(filteredPlan.visibleRows.map((packet) => packet.industry)).toEqual(expect.arrayContaining(["低空经济", "轻工包装/造纸", "食品饮料"]));
  });

  test("explains radar evidence gaps with the next data needed", () => {
    const explanation = radarPacketGapExplanation(radarPacket({ industry: "电网设备", stage: "继续观察", evidenceGaps: ["缺订单"], sourceCount: 31 }));

    expect(explanation.reason).toContain("暂未升级");
    expect(explanation.nextEvidence).toContain("中标");
    expect(explanation.compact).toContain("缺订单");
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

function radarPacket(overrides: Partial<RadarIndustryPacket>): RadarIndustryPacket {
  return {
    group: "测试分组",
    industry: "测试行业",
    status: "scanned",
    stage: "继续观察",
    evidenceHash: "hash",
    sourceCount: 1,
    evidenceTypes: ["news"],
    signalTypes: [],
    evidenceGaps: [],
    ...overrides,
  };
}
