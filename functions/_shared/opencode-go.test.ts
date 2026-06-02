import { describe, expect, test } from "vitest";
import { buildDeepSeekFallbackRoutes } from "./opencode-go";

describe("buildDeepSeekFallbackRoutes", () => {
  test("orders OpenCode Go first, then free Zen", () => {
    const routes = buildDeepSeekFallbackRoutes({
      OPENCODE_GO_API_KEY: "go-key",
      OPENCODE_ZEN_API_KEY: "zen-key",
    });

    expect(routes.map((route) => ({ model: route.model, url: route.url, isFree: route.isFree, provider: route.provider }))).toEqual([
      {
        model: "deepseek-v4-flash",
        url: "https://opencode.ai/zen/go/v1/chat/completions",
        isFree: false,
        provider: "opencode-go",
      },
      {
        model: "deepseek-v4-flash-free",
        url: "https://opencode.ai/zen/v1/chat/completions",
        isFree: true,
        provider: "opencode-zen-free",
      },
    ]);
  });

  test("ignores the legacy generic OpenCode key", () => {
    const legacyKeyName = ["OPENCODE", "API", "KEY"].join("_");
    const routes = buildDeepSeekFallbackRoutes({
      [legacyKeyName]: "legacy-key",
      OPENCODE_ZEN_API_KEY: "zen-key",
    } as never);

    expect(routes.map((route) => route.provider)).toEqual(["opencode-zen-free"]);
    expect(routes[0]?.apiKey).toBe("zen-key");
  });

  test("keeps the free route even when paid keys are missing", () => {
    const routes = buildDeepSeekFallbackRoutes({});

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      model: "deepseek-v4-flash-free",
      isFree: true,
      provider: "opencode-zen-free",
    });
  });
});
