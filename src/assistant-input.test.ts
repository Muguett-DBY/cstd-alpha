import { describe, expect, test } from "vitest";
import { assistantKeyIntent, mergeSpeechTranscript } from "./assistant-input";

describe("assistant input helpers", () => {
  test("submits on plain Enter and keeps Shift+Enter as newline", () => {
    expect(assistantKeyIntent({ key: "Enter" })).toBe("submit");
    expect(assistantKeyIntent({ key: "Enter", shiftKey: true })).toBe("newline");
  });

  test("does not submit while composing Chinese input or using modifier shortcuts", () => {
    expect(assistantKeyIntent({ key: "Enter", isComposing: true })).toBe("ignore");
    expect(assistantKeyIntent({ key: "Enter", metaKey: true })).toBe("ignore");
    expect(assistantKeyIntent({ key: "a" })).toBe("ignore");
  });

  test("merges speech transcript into the current draft without eating existing text", () => {
    expect(mergeSpeechTranscript("", "  茅台今年业绩  ")).toBe("茅台今年业绩");
    expect(mergeSpeechTranscript("分析宁德时代", "现金流")).toBe("分析宁德时代 现金流");
    expect(mergeSpeechTranscript("分析宁德时代，", "现金流")).toBe("分析宁德时代，现金流");
  });
});
