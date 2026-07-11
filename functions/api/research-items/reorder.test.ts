import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./reorder";

const mocks = vi.hoisted(() => ({
  reorderResearchItems: vi.fn(),
  requireAdminSession: vi.fn(async () => ({
    response: null,
    session: { userId: "user-1" },
  })),
}));

vi.mock("../../_shared/assistant-db", () => ({
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("../../_shared/research-workbench-db", () => ({
  reorderResearchItems: mocks.reorderResearchItems,
}));

describe("/api/research-items/reorder", () => {
  beforeEach(() => {
    mocks.reorderResearchItems.mockReset();
    mocks.requireAdminSession.mockClear();
  });

  test("rejects updates with an invalid research stage before writing", async () => {
    const response = await onRequestPost(context({
      updates: [{ id: "research-1", stage: "done", sortOrder: 1 }],
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("研究项排序数据无效。");
    expect(mocks.reorderResearchItems).not.toHaveBeenCalled();
  });

  test("rejects updates with a non-finite sort order before writing", async () => {
    const response = await onRequestPost(context({
      updates: [{ id: "research-1", stage: "screening", sortOrder: Number.NaN }],
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("研究项排序数据无效。");
    expect(mocks.reorderResearchItems).not.toHaveBeenCalled();
  });
});

function context(body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/research-items/reorder", {
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
