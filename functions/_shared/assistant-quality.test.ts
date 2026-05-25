import { describe, expect, test } from "vitest";
import { ASSISTANT_QUALITY_PROMPTS, assistantQualityPromptStats, isUnsatisfactoryEvidenceOnlyAnswer } from "./assistant-quality";

describe("assistant quality prompt suite", () => {
  test("covers 200 realistic investment assistant prompts across modes and categories", () => {
    const stats = assistantQualityPromptStats();
    expect(stats.count).toBe(200);
    expect(stats.categories).toBe(20);
    expect(stats.modes).toBe(3);
    expect(ASSISTANT_QUALITY_PROMPTS.filter((prompt) => prompt.mustUseEvidence).length).toBeGreaterThanOrEqual(170);
    expect(ASSISTANT_QUALITY_PROMPTS.some((prompt) => prompt.prompt.includes("茅台今年业绩预估"))).toBe(true);
    expect(ASSISTANT_QUALITY_PROMPTS.some((prompt) => prompt.prompt.includes("优必选人形机器人，大脑与小脑"))).toBe(true);
    expect(ASSISTANT_QUALITY_PROMPTS.some((prompt) => prompt.prompt.includes("港股互联网现在投资吸引力"))).toBe(true);
    expect(ASSISTANT_QUALITY_PROMPTS.some((prompt) => prompt.prompt.includes("如果我认为银行股是稳赚高股息"))).toBe(true);
  });

  test("flags answers that stop at evidence insufficiency without doing useful work", () => {
    expect(isUnsatisfactoryEvidenceOnlyAnswer("结论：证据不足，无法给出净利润预测。")).toBe(true);
    expect(
      isUnsatisfactoryEvidenceOnlyAnswer(
        "结论：低置信情景测算。可用证据只有一季度增速，因此给出保守/中性/乐观三个区间，并列出反证和下一步跟踪。",
      ),
    ).toBe(false);
  });
});
