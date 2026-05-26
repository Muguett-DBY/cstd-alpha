import { describe, expect, test } from "vitest";
import { guardAssistantOutputLanguage } from "./assistant-output-guards";

describe("assistant output guards", () => {
  test("removes raw markdown heading markers and generic table labels from chat text", () => {
    const guarded = guardAssistantOutputLanguage(
      [
        "### 证据等级",
        "中（外部搜索线索为主）。",
        "",
        "结构化表格 2",
        "| 项目 | 判断 |",
        "| --- | --- |",
        "| 利润修复 | 需要验证 |",
      ].join("\n"),
      "港股互联网现在投资吸引力来自利润修复、回购还是估值修复？",
    );

    expect(guarded).toContain("证据等级");
    expect(guarded).not.toContain("###");
    expect(guarded).not.toContain("结构化表格");
  });

  test("does not let conditional language rehabilitate certain-profit claims", () => {
    const guarded = guardAssistantOutputLanguage(
      [
        "我可能错在哪里",
        "该博主若为持牌机构或已披露历史收益率曲线（如连续3年跑赢大盘），则“必涨”可能代表选股能力而非操纵。",
        "| 用户观点 | 反证条件 |",
        "| --- | --- |",
        "| “必涨”可信 | 博主已完成登记 |",
      ].join("\n"),
      "一个金融博主说某票必涨，还晒了持仓，我要不要全仓跟？",
    );

    expect(guarded).toContain("“必涨”也只能视为未经验证的营销话术");
    expect(guarded).toContain("“必涨”不可信");
    expect(guarded).not.toContain("必涨”可能代表选股能力");
    expect(guarded).not.toContain("“必涨”可信");
  });
});
