import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./threads";

const mocks = vi.hoisted(() => ({
  createAssistantThread: vi.fn(),
  requireAdminSession: vi.fn(async () => ({
    response: null,
    session: { userId: "user-1" },
  })),
}));

vi.mock("../../_shared/assistant-db", () => ({
  createAssistantThread: mocks.createAssistantThread,
  deleteAssistantThread: vi.fn(),
  ensureAssistantSchema: vi.fn(),
  getOrCreateDefaultThread: vi.fn(),
  listAssistantThreads: vi.fn(),
  requireAdminSession: mocks.requireAdminSession,
  updateAssistantThreadTitle: vi.fn(),
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
}));

describe("/api/assistant/threads", () => {
  beforeEach(() => {
    mocks.createAssistantThread.mockReset();
    mocks.requireAdminSession.mockClear();
  });

  test("trims a new assistant thread title before saving", async () => {
    mocks.createAssistantThread.mockResolvedValue({
      id: "thread-1",
      title: "投研计划",
      summary: "",
      updated_at: "2026-07-11T00:00:00.000Z",
    });

    const response = await onRequestPost(context({ title: "  投研计划  " }));

    expect(response.status).toBe(200);
    expect(mocks.createAssistantThread).toHaveBeenCalledWith({}, "user-1", "投研计划");
  });
});

function context(body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/assistant/threads", {
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
