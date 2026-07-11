import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./valuations";

const mocks = vi.hoisted(() => ({
  createValuationRun: vi.fn(),
  readResearchItemById: vi.fn(),
  requireAdminSession: vi.fn(async () => ({
    response: null,
    session: { userId: "user-1" },
  })),
  queueSend: vi.fn(),
}));

vi.mock("../_shared/assistant-db", () => ({
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("../_shared/research-workbench-db", () => ({
  createValuationRun: mocks.createValuationRun,
  listValuationRuns: vi.fn(),
  readResearchItemById: mocks.readResearchItemById,
  valuationRunToSummary: (run: unknown) => run,
}));

describe("/api/valuations", () => {
  beforeEach(() => {
    mocks.createValuationRun.mockReset();
    mocks.readResearchItemById.mockReset();
    mocks.requireAdminSession.mockClear();
    mocks.queueSend.mockReset();
    mocks.readResearchItemById.mockResolvedValue({
      id: "research-1",
      entityType: "company",
      entityId: "600519",
      title: "贵州茅台",
      subtitle: "A股 沪A",
    });
    mocks.createValuationRun.mockResolvedValue({ id: "run-1", status: "queued" });
  });

  test("rejects malformed valuation object text before reading research items", async () => {
    const response = await onRequestPost(context({
      researchItemId: "research-1",
      entityType: "company",
      entityId: 600519,
      title: "贵州茅台",
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("缺少估值对象。");
    expect(mocks.readResearchItemById).not.toHaveBeenCalled();
    expect(mocks.createValuationRun).not.toHaveBeenCalled();
    expect(mocks.queueSend).not.toHaveBeenCalled();
  });

  test("rejects malformed optional valuation metadata before queueing a run", async () => {
    const response = await onRequestPost(context({
      researchItemId: "research-1",
      entityType: "company",
      entityId: "600519",
      title: "贵州茅台",
      currency: 123,
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("估值对象数据无效。");
    expect(mocks.readResearchItemById).not.toHaveBeenCalled();
    expect(mocks.createValuationRun).not.toHaveBeenCalled();
    expect(mocks.queueSend).not.toHaveBeenCalled();
  });
});

function context(body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/valuations", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "cstd_alpha_session=session-1.token" },
      body: JSON.stringify(body),
    }),
    env: {
      AUTH_SECRET: "test-secret",
      REPORT_LIBRARY_DB: {},
      ASSISTANT_DEEP_RESEARCH_QUEUE: { send: mocks.queueSend },
    },
  } as unknown as Parameters<typeof onRequestPost>[0];
}
