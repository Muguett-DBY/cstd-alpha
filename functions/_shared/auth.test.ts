import { describe, expect, test, vi } from "vitest";
import { cleanupExpiredSessions, createPasswordHash, createSessionCookie, hashSessionToken, shouldCleanupLoginAttempts, verifyPasswordHash } from "./auth";

describe("fixed-account auth primitives", () => {
  test("hashes passwords with a salt and verifies only the original password", async () => {
    const first = await createPasswordHash("correct horse battery staple", "fixed-salt-for-test");
    const second = await createPasswordHash("correct horse battery staple", "another-fixed-salt");

    expect(first).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(first).not.toBe(second);
    await expect(verifyPasswordHash("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyPasswordHash("wrong password", first)).resolves.toBe(false);
  });

  test("rejects malformed or excessive password hash work factors without deriving a key", async () => {
    await expect(verifyPasswordHash("password", "pbkdf2-sha256$0$salt$digest")).resolves.toBe(false);
    await expect(verifyPasswordHash("password", "pbkdf2-sha256$600000$salt$digest")).resolves.toBe(false);
    await expect(verifyPasswordHash("password", "pbkdf2-sha256$2000001$salt$digest")).resolves.toBe(false);
  });

  test("stores only a hash of the session token", async () => {
    const token = "session-secret-token";
    const hash = await hashSessionToken(token);

    expect(hash).not.toContain(token);
    await expect(hashSessionToken(token)).resolves.toBe(hash);
    await expect(hashSessionToken("other-token")).resolves.not.toBe(hash);
  });

  test("can create a local development session cookie without Secure", () => {
    expect(createSessionCookie("session-id", "token", false)).not.toContain(" Secure;");
    expect(createSessionCookie("session-id", "token")).toContain(" Secure;");
  });

  test("cleans expired sessions by timestamp", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    await cleanupExpiredSessions(db, new Date("2026-05-16T00:00:00.000Z"));

    expect(prepare).toHaveBeenCalledWith("DELETE FROM auth_sessions WHERE expires_at <= ?1");
    expect(bind).toHaveBeenCalledWith("2026-05-16T00:00:00.000Z");
    expect(run).toHaveBeenCalled();
  });

  test("shouldCleanupLoginAttempts returns true every 20th call", () => {
    const results: boolean[] = [];
    for (let i = 0; i < 25; i++) results.push(shouldCleanupLoginAttempts());
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });
});
