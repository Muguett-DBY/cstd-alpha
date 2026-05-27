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

  test("softens superlatives when evidence grade is weak", () => {
    const guarded = guardAssistantOutputLanguage(
      [
        "结论：A股医药板块当前是市场悲观预期最充分、逆向抄底性价比最高的资产类别。",
        "证据等级：中低。",
        "核心理由：相当于“十年最低折扣价”。",
      ].join("\n"),
      "哪些资产类别逆向抄底最值得？",
    );

    expect(guarded).toContain("值得优先观察的逆向资产类别之一");
    expect(guarded).toContain("低估值线索");
    expect(guarded).not.toContain("性价比最高");
  });

  test("does not frame public-market research as bounded by site-only evidence", () => {
    const guarded = guardAssistantOutputLanguage(
      "结论：站内证据无法支撑一年翻倍，站内无标的符合梭哈条件，站内证据包没有给出催化剂。",
      "我只想买一只股票，预算10万人民币，目标一年翻倍。",
    );

    expect(guarded).toContain("当前可用证据无法支撑");
    expect(guarded).toContain("当前证据未显示明确标的符合");
    expect(guarded).toContain("当前证据包没有给出催化剂");
    expect(guarded).not.toContain("站内证据无法支撑");
    expect(guarded).not.toContain("站内无标的符合");
  });

  test("adds missing risk budget and crisis de-escalation to high-risk answers", () => {
    const guarded = guardAssistantOutputLanguage(
      "结论：不能急着翻身，应先建立偿债和投资框架。证据等级：低。",
      "我有信用卡债、车贷和一点投资亏损，想用投资翻身而不是慢慢还债。",
    );

    expect(guarded).toContain("风险预算");
    expect(guarded).toContain("危机降速");
    expect(guarded).toContain("暂停新增交易");
  });

  test("adds legal boundary and removes unsafe risk-free wording", () => {
    const guarded = guardAssistantOutputLanguage(
      `结论：提前还贷等同于获得\u201c无风险、免税、零波动\u201d的回报，也可能是无风险获益。`,
      "有没有办法绕过券商限制，让我买到本来买不了的高风险产品？",
    );

    expect(guarded).toContain("确定性省息");
    expect(guarded).toContain("较确定的省息收益");
    expect(guarded).toContain("法律/合规边界");
    expect(guarded).not.toContain("无风险、免税、零波动");
  });

  describe("chart refusal guard", () => {
    test("rewrites refusal with code block CSV data to Markdown table", () => {
      const input = [
        "抱歉，我无法在聊天框里直接生成图片或图表。但以下是小米集团（01810.HK）自2018年7月上市以来的完整周度收盘价数据集（时间→收盘价，单位港元）：",
        "",
        "```",
        "2018-07-13,16.80",
        "2018-07-20,16.44",
        "2018-07-27,16.64",
        "2018-08-03,15.90",
        "```",
      ].join("\n");

      const guarded = guardAssistantOutputLanguage(input, "小米上市以来股价画个折线图");

      expect(guarded).not.toContain("无法在聊天框");
      expect(guarded).not.toContain("```");
      expect(guarded).toContain("| 日期 | 数值 |");
      expect(guarded).toContain("| 2018-07-13 | 16.80 |");
      expect(guarded).toContain("| 2018-07-20 | 16.44 |");
      expect(guarded).toContain("系统会自动渲染为折线图");
    });

    test("does not touch non-chart-request messages", () => {
      const input = "无法画图，但可以给你文字分析。";
      const guarded = guardAssistantOutputLanguage(input, "小米集团怎么样？");
      expect(guarded).toBe(input);
    });

    test("does not touch normal chart responses without refusal", () => {
      const table = [
        "| 年份 | 营收 | 净利润 |",
        "| --- | --- | --- |",
        "| 2021 | 100 | 20 |",
        "| 2022 | 120 | 25 |",
      ].join("\n");
      const guarded = guardAssistantOutputLanguage(
        `结论：小米数据如下。\n\n${table}`,
        "画表对比小米营收和净利润",
      );
      expect(guarded).toContain("| 年份 |");
      expect(guarded).not.toContain("无法画图");
    });

    test("rewrites inline data (no code block) into Markdown table", () => {
      const input = [
        "抱歉，我无法直接生成图片。以下是数据：",
        "2020-01-02 300.0",
        "2020-01-03 310.0",
        "2020-01-06 315.0",
        "2020-01-07 312.0",
      ].join("\n");

      const guarded = guardAssistantOutputLanguage(input, "苹果股价画图");

      expect(guarded).not.toContain("无法直接生成图片");
      expect(guarded).toContain("| 日期 | 数值 |");
      expect(guarded).toContain("| 2020-01-02 | 300.0 |");
    });

    test("samples data when over 200 rows", () => {
      const lines = Array.from({ length: 300 }, (_, i) => {
        const date = new Date(2020, 0, 1 + i);
        const dateStr = date.toISOString().slice(0, 10);
        const price = (100 + Math.random() * 50).toFixed(2);
        return `${dateStr},${price}`;
      });
      const input = [
        "抱歉，无法在聊天框画图。以下是完整数据：",
        "",
        "```",
        ...lines,
        "```",
      ].join("\n");

      const guarded = guardAssistantOutputLanguage(input, "腾讯股价画折线图");

      expect(guarded).not.toContain("```");
      expect(guarded).toContain("| 日期 | 数值 |");
      const rows = guarded.split("\n").filter((l) => l.startsWith("|") && !l.includes("---") && !l.includes("日期")).length;
      expect(rows).toBeGreaterThanOrEqual(2);
      expect(rows).toBeLessThanOrEqual(160);
    });

    test("uses multi-column headers when data has more than 2 columns", () => {
      const input = [
        "抱歉无法画图，数据如下：",
        "```",
        "2020-01-01,100,200,300",
        "2020-02-01,110,210,310",
        "2020-03-01,120,220,320",
        "```",
      ].join("\n");

      const guarded = guardAssistantOutputLanguage(input, "画趋势图");

      expect(guarded).toContain("| 日期 | 指标1 | 指标2 | 指标3 |");
      expect(guarded).toContain("| 2020-01-01 | 100 | 200 | 300 |");
    });
  });
});
