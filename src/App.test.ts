import { describe, expect, test } from "vitest";
import { DEFAULT_APP_VIEW } from "./App";

describe("app initial workspace", () => {
  test("opens on the radar scan view by default", () => {
    expect(DEFAULT_APP_VIEW).toBe("radar");
  });
});
