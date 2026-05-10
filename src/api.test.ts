import { afterEach, describe, expect, test, vi } from "vitest";
import { generateReport } from "./api";

describe("API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("treats streamed JSON error payloads as failed report generation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "DeepSeek request failed." }), { status: 200 })),
    );

    await expect(
      generateReport({
        companyName: "Apple Inc.",
        ticker: "AAPL",
        market: "US",
        language: "zh-CN",
      }),
    ).rejects.toThrow("DeepSeek request failed.");
  });
});
