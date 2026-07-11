import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./valuation-workspace";

const mocks = vi.hoisted(() => ({
  createQuantitativeVersion: vi.fn(),
  readQuantitativeWorkspace: vi.fn(),
  requireAdminSession: vi.fn(async () => ({
    response: null,
    session: { userId: "user-1" },
  })),
}));

vi.mock("../_shared/assistant-db", () => ({
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("../_shared/research-workbench-db", () => ({
  createQuantitativeVersion: mocks.createQuantitativeVersion,
  readQuantitativeWorkspace: mocks.readQuantitativeWorkspace,
}));

describe("/api/valuation-workspace POST", () => {
  beforeEach(() => {
    mocks.createQuantitativeVersion.mockReset();
    mocks.readQuantitativeWorkspace.mockReset();
    mocks.requireAdminSession.mockClear();
  });

  test("rejects malformed save identifiers before reading a workspace", async () => {
    const response = await onRequestPost(context({
      runId: 123,
      parentVersionId: "version-1",
      assumptions: [],
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("估值保存参数不完整。");
    expect(mocks.readQuantitativeWorkspace).not.toHaveBeenCalled();
    expect(mocks.createQuantitativeVersion).not.toHaveBeenCalled();
  });
});

function context(body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/valuation-workspace", {
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
