import { describe, expect, test } from "vitest";
import { calculateResearchOpportunityScore, groupResearchTemplates, opportunityFromRadarPacket, opportunityFromWatchlistRanking } from "./shared/research-workbench";
import type { RadarIndustryPacket } from "./shared/radar";
import type { ResearchTemplate, WatchlistRankingEntry } from "./shared/user-research";

describe("research workbench scoring", () => {
  test("rewards evidence changes, catalysts, valuation mismatch and upside while penalizing risk", () => {
    const strong = calculateResearchOpportunityScore({ evidenceChange: 90, catalystProximity: 85, valuationMismatch: 80, potentialUpside: 88, downsideRisk: 25 });
    const weak = calculateResearchOpportunityScore({ evidenceChange: 25, catalystProximity: 20, valuationMismatch: 35, potentialUpside: 30, downsideRisk: 80 });

    expect(strong).toBeGreaterThan(80);
    expect(weak).toBeLessThan(40);
  });

  test("converts radar industry packets into research opportunities without model calls", () => {
    const packet: RadarIndustryPacket = {
      group: "科技成长",
      industry: "光模块",
      status: "scanned",
      changeStatus: "changed",
      stage: "即将增长",
      evidenceHash: "h",
      sourceCount: 42,
      evidenceTypes: ["hard_data", "announcement"],
      signalTypes: ["订单"],
      evidenceGaps: [],
      themes: ["AI算力"],
      scores: { growth: 82, momentum: 77, evidence: 86, valuationRisk: 30, bubbleRisk: 35, declineRisk: 10, confidence: 78, change: 72 },
    };

    const opportunity = opportunityFromRadarPacket(packet);

    expect(opportunity.entityType).toBe("industry");
    expect(opportunity.stage).toBe("deepResearch");
    expect(opportunity.opportunityScore).toBeGreaterThan(70);
    expect(opportunity.reasons.join(" ")).toContain("本轮证据变化");
  });

  test("converts watchlist ranking entries into company opportunities", () => {
    const entry: WatchlistRankingEntry = {
      watchlistId: "w1",
      companyName: "腾讯控股",
      ticker: "00700",
      market: "港股",
      status: "completed",
      companyQualityScore: 84,
      investmentAttractivenessScore: 72,
      overallScore: 79,
      verdict: "看好",
      summary: "利润修复和回购形成催化。",
      keyPoints: ["现金流强", "回购稳定"],
      riskFlags: ["监管变化"],
    };

    const opportunity = opportunityFromWatchlistRanking(entry);

    expect(opportunity.entityType).toBe("company");
    expect(opportunity.stage).toBe("deepResearch");
    expect(opportunity.reasons).toContain("现金流强");
  });

  test("groups templates into research workbench themes", () => {
    const templates = [
      template("估值判断", "DCF、安全边际和价格"),
      template("护城河分析", "竞争优势和商业模式"),
      template("风险排查", "价值陷阱、泡沫和反证"),
    ];

    const groups = groupResearchTemplates(templates);

    expect(groups.map((group) => group.id)).toEqual(["moat", "valuation", "risk"]);
    expect(groups.find((group) => group.id === "valuation")?.templates[0]?.title).toBe("估值判断");
  });
});

function template(title: string, focus: string): ResearchTemplate {
  return {
    id: title,
    title,
    shortTitle: title,
    focus,
    prompt: focus,
    fullPrompt: focus,
    enabled: true,
  };
}
