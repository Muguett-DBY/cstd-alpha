import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildTemplateCompletionMessages, buildTemplateCompletionRequest, normalizeTemplateCompletion, onRequestPost } from "./research-template-completion";
import { requireUserSession } from "../_shared/user-research-db";

vi.mock("../_shared/user-research-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/user-research-db")>();
  return {
    ...actual,
    requireUserSession: vi.fn(),
  };
});

describe("research template completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("builds a max-reasoning JSON request for the DeepSeek template completion model", () => {
    const signal = new AbortController().signal;
    const messages = buildTemplateCompletionMessages({
      title: "自定义模板12",
      shortTitle: "自定义",
      focus: "",
      prompt: "",
      fullPrompt: "第12模板\n\n实体经营者思维。",
    });

    const request = buildTemplateCompletionRequest({ model: "deepseek-v4-flash", apiKey: "paid-key", isFree: false }, messages, signal);
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning_effort: "max",
      thinking: { type: "enabled" },
      response_format: { type: "json_object" },
      stream: false,
    });
    expect(body.reasoning_effort).toBe("max");
    expect(JSON.stringify(body.messages)).toContain("实体经营者思维");
    expect(JSON.stringify(body.messages)).toContain("sectionRequirements");
    expect(JSON.stringify(body.messages)).toContain("每个模板项");
  });

  test("normalizes completion JSON into all editable template fields", () => {
    expect(
      normalizeTemplateCompletion({
        title: "模板12：实体经营者思维公司分析",
        shortTitle: "实体经营",
        focus: "把投资视为低成本开公司，检查产业、商业模式、团队和估值。",
        prompt: "按实体经营者思维模板输出公司分析。",
        fullPrompt: "# 模板12：实体经营者思维公司分析\n\n请分析（      ）公司。",
        sectionRequirements: [
          { id: "business-model", title: "商业模式", minChars: 160, requiredPoints: ["结论", "证据依据", "反证条件", "跟踪指标"] },
          { id: "capital-discipline", title: "资本配置纪律", minChars: 180, requiredPoints: ["结论", "证据依据", "反证条件", "跟踪指标"] },
        ],
      }),
    ).toEqual({
      title: "模板12：实体经营者思维公司分析",
      shortTitle: "实体经营",
      focus: "把投资视为低成本开公司，检查产业、商业模式、团队和估值。",
      prompt: "按实体经营者思维模板输出公司分析。",
      fullPrompt: "# 模板12：实体经营者思维公司分析\n\n请分析（      ）公司。",
      sectionRequirements: [
        { id: "business-model", title: "商业模式", minChars: 160, requiredPoints: ["结论", "证据依据", "反证条件", "跟踪指标"] },
        { id: "capital-discipline", title: "资本配置纪律", minChars: 180, requiredPoints: ["结论", "证据依据", "反证条件", "跟踪指标"] },
      ],
    });
  });

  test("rejects oversized template drafts before calling the model", async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      userId: "user-1",
      username: "admin",
      displayName: "Admin",
      role: "admin",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: "模板",
        shortTitle: "模板",
        focus: "说明",
        prompt: "提示",
        fullPrompt: "完整模板",
        sectionRequirements: [{ id: "summary", title: "结论", minChars: 180, requiredPoints: ["结论"] }],
      }) } }],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.test/api/research-template-completion", {
        method: "POST",
        body: JSON.stringify({ draft: { fullPrompt: "x".repeat(12_001) } }),
      }),
      env: { AUTH_SECRET: "secret", OPENCODE_GO_API_KEY: "paid-key" },
    } as Parameters<typeof onRequestPost>[0]);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("模板正文过长") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects oversized auxiliary draft text before calling the model", async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      userId: "user-1",
      username: "admin",
      displayName: "Admin",
      role: "admin",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: "模板",
        shortTitle: "模板",
        focus: "说明",
        prompt: "提示",
        fullPrompt: "完整模板",
        sectionRequirements: [{ id: "summary", title: "结论", minChars: 180, requiredPoints: ["结论"] }],
      }) } }],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.test/api/research-template-completion", {
        method: "POST",
        body: JSON.stringify({
          draft: {
            prompt: "x".repeat(16_001),
            fullPrompt: "正常模板正文",
          },
        }),
      }),
      env: { AUTH_SECRET: "secret", OPENCODE_GO_API_KEY: "paid-key" },
    } as Parameters<typeof onRequestPost>[0]);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("模板草稿过长") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects oversized section requirement draft text before calling the model", async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      userId: "user-1",
      username: "admin",
      displayName: "Admin",
      role: "admin",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: "模板",
        shortTitle: "模板",
        focus: "说明",
        prompt: "提示",
        fullPrompt: "完整模板",
        sectionRequirements: [{ id: "summary", title: "结论", minChars: 180, requiredPoints: ["结论"] }],
      }) } }],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestPost({
      request: new Request("https://example.test/api/research-template-completion", {
        method: "POST",
        body: JSON.stringify({
          draft: {
            fullPrompt: `正常模板正文${"x".repeat(5_000)}`,
            sectionRequirements: Array.from({ length: 24 }, (_, index) => ({
              id: `section-${index + 1}`,
              title: `第 ${index + 1} 项`,
              minChars: 180,
              requiredPoints: Array.from({ length: 8 }, (__, pointIndex) => `检查点-${index + 1}-${pointIndex + 1}-${"x".repeat(120)}`),
            })),
          },
        }),
      }),
      env: { AUTH_SECRET: "secret", OPENCODE_GO_API_KEY: "paid-key" },
    } as Parameters<typeof onRequestPost>[0]);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("模板草稿过长") });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
