import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestGet, onRequestPost } from "./session";

const mocks = vi.hoisted(() => ({
  authenticateUser: vi.fn(),
  checkLoginRateLimit: vi.fn(),
  cleanupOldLoginAttempts: vi.fn(),
  clearSessionCookie: vi.fn(),
  createAuthSession: vi.fn(),
  createUser: vi.fn(),
  ensureAuthSchema: vi.fn(),
  publicUser: vi.fn((session: unknown) => session),
  readSessionCookie: vi.fn(async () => null),
  recordLoginAttempt: vi.fn(),
  revokeSession: vi.fn(),
  shouldCleanupLoginAttempts: vi.fn(() => false),
}));

vi.mock("../_shared/auth", () => mocks);

describe("/api/session", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.publicUser.mockImplementation((session: unknown) => session);
    mocks.readSessionCookie.mockResolvedValue(null);
    mocks.shouldCleanupLoginAttempts.mockReturnValue(false);
  });

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

  test("rejects non-string usernames before rate limiting or authentication", async () => {
    const response = await onRequestPost(context({ username: 123, password: "secret" }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("请输入账号和密码。");
    expect(mocks.ensureAuthSchema).toHaveBeenCalledOnce();
    expect(mocks.checkLoginRateLimit).not.toHaveBeenCalled();
    expect(mocks.authenticateUser).not.toHaveBeenCalled();
  });

  test("rejects non-string passwords before rate limiting or authentication", async () => {
    const response = await onRequestPost(context({ username: "admin", password: 123 }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("请输入账号和密码。");
    expect(mocks.ensureAuthSchema).toHaveBeenCalledOnce();
    expect(mocks.checkLoginRateLimit).not.toHaveBeenCalled();
    expect(mocks.authenticateUser).not.toHaveBeenCalled();
  });
});

function context(body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
      body: JSON.stringify(body),
    }),
    env: {
      AUTH_SECRET: "test-secret",
      REPORT_LIBRARY_DB: {},
    },
  } as unknown as Parameters<typeof onRequestPost>[0];
}
