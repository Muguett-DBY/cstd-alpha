import { describe, expect, test } from "vitest";
import { createSessionCookie, verifySessionCookie } from "./auth";

describe("session auth", () => {
  test("creates and verifies signed session cookies", async () => {
    const cookie = await createSessionCookie("secret", "2026-05-10T00:00:00.000Z");

    await expect(verifySessionCookie(cookie, "secret")).resolves.toBe(true);
    await expect(verifySessionCookie(cookie, "wrong")).resolves.toBe(false);
  });

  test("rejects malformed cookies", async () => {
    await expect(verifySessionCookie("cstd_alpha_session=bad", "secret")).resolves.toBe(false);
  });
});
