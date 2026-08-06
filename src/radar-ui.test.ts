import { describe, expect, test } from "vitest";
import { isWeakRadarPacket, radarCardInsights, radarChangeBuckets, radarPacketDisplayPriority, radarPacketGapExplanation, radarRefreshFallbackMessage, radarStatusLabel, resolveRadarResultState } from "./radar-ui";
import type { RadarIndustryPacket, RadarItem } from "./shared/radar";

describe("radarRefreshFallbackMessage", () => {
  test("preserves existing radar on refresh failure", () => {
    expect(radarRefreshFallbackMessage(true, new Error("timeout"))).toBe("本次刷新失败，已保留上次扫描。请稍后重试。");
  });

  test("returns error message when no existing radar", () => {
    expect(radarRefreshFallbackMessage(false, new Error("Network error"))).toBe("Network error");
  });

  test("generic message when error is not an Error instance", () => {
    expect(radarRefreshFallbackMessage(false, "string error")).toBe("雷达扫描失败。");
  });
});

describe("resolveRadarResultState", () => {
  test("keeps the previous radar visible and surfaces a failed job message", () => {
    expect(resolveRadarResultState({
      radar: { refreshWarning: undefined },
      job: { status: "failed", message: "后台分析失败，已保留旧扫描。" },
    }, true)).toEqual({ phase: "ready", error: "后台分析失败，已保留旧扫描。" });
    expect(radarStatusLabel({ fromCache: true }, { status: "failed" })).toBe("刷新失败，已保留上次扫描");
  });

  test("enters the error state when a failed job has no radar to retain", () => {
    expect(resolveRadarResultState({ radar: null, job: { status: "failed" } }, false)).toEqual({
      phase: "error",
      error: "雷达扫描失败，请稍后重试。",
    });
  });

  test("preserves running and successful radar states", () => {
    expect(resolveRadarResultState({ radar: null, job: { status: "running" }, warning: "仍在处理" }, true)).toEqual({
      phase: "refreshing",
      error: "仍在处理",
    });
    expect(radarStatusLabel({ fromCache: true }, { status: "completed" })).toBe("复用稳定扫描");
    expect(radarStatusLabel({ fromCache: false }, { status: "completed" })).toBe("本次新扫描");
  });
});

describe("radarChangeBuckets", () => {
  test("categorizes changes into four buckets", () => {
    const result = radarChangeBuckets([
      "solidGrowth:光模块 featured 扎实增长",
      "升级:半导体 from 观察 to 正式结论",
      "sustainability:AI硬件延续",
      "未延续:新能源 from 正式结论 removed",
      "维持:银行 保留",
    ]);
    expect(result.added).toContain("扎实增长:光模块 featured 扎实增长");
    expect(result.upgraded[0]).toContain("半导体");
    expect(result.maintained[0]).toContain("AI硬件");
    expect(result.downgraded[0]).toContain("新能源");
    expect(result.maintained[1]).toContain("银行");
  });

  test("translates English field names to Chinese", () => {
    const result = radarChangeBuckets(["solidGrowth:AI 新增"]);
    expect(result.added[0]).toContain("扎实增长");
  });

  test("handles empty change log", () => {
    const result = radarChangeBuckets([]);
    expect(result.added).toEqual([]);
    expect(result.upgraded).toEqual([]);
    expect(result.downgraded).toEqual([]);
    expect(result.maintained).toEqual([]);
  });
});

describe("isWeakRadarPacket", () => {
  function makePacket(overrides: Partial<RadarIndustryPacket> = {}): RadarIndustryPacket {
    return {
      group: "电子",
      industry: "半导体",
      status: "scanned",
      evidenceHash: "abc",
      sourceCount: 5,
      evidenceTypes: ["hard_data"],
      signalTypes: [],
      evidenceGaps: [],
      ...overrides,
    };
  }

  test("returns true for evidence-insufficient stage", () => {
    expect(isWeakRadarPacket(makePacket({ stage: "证据不足" }))).toBe(true);
  });

  test("returns false for normal packet", () => {
    expect(isWeakRadarPacket(makePacket({ stage: "扎实增长", sourceCount: 10 }))).toBe(false);
  });

  test("returns true for low-source-count low-evidence packet", () => {
    expect(isWeakRadarPacket(makePacket({ sourceCount: 1, scores: { growth: 0, momentum: 0, evidence: 20, valuationRisk: 0, bubbleRisk: 0, declineRisk: 0, confidence: 0, change: 0 } }))).toBe(true);
  });

  test("returns true for multi-gap packets with missing cross-validation", () => {
    expect(isWeakRadarPacket(makePacket({ evidenceGaps: ["缺多源验证", "缺财报"], sourceCount: 3 }))).toBe(true);
  });

  test("returns false for single-gap packets without missing validation", () => {
    expect(isWeakRadarPacket(makePacket({ stage: "扎实增长", evidenceGaps: ["缺财报"], sourceCount: 3 }))).toBe(false);
  });
});

describe("radarPacketDisplayPriority", () => {
  function makePacket(overrides: Partial<RadarIndustryPacket> = {}): RadarIndustryPacket {
    return {
      group: "电子",
      industry: "半导体",
      status: "scanned",
      evidenceHash: "abc",
      sourceCount: 10,
      evidenceTypes: ["hard_data", "announcement"],
      signalTypes: [],
      evidenceGaps: [],
      ...overrides,
    };
  }

  test("solid growth has higher priority than evidence insufficient", () => {
    const solid = radarPacketDisplayPriority(makePacket({ stage: "扎实增长", scores: { growth: 80, momentum: 70, evidence: 80, valuationRisk: 20, bubbleRisk: 10, declineRisk: 5, confidence: 80, change: 50 } }));
    const weak = radarPacketDisplayPriority(makePacket({ stage: "证据不足", scores: { growth: 0, momentum: 0, evidence: 0, valuationRisk: 0, bubbleRisk: 0, declineRisk: 0, confidence: 0, change: 0 }, sourceCount: 1, evidenceTypes: [] }));
    expect(solid).toBeGreaterThan(weak);
  });

  test("weak packets get penalty", () => {
    const weak = radarPacketDisplayPriority(makePacket({ stage: "证据不足", sourceCount: 1, evidenceTypes: [], evidenceGaps: ["缺多源验证"] }));
    const normal = radarPacketDisplayPriority(makePacket({ stage: "继续观察" }));
    expect(normal).toBeGreaterThan(weak);
  });
});

describe("radarPacketGapExplanation", () => {
  function makePacket(overrides: Partial<RadarIndustryPacket> = {}): RadarIndustryPacket {
    return {
      group: "电子",
      industry: "半导体",
      status: "scanned",
      evidenceHash: "abc",
      sourceCount: 5,
      evidenceTypes: ["hard_data"],
      signalTypes: [],
      evidenceGaps: [],
      ...overrides,
    };
  }

  test("returns compact gap list", () => {
    const result = radarPacketGapExplanation(makePacket({ evidenceGaps: ["缺财报", "缺销量"] }));
    expect(result.compact).toBe("缺财报、缺销量");
  });

  test("returns default message when no gaps", () => {
    const result = radarPacketGapExplanation(makePacket());
    expect(result.compact).toContain("核心证据暂无模型标注缺口");
  });

  test("explains evidence-insufficient stage", () => {
    const result = radarPacketGapExplanation(makePacket({ stage: "证据不足" }));
    expect(result.reason).toContain("证据强度不足");
  });

  test("explains watch-stage packet", () => {
    const result = radarPacketGapExplanation(makePacket({ stage: "继续观察" }));
    expect(result.reason).toContain("关键硬证据仍不完整");
  });

  test("explains formal-stage packet", () => {
    const result = radarPacketGapExplanation(makePacket({ stage: "扎实增长" }));
    expect(result.reason).toContain("已进入扎实增长");
  });
});

describe("radarCardInsights", () => {
  function makeItem(overrides: Partial<RadarItem> = {}): RadarItem {
    return {
      title: "Test Industry",
      industries: ["电子"],
      companies: ["Test Co"],
      thesis: "Growth thesis",
      drivers: ["AI"],
      evidence: ["Revenue growing"],
      conclusionStrength: "正式结论",
      evidenceGaps: [],
      driverTags: ["需求"],
      sustainabilityTier: "长期护城河",
      durability: "长期",
      riskLevel: "低",
      counterEvidenceConditions: [],
      turningPoints: [],
      ...overrides,
    };
  }

  test("high confidence with sufficient sources", () => {
    const result = radarCardInsights(makeItem({ confidence: "高", supportingSourceCount: 5, evidenceTypes: ["hard_data", "announcement"] }) as RadarItem & Record<string, unknown>);
    expect(result.strengthLabel).toBe("高强度结论");
  });

  test("low confidence with single source", () => {
    const result = radarCardInsights(makeItem({ confidence: "低", supportingSourceCount: 1 }) as RadarItem & Record<string, unknown>);
    expect(result.strengthLabel).toBe("低强度观察");
  });

  test("medium strength defaults", () => {
    const result = radarCardInsights(makeItem({ confidence: "中", supportingSourceCount: 2 }) as RadarItem & Record<string, unknown>);
    expect(result.strengthLabel).toBe("中强度判断");
  });

  test("includes change reason when available", () => {
    const result = radarCardInsights(makeItem({ changeReason: "Evidence strengthened" }) as RadarItem & Record<string, unknown>);
    expect(result.changeExplanation).toBe("Evidence strengthened");
  });

  test("provides default change explanation", () => {
    const result = radarCardInsights(makeItem() as RadarItem & Record<string, unknown>);
    expect(result.changeExplanation).toBe("本轮未提供单项变化说明。");
  });

  test("falls back to sourceIds length for source count", () => {
    const result = radarCardInsights(makeItem({ supportingSourceCount: undefined, sourceIds: ["s1", "s2", "s3"], evidenceTypes: ["hard_data", "announcement"] }) as RadarItem & Record<string, unknown>);
    expect(result.strengthDetail).toContain("3 条");
  });
});
