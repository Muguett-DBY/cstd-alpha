import { describe, expect, test } from "vitest";
import { describeResearchQueueRecovery } from "./research-data-health";

describe("research queue data health", () => {
  test("returns no notice when no queue records were skipped", () => {
    expect(describeResearchQueueRecovery({ items: [] })).toBeNull();
    expect(describeResearchQueueRecovery({ items: [], skippedItems: 0, totalItems: 0 })).toBeNull();
  });

  test("describes skipped malformed research queue records", () => {
    expect(describeResearchQueueRecovery({ items: [], skippedItems: 2, totalItems: 5 })).toEqual({
      title: "研究队列已自动跳过异常记录",
      body: "本次读取跳过 2 条无法显示的记录，已保留 3 条可用记录。刷新或检查数据源后会自动恢复。",
      actionLabel: "重新读取",
    });
  });
});
