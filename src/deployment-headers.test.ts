import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Cloudflare Pages headers", () => {
  test("sets security headers and immutable caching for fingerprinted assets", () => {
    const headers = readFileSync("public/_headers", "utf8");
    const csp = headers.match(/Content-Security-Policy: (.+)/)?.[1] ?? "";
    const inlineThemeScript = readFileSync("index.html", "utf8").match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const inlineThemeHash = `sha256-${createHash("sha256").update(inlineThemeScript).digest("base64")}`;

    expect(headers).toContain("/*");
    expect(headers).toContain("Strict-Transport-Security: max-age=31536000; includeSubDomains");
    expect(headers).toContain("X-Frame-Options: DENY");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toContain("Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()");
    expect(headers).toContain("Cross-Origin-Opener-Policy: same-origin");
    expect(headers).toContain("Content-Security-Policy:");
    expect(headers).toContain("default-src 'self'");
    expect(headers).toContain("script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'");
    expect(csp).toContain(`'${inlineThemeHash}'`);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(headers).toContain("connect-src 'self' https://cdn.jsdelivr.net");
    expect(headers).toContain("object-src 'none'");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toMatch(/\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/s);
  });
});
