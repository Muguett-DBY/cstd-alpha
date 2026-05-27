import { describe, expect, test } from "vitest";
import { guardAssistantOutputLanguage } from "./assistant-output-guards";

const noExa = { exa: { used: false, count: 0 } };

describe("guardCertaintyPromiseLanguage", () => {
  test("replaces 无风险 with 较确定", async () => {
    const result = await guardAssistantOutputLanguage("这是一个无风险收益策略", "收益如何？", noExa);
    expect(result).toContain("较确定");
    expect(result).not.toContain("无风险");
  });

  test("replaces 必涨 with softened language", async () => {
    const result = await guardAssistantOutputLanguage("该博主说必涨可信", "这个博主可信吗？", noExa);
    expect(result).toContain("不可信");
  });

  test("replaces 稳赚 with softened language", async () => {
    const result = await guardAssistantOutputLanguage("稳赚可信", "这个能稳赚吗？", noExa);
    expect(result).toContain("不可信");
  });
});

describe("guardStaleHistoryLanguage", () => {
  test("replaces 站内证据 with 当前可用证据", async () => {
    const result = await guardAssistantOutputLanguage("站内证据无法支撑这个结论", "分析一下", noExa);
    expect(result).toContain("当前可用证据无法支撑");
    expect(result).not.toContain("站内证据");
  });

  test("removes 本轮无新增 evidence lines", async () => {
    const text = "结论：先观察。\n本轮无新增站内证据。\n反证：需验证。";
    const result = await guardAssistantOutputLanguage(text, "怎么样？", noExa);
    expect(result).not.toContain("本轮无新增");
  });
});

describe("guardUnauditedStrongFactLanguage", () => {
  test("replaces 业绩双降 with 承压待核验", async () => {
    const result = await guardAssistantOutputLanguage("该公司首次业绩双降", "分析一下", noExa);
    expect(result).toContain("待核验线索");
    expect(result).not.toContain("业绩双降");
  });
});

describe("guardRiskBudgetLanguage", () => {
  test("appends risk budget for high-risk questions", async () => {
    const text = "结论：可以关注这只股票。";
    const result = await guardAssistantOutputLanguage(text, "这个能梭哈吗？", noExa);
    expect(result).toContain("风险预算");
    expect(result).toContain("仓位上限");
  });

  test("does not append risk budget if already present", async () => {
    const text = "结论：可以关注。\n风险预算：已设仓位上限。";
    const result = await guardAssistantOutputLanguage(text, "能梭哈吗？", noExa);
    expect(result).toContain("已设仓位上限");
    expect(result.match(/风险预算/g)).toHaveLength(1);
  });
});

describe("guardCrisisDeEscalationLanguage", () => {
  test("appends crisis de-escalation for desperate users", async () => {
    const text = "结论：先观察。";
    const result = await guardAssistantOutputLanguage(text, "人生完了，亏惨了", noExa);
    expect(result).toContain("危机降速");
  });

  test("does not append if de-escalation text already present", async () => {
    const text = "结论：先观察。\n危机降速：先暂停交易。";
    const result = await guardAssistantOutputLanguage(text, "亏惨了怎么办", noExa);
    expect(result.match(/危机降速/g)).toHaveLength(1);
  });
});

describe("guardLegalBoundaryLanguage", () => {
  test("appends legal boundary for tax questions", async () => {
    const result = await guardAssistantOutputLanguage("结论：建议分散配置。", "怎么合理避税？", noExa);
    expect(result).toContain("法律/合规边界");
  });
});

describe("guardWeakEvidenceSuperlatives", () => {
  test("replaces 最值得 with 相对值得 when evidence is low", async () => {
    const text = "证据等级：低。这个标的最值得买入。";
    const result = await guardAssistantOutputLanguage(text, "哪只最好？", noExa);
    expect(result).not.toContain("最值得");
    expect(result).toContain("相对值得");
  });

  test("does not change high-evidence superlatives", async () => {
    const text = "这个标的最值得买入。";
    const result = await guardAssistantOutputLanguage(text, "哪只最好？", noExa);
    expect(result).toContain("最值得");
  });
});

describe("guardForecastLanguage", () => {
  test("prepends 口径说明 for forecast questions", async () => {
    const result = await guardAssistantOutputLanguage("2025年实际值100亿。", "预估一下明年业绩", noExa);
    expect(result).toContain("口径说明");
  });

  test("does not double-prepend 口径说明", async () => {
    const text = "口径说明：已有说明。2025年实际值100亿。";
    const result = await guardAssistantOutputLanguage(text, "预估一下明年业绩", noExa);
    expect(result.match(/口径说明/g)).toHaveLength(1);
  });

  test("downgrades 证据等级：高 to 中", async () => {
    const text = "证据等级：高。这个结论可靠。";
    const result = await guardAssistantOutputLanguage(text, "预估明年利润", noExa);
    expect(result).toContain("证据等级：中");
  });
});

describe("guardExternalEvidenceConsistency", () => {
  test("replaces Exa无可用结果 when Exa actually returned data", async () => {
    const text = "Exa无可用结果。因此完全依赖站内数据。";
    const result = await guardAssistantOutputLanguage(text, "查一下", { exa: { used: true, count: 5 } });
    expect(result).toContain("Exa返回了外部线索");
    expect(result).not.toContain("Exa无可用结果");
  });

  test("keeps Exa无可用结果 when Exa returned nothing", async () => {
    const text = "Exa无可用结果，完全依赖站内数据。";
    const result = await guardAssistantOutputLanguage(text, "查一下", { exa: { used: true, count: 0 } });
    expect(result).toContain("Exa无可用结果");
  });
});

describe("guardExternalEvidenceLevel", () => {
  test("downgrades 高 to 中 when evidence depends on external search", async () => {
    const text = "证据等级：高，来源包括Exa检索和海外新闻。整体判断可靠。";
    const result = await guardAssistantOutputLanguage(text, "分析一下外盘", { exa: { used: true, count: 3 } });
    expect(result).toContain("证据等级：中");
    expect(result).not.toContain("证据等级：高");
  });
});

describe("cleanAssistantFormatting", () => {
  test("removes empty markdown sections", async () => {
    const text = "结论：先观察。\n\n反证条件：\n\n\n下一步跟踪：\n\n以上是本次分析。";
    const result = await guardAssistantOutputLanguage(text, "怎么样？", noExa);
    expect(result).not.toContain("反证条件：\n\n\n下一步跟踪：");
    expect(result).toContain("以上是本次分析");
  });

  test("removes 好的收到 boilerplate", async () => {
    const text = "好的，收到你的指令。作为CSTD Alpha的投研助手，我来分析。结论：先观察。";
    const result = await guardAssistantOutputLanguage(text, "分析一下", noExa);
    expect(result).not.toContain("好的，收到");
  });
});

describe("guardChartRefusalLanguage", () => {
  test("replaces chart refusal with data table", async () => {
    const text = "无法在聊天框中直接画图。以下是数据：\n2024-01-01, 100\n2024-02-01, 110\n2024-03-01, 120\n2024-04-01, 115\n";
    const result = await guardAssistantOutputLanguage(text, "请画图", noExa);
    expect(result).toContain("| 日期");
    expect(result).not.toContain("无法在聊天框中直接画图");
  });

  test("does not modify non-refusal text", async () => {
    const text = "结论：先观察。";
    const result = await guardAssistantOutputLanguage(text, "请画图", noExa);
    expect(result).toBe(text);
  });
});
