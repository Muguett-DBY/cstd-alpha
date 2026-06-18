import { describe, expect, test } from "vitest";
import { moveResearchItemToStageEnd } from "./research-queue-order";

describe("research queue ordering", () => {
  test("keeps hidden stage items when a filtered card is dropped at the end of a stage", () => {
    const result = moveResearchItemToStageEnd({
      items: [
        { id: "screening-visible", stage: "screening" },
        { id: "screening-hidden", stage: "screening" },
        { id: "deep-visible", stage: "deepResearch" },
        { id: "deep-hidden", stage: "deepResearch" },
      ],
      itemOrder: {
        screening: ["screening-visible", "screening-hidden"],
        deepResearch: ["deep-visible", "deep-hidden"],
      },
      sourceId: "screening-visible",
      targetStage: "deepResearch",
    });

    expect(result.nextOrder).toEqual({
      screening: ["screening-hidden"],
      deepResearch: ["deep-visible", "deep-hidden", "screening-visible"],
    });
    expect(result.updates).toEqual([
      { id: "screening-visible", stage: "deepResearch", sortOrder: 2 },
      { id: "screening-hidden", stage: "screening", sortOrder: 0 },
      { id: "deep-visible", stage: "deepResearch", sortOrder: 0 },
      { id: "deep-hidden", stage: "deepResearch", sortOrder: 1 },
    ]);
  });
});
