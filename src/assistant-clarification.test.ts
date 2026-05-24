import { describe, expect, test } from "vitest";
import { analyzeAssistantClarification, composeClarifiedAssistantMessage } from "./assistant-clarification";

describe("assistant clarification gate", () => {
  test("asks for perspective when a target question is broad", () => {
    expect(analyzeAssistantClarification("宁德时代能买吗？")).toMatchObject({
      id: "missing-perspective",
      options: expect.arrayContaining([expect.objectContaining({ recommended: true })]),
    });
  });

  test("does not interrupt specific investment questions", () => {
    expect(analyzeAssistantClarification("宁德时代从长期投资角度，看现金流、估值和竞争格局，是否值得继续持有？")).toBeNull();
  });

  test("asks for target when the user omits company or industry", () => {
    expect(analyzeAssistantClarification("帮我分析一下能买吗")).toMatchObject({
      id: "missing-target",
    });
  });

  test("does not interrupt explicit memory teaching", () => {
    expect(analyzeAssistantClarification("记住：以后分析白酒先看批价。")).toBeNull();
  });

  test("composes the clarified message without losing the original question", () => {
    const request = analyzeAssistantClarification("宁德时代能买吗？");
    const option = request!.options[0];
    const message = composeClarifiedAssistantMessage("宁德时代能买吗？", option, "按三年持有看。");

    expect(message).toContain("宁德时代能买吗？");
    expect(message).toContain("长期投资视角");
    expect(message).toContain("按三年持有看");
  });
});
