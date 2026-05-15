import { describe, expect, test } from "vitest";
import { createPasswordHash, hashSessionToken, verifyPasswordHash } from "./auth";

describe("fixed-account auth primitives", () => {
  test("hashes passwords with a salt and verifies only the original password", async () => {
    const first = await createPasswordHash("correct horse battery staple", "fixed-salt-for-test");
    const second = await createPasswordHash("correct horse battery staple", "another-fixed-salt");

    expect(first).toMatch(/^pbkdf2-sha256\$\d+\$/);
    expect(first).not.toBe(second);
    await expect(verifyPasswordHash("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyPasswordHash("wrong password", first)).resolves.toBe(false);
  });

  test("stores only a hash of the session token", async () => {
    const token = "session-secret-token";
    const hash = await hashSessionToken(token);

    expect(hash).not.toContain(token);
    await expect(hashSessionToken(token)).resolves.toBe(hash);
    await expect(hashSessionToken("other-token")).resolves.not.toBe(hash);
  });
});
