import { describe, expect, test } from "vitest";
import { decorateResearchQuickAddCandidates, upsertResearchWorkspaceItem } from "./research-quick-add";
import type { CompanyCandidate } from "./shared/report";
import type { ResearchWorkbenchItem } from "./shared/research-workbench";

const company: CompanyCandidate = {
  id: "eastmoney:1.600519",
  name: "贵州茅台",
  code: "600519",
  exchange: "上海证券交易所",
  listingPlace: "A股",
  marketType: "AStock",
  source: "eastmoney",
};

const item: ResearchWorkbenchItem = {
  id: "research-row-1",
  userKey: "user-1",
  entityType: "company",
  entityId: company.id,
  title: company.name,
  stage: "screening",
  status: "active",
  source: company.source,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

describe("research quick add", () => {
  test("marks candidates already present in the research queue", () => {
    expect(decorateResearchQuickAddCandidates([company], [item])).toEqual([
      { ...company, existingItemId: "research-row-1" },
    ]);
  });

  test("inserts a new item first and replaces an existing row without duplicates", () => {
    const another = { ...item, id: "research-row-2", entityId: "eastmoney:0.000001", title: "平安银行" };
    expect(upsertResearchWorkspaceItem([another], item)).toEqual([item, another]);
    expect(upsertResearchWorkspaceItem([item, another], { ...item, title: "贵州茅台股份" })).toEqual([
      { ...item, title: "贵州茅台股份" },
      another,
    ]);
  });
});
