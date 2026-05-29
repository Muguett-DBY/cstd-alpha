import { describe, expect, test } from "vitest";
import { internalToolLabel, naturalToolStatusLabel } from "./assistant-tools";

describe("assistant tool labels", () => {
  test("uses neutral market-data wording for the generic quote tool", () => {
    expect(internalToolLabel("read_tencent_quote")).toBe("实时行情");
    expect(naturalToolStatusLabel({ id: "quote-1", name: "read_tencent_quote", query: "300750", reason: "查宁德时代行情" })).toBe("正在读取实时行情...");
  });
});
