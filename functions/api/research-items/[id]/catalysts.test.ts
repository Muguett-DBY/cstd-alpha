import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPatch } from "./catalysts";

const mocks = vi.hoisted(() => ({
  readResearchItemById: vi.fn(),
  requireAdminSession: vi.fn(async () => ({
    response: null,
    session: { userId: "user-1" },
  })),
  updateResearchCatalystStatus: vi.fn(),
}));

vi.mock("../../../_shared/assistant-db", () => ({
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("../../../_shared/research-workbench-db", () => ({
  readResearchItemById: mocks.readResearchItemById,
  updateResearchCatalystStatus: mocks.updateResearchCatalystStatus,
}));

describe("/api/research-items/[id]/catalysts", () => {
  beforeEach(() => {
    mocks.readResearchItemById.mockReset();
    mocks.requireAdminSession.mockClear();
    mocks.updateResearchCatalystStatus.mockReset();
    mocks.readResearchItemById.mockResolvedValue({ id: "research-1" });
    mocks.updateResearchCatalystStatus.mockResolvedValue({
      id: "cat-1",
      itemId: "research-1",
      title: "订单兑现",
      status: "confirmed",
      evidenceRefs: [],
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    });
  });

  test("rejects malformed catalyst status updates before writing", async () => {
    const response = await onRequestPatch(context({
      catalystId: 123,
      status: "confirmed",
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("跟踪项状态数据无效。");
    expect(mocks.updateResearchCatalystStatus).not.toHaveBeenCalled();
  });
});

function context(body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/research-items/research-1/catalysts", {
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
