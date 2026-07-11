import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./delete";

const mocks = vi.hoisted(() => ({
  deleteResearchItems: vi.fn(),
  requireAdminSession: vi.fn(async () => ({
    response: null,
    session: { userId: "user-1" },
  })),
}));

vi.mock("../../_shared/assistant-db", () => ({
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("../../_shared/research-workbench-db", () => ({
  deleteResearchItems: mocks.deleteResearchItems,
}));

describe("/api/research-items/delete", () => {
  beforeEach(() => {
    mocks.deleteResearchItems.mockReset();
    mocks.requireAdminSession.mockClear();
  });

  test("rejects invalid ids before deleting research items", async () => {
    const response = await onRequestPost(context({
      ids: ["research-1", 123, " "],
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("删除目标数据无效。");
    expect(mocks.deleteResearchItems).not.toHaveBeenCalled();
  });
});

function context(body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/research-items/delete", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "cstd_alpha_session=session-1.token" },
      body: JSON.stringify(body),
    }),
    env: {
      AUTH_SECRET: "test-secret",
      REPORT_LIBRARY_DB: {},
    },
  } as unknown as Parameters<typeof onRequestPost>[0];
}
