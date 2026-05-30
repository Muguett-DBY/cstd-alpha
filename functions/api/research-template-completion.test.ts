import { describe, expect, test } from "vitest";
import { buildTemplateCompletionMessages, buildTemplateCompletionRequest, normalizeTemplateCompletion } from "./research-template-completion";

describe("research template completion", () => {
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
});
