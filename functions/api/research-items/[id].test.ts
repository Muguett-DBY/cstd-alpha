import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPatch } from "./[id]";

const mocks = vi.hoisted(() => ({
  confirmResearchStage: vi.fn(),
  requireAdminSession: vi.fn(async () => ({
    response: null,
    session: { userId: "user-1" },
  })),
}));

vi.mock("../../_shared/assistant-db", () => ({
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("../../_shared/research-workbench-db", () => ({
  confirmResearchStage: mocks.confirmResearchStage,
}));

describe("/api/research-items/[id]", () => {
  beforeEach(() => {
    mocks.confirmResearchStage.mockReset();
    mocks.requireAdminSession.mockClear();
  });

  test("rejects invalid stages before updating a research item", async () => {
    const response = await onRequestPatch(context({
      stage: "done",
      sortOrder: 1,
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("研究阶段数据无效。");
    expect(mocks.confirmResearchStage).not.toHaveBeenCalled();
  });
});

function context(body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/research-items/research-1", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: "cstd_alpha_session=session-1.token" },
      body: JSON.stringify(body),
    }),
    env: {
      AUTH_SECRET: "test-secret",
      REPORT_LIBRARY_DB: {},
    },
    params: {
      id: "research-1",
    },
  } as unknown as Parameters<typeof onRequestPatch>[0];
}
