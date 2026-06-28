import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { describeAppViewLoading } from "./app-view-loading";

describe("authenticated view loading copy", () => {
  test("names heavy workspace modules while they are lazy-loaded", () => {
    expect(describeAppViewLoading("valuation")).toEqual({
      label: "估值",
      title: "正在加载估值工作台",
      detail: "正在准备量化估值模型、版本历史和预设库。",
      checkpoints: ["加载估值模型", "恢复版本上下文", "准备交互控件"],
    });
    expect(describeAppViewLoading("assistant").title).toBe("正在加载研究助理");
    expect(describeAppViewLoading("report").label).toBe("报告");
    expect(describeAppViewLoading("opportunities").checkpoints).toContain("同步机会列表");
  });

  test("stops loading animations when reduced motion is requested", () => {
    const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
    const loadingRules = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.module-loading-spinner,[\s\S]*?\n\}/,
    )?.[0];

    expect(loadingRules).toContain("animation: none");
  });
});
