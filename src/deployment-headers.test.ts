import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Cloudflare Pages headers", () => {
  test("sets security headers and immutable caching for fingerprinted assets", () => {
    const headers = readFileSync("public/_headers", "utf8");

    expect(headers).toContain("/*");
    expect(headers).toContain("Strict-Transport-Security: max-age=31536000; includeSubDomains");
    expect(headers).toContain("X-Frame-Options: DENY");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toContain("Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()");
    expect(headers).toContain("Cross-Origin-Opener-Policy: same-origin");
    expect(headers).toMatch(/\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/s);
  });
});
