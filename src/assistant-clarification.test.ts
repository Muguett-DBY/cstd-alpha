import { describe, expect, test } from "vitest";
import { composeClarifiedAssistantMessage } from "./assistant-clarification";

describe("assistant clarification gate", () => {
  test("composes a clarified model-choice answer without losing the original question", () => {
    const option = {
      id: "long-term",
      label: "长期投资视角",
      description: "重点看商业质量、财务持续性、估值安全边际和反证条件。",
      recommended: true,
    };
    const message = composeClarifiedAssistantMessage("宁德时代能买吗？", option, "按三年持有看。");

    expect(message).toContain("宁德时代能买吗？");
    expect(message).toContain("长期投资视角");
    expect(message).toContain("按三年持有看");
  });
});
