import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPatch, onRequestPost } from "./threads";

const mocks = vi.hoisted(() => ({
  createAssistantThread: vi.fn(),
  requireAdminSession: vi.fn(async () => ({
    response: null,
    session: { userId: "user-1" },
  })),
  updateAssistantThreadTitle: vi.fn(),
}));

vi.mock("../../_shared/assistant-db", () => ({
  createAssistantThread: mocks.createAssistantThread,
  deleteAssistantThread: vi.fn(),
  ensureAssistantSchema: vi.fn(),
  getOrCreateDefaultThread: vi.fn(),
  listAssistantThreads: vi.fn(),
  requireAdminSession: mocks.requireAdminSession,
  updateAssistantThreadTitle: mocks.updateAssistantThreadTitle,
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
    mocks.updateAssistantThreadTitle.mockReset();
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

  test("bounds new assistant thread titles before saving", async () => {
    mocks.createAssistantThread.mockResolvedValue({
      id: "thread-1",
      title: "投研".repeat(40),
      summary: "",
      updated_at: "2026-07-11T00:00:00.000Z",
    });

    const response = await onRequestPost(context({ title: `  ${"投研".repeat(80)}  ` }));

    expect(response.status).toBe(200);
    expect(mocks.createAssistantThread.mock.calls[0]?.[2]).toBe("投研".repeat(40));
  });

  test("rejects malformed assistant thread rename titles before updating", async () => {
    const response = await onRequestPatch(context({ title: 123 }, "PATCH", "?threadId=thread-1"));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Missing title.");
    expect(mocks.updateAssistantThreadTitle).not.toHaveBeenCalled();
  });

  test("bounds renamed assistant thread titles before updating", async () => {
    const response = await onRequestPatch(context({ title: "复盘".repeat(90) }, "PATCH", "?threadId=thread-1"));

    expect(response.status).toBe(200);
    expect(mocks.updateAssistantThreadTitle).toHaveBeenCalledWith({}, "thread-1", "user-1", "复盘".repeat(40));
  });
});

function context(body: unknown, method = "POST", search = "") {
  return {
    request: new Request(`https://alpha.custard.top/api/assistant/threads${search}`, {
      method,
      headers: { "content-type": "application/json", cookie: "cstd_alpha_session=session-1.token" },
      body: JSON.stringify(body),
    }),
    env: {
      AUTH_SECRET: "test-secret",
      REPORT_LIBRARY_DB: {},
    },
  } as unknown as Parameters<typeof onRequestPost>[0] & Parameters<typeof onRequestPatch>[0];
}
