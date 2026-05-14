import { describe, expect, test } from "vitest";
import { createSessionCookie, readSessionCookie, verifySessionCookie } from "./auth";

describe("session auth", () => {
  test("creates and verifies signed session cookies", async () => {
    const cookie = await createSessionCookie("secret", "2026-05-10T00:00:00.000Z");

    await expect(verifySessionCookie(cookie, "secret")).resolves.toBe(true);
    await expect(verifySessionCookie(cookie, "wrong")).resolves.toBe(false);
    await expect(readSessionCookie(cookie, "secret")).resolves.toMatchObject({ username: "默认用户", userKey: "default" });
  });

  test("stores the selected username in the signed session", async () => {
    const cookie = await createSessionCookie("secret", "2026-05-10T00:00:00.000Z", { username: "Alice Chen" });

    await expect(readSessionCookie(cookie, "secret")).resolves.toMatchObject({ username: "Alice Chen", userKey: "alice-chen" });
  });

  test("rejects malformed cookies", async () => {
    await expect(verifySessionCookie("cstd_alpha_session=bad", "secret")).resolves.toBe(false);
  });
});
