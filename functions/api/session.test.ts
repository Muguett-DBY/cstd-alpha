import { describe, expect, test } from "vitest";
import { onRequestGet } from "./session";

describe("/api/session", () => {
  test("returns a cache-free anonymous session envelope without logging a browser error", async () => {
    const response = await onRequestGet({
      request: new Request("https://alpha.custard.top/api/session"),
      env: { AUTH_SECRET: "test-secret" },
    } as unknown as Parameters<typeof onRequestGet>[0]);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      authenticated: false,
      user: null,
    });
  });
});
