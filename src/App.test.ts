import { describe, expect, test } from "vitest";
import { DEFAULT_APP_VIEW } from "./App";
import { radarRefreshFallbackMessage } from "./radar-ui";

describe("app initial workspace", () => {
  test("opens on the radar scan view by default", () => {
    expect(DEFAULT_APP_VIEW).toBe("radar");
  });

  test("keeps radar refresh fallback brief when an old scan is still visible", () => {
    expect(radarRefreshFallbackMessage(true, new Error("DeepSeek 429 internal provider text"))).toBe("本次刷新失败，已保留上次扫描。请稍后重试。");
  });
});
