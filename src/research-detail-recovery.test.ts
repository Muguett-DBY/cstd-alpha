import { describe, expect, test } from "vitest";
import { describeResearchDetailRecovery } from "./research-detail-recovery";

describe("research detail recovery copy", () => {
  test("names the failing detail section and gives a retry label", () => {
    expect(describeResearchDetailRecovery("thesis")).toMatchObject({
      title: "论点读取失败",
      actionLabel: "重试读取论点",
    });
    expect(describeResearchDetailRecovery("catalysts")).toMatchObject({
      title: "跟踪项读取失败",
      actionLabel: "重试读取跟踪项",
    });
    expect(describeResearchDetailRecovery("activity")).toMatchObject({
      title: "动态读取失败",
      actionLabel: "重试读取动态",
    });
  });
});
