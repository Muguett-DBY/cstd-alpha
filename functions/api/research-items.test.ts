import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./research-items";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(async () => ({
    response: null,
    session: { userId: "user-1" },
  })),
  upsertResearchItem: vi.fn(),
}));

vi.mock("../_shared/assistant-db", () => ({
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("../_shared/research-workbench-db", () => ({
  upsertResearchItem: mocks.upsertResearchItem,
}));

describe("/api/research-items", () => {
  beforeEach(() => {
    mocks.requireAdminSession.mockClear();
    mocks.upsertResearchItem.mockReset();
    mocks.upsertResearchItem.mockResolvedValue({
      item: { id: "research-1", title: "贵州茅台", stage: "screening" },
      status: "created",
    });
  });

  test("rejects invalid stages before creating a research item", async () => {
    const response = await onRequestPost(context({
      entityType: "company",
      entityId: "600519",
      title: "贵州茅台",
      stage: "done",
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("研究阶段数据无效。");
    expect(mocks.upsertResearchItem).not.toHaveBeenCalled();
  });

  test("rejects malformed research object text before creating an item", async () => {
    const response = await onRequestPost(context({
      entityType: "company",
      entityId: 600519,
      title: "贵州茅台",
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("缺少研究对象。");
    expect(mocks.upsertResearchItem).not.toHaveBeenCalled();
  });
});

function context(body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/research-items", {
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
