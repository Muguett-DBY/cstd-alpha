import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./[id]";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(async () => ({
    response: null,
    session: { userId: "user-1" },
  })),
}));

vi.mock("../../../_shared/assistant-db", () => ({
  requireAdminSession: mocks.requireAdminSession,
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
}));

describe("/api/assistant/code-result/[id]", () => {
  beforeEach(() => {
    mocks.requireAdminSession.mockClear();
  });

  test("rejects non-string code result payloads before storing them", async () => {
    const cache = { put: vi.fn() };

    const response = await onRequestPost(context({ output: { value: 1 } }, cache));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("代码结果格式无效。");
    expect(cache.put).not.toHaveBeenCalled();
  });
});

function context(body: unknown, cache: { put: ReturnType<typeof vi.fn> }) {
  return {
    request: new Request("https://alpha.custard.top/api/assistant/code-result/exec-1", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "cstd_alpha_session=session-1.token" },
      body: JSON.stringify(body),
    }),
    env: {
      AUTH_SECRET: "test-secret",
      REPORT_CACHE: cache,
    },
    params: {
      id: "exec-1",
    },
  } as unknown as Parameters<typeof onRequestPost>[0];
}
