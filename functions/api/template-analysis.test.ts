import { afterEach, describe, expect, test, vi } from "vitest";
import { FULL_ANALYSIS_TEMPLATE_ID, RESEARCH_TEMPLATES } from "../../src/shared/user-research";
import {
  buildChildTemplateReportsForPrompt,
  isTemplateAnalysisCacheReusable,
  isUsableTemplateAnalysisCache,
  normalizeGeneratedAnalysis,
  requestTemplateReport,
  runFullTemplateChildrenCacheAware,
  shouldStartFullAnalysis,
  templateModelRoutes,
  templateReasoningEffort,
} from "./template-analysis";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runFullTemplateChildrenCacheAware", () => {
  test("reuses cached templates and runs uncached jobs sequentially to stay under Worker subrequest limits", async () => {
    const activeTemplates = RESEARCH_TEMPLATES.slice(0, 3);
    const cachedIds = new Set([activeTemplates[0].id]);
    const started: string[] = [];
    const released: string[] = [];
    const releaseJobs = new Map<string, () => void>();

    const resultPromise = runFullTemplateChildrenCacheAware({
      templates: activeTemplates,
      readCached: async (template) => (cachedIds.has(template.id) ? `cached:${template.id}` : null),
      runUncached: async (template) => {
        started.push(template.id);
        await new Promise<void>((resolve) => releaseJobs.set(template.id, resolve));
        released.push(template.id);
        return `fresh:${template.id}`;
      },
    });

    await nextTick();

    expect(started).toEqual([activeTemplates[1].id]);
    releaseJobs.get(activeTemplates[1].id)?.();
    await nextTick();

    expect(started).toEqual([activeTemplates[1].id, activeTemplates[2].id]);
    expect(released).toEqual([activeTemplates[1].id]);
    releaseJobs.get(activeTemplates[2].id)?.();

    expect(started).toEqual(activeTemplates.filter((template) => !cachedIds.has(template.id)).map((template) => template.id));
    for (const template of activeTemplates) releaseJobs.get(template.id)?.();

    await expect(resultPromise).resolves.toEqual(
      activeTemplates.map((template) => (cachedIds.has(template.id) ? `cached:${template.id}` : `fresh:${template.id}`)),
    );
  });
});

describe("shouldStartFullAnalysis", () => {
  test("does not duplicate a running full analysis unless forced", () => {
    expect(shouldStartFullAnalysis(null, false)).toBe(true);
    expect(shouldStartFullAnalysis({ status: "running" } as Parameters<typeof shouldStartFullAnalysis>[0], false)).toBe(false);
    expect(shouldStartFullAnalysis({ status: "running" } as Parameters<typeof shouldStartFullAnalysis>[0], true)).toBe(true);
    expect(shouldStartFullAnalysis({ status: "failed_retryable" } as Parameters<typeof shouldStartFullAnalysis>[0], false)).toBe(true);
  });
});

describe("templateReasoningEffort", () => {
  test("uses high for single templates and max only for full synthesis", () => {
    expect(templateReasoningEffort(RESEARCH_TEMPLATES[0].id)).toBe("high");
    expect(templateReasoningEffort(FULL_ANALYSIS_TEMPLATE_ID)).toBe("max");
  });
});

describe("buildChildTemplateReportsForPrompt", () => {
  test("includes bounded child markdown excerpts for full synthesis", () => {
    const reports = buildChildTemplateReportsForPrompt([
      {
        templateTitle: "模板一",
        summary: "摘要",
        verdict: "观察",
        score: 70,
        keyPoints: ["要点"],
        riskFlags: ["风险"],
        followUps: ["跟踪"],
        markdown: "A".repeat(8000),
      } as Parameters<typeof buildChildTemplateReportsForPrompt>[0][number],
    ]);

    expect(reports[0].markdownChars).toBe(8000);
    expect(reports[0].markdownExcerpt).toContain("后文因上下文长度限制截断");
    expect((reports[0].markdownExcerpt ?? "").length).toBeLessThanOrEqual(7050);
  });
});

describe("isUsableTemplateAnalysisCache", () => {
  test("reuses completed cached reports even when the free model returned short markdown", () => {
    const base = {
      templateId: RESEARCH_TEMPLATES[0].id,
      status: "completed",
      objectKey: "user-research/v1/u/w/template.md",
      markdown: "深度报告正文".repeat(1200),
    } as Parameters<typeof isUsableTemplateAnalysisCache>[0];

    expect(isUsableTemplateAnalysisCache(base)).toBe(true);
    expect(isUsableTemplateAnalysisCache({ ...base, markdown: "太短" })).toBe(true);
    expect(isUsableTemplateAnalysisCache({ ...base, objectKey: undefined })).toBe(false);
    expect(isUsableTemplateAnalysisCache({ ...base, status: "running" })).toBe(false);
  });
});

describe("template model routing", () => {
  test("uses DeepSeek paid model first when a paid key exists", () => {
    const routes = templateModelRoutes("paid-key", true);

    expect(routes[0]).toMatchObject({ model: "deepseek-v4-flash", isFree: false });
    expect(routes.some((route) => route.isFree)).toBe(false);
  });

  test("calls DeepSeek directly for template reports", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                title: "短报告",
                score: 60,
                verdict: "观察",
                summary: "DeepSeek 返回模板分析。",
                keyPoints: ["要点1", "要点2", "要点3", "要点4", "要点5"],
                riskFlags: ["风险1", "风险2", "风险3", "风险4", "风险5"],
                followUps: ["跟踪1", "跟踪2", "跟踪3", "跟踪4", "跟踪5"],
                markdown: `## 深度报告\nDeepSeek 直接生成模板分析。\n${"证据充分的模板分析正文。".repeat(320)}`,
              }),
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const generated = await requestTemplateReport(
      { DEEPSEEK_API_KEY: "paid-key", REPORT_LIBRARY_DB: {} as D1Database, REPORT_LIBRARY_BUCKET: {} as R2Bucket },
      watchlistRow(),
      evidenceBundle(),
      RESEARCH_TEMPLATES[0],
      [],
    );

    expect(generated.markdown).toContain("DeepSeek 直接生成");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.deepseek.com/chat/completions");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning_effort).toBe("high");
  });

  test("expands short completed template reports once with high reasoning", async () => {
    const expandedMarkdown = `## 扩写后的深度报告\n${"扩写后补足证据链、估值框架、反证条件和跟踪指标。".repeat(180)}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  title: "短报告",
                  score: 58,
                  verdict: "观察",
                  summary: "模型返回了可解析但过短的模板分析。",
                  keyPoints: ["要点1", "要点2", "要点3", "要点4", "要点5"],
                  riskFlags: ["风险1", "风险2", "风险3", "风险4", "风险5"],
                  followUps: ["跟踪1", "跟踪2", "跟踪3", "跟踪4", "跟踪5"],
                  markdown: "## 短报告\n内容太薄。",
                }),
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  title: "扩写成功报告",
                  score: 66,
                  verdict: "观察",
                  summary: "第二次基于草稿扩写后返回了更完整的模板分析。",
                  keyPoints: ["要点1", "要点2", "要点3", "要点4", "要点5"],
                  riskFlags: ["风险1", "风险2", "风险3", "风险4", "风险5"],
                  followUps: ["跟踪1", "跟踪2", "跟踪3", "跟踪4", "跟踪5"],
                  markdown: expandedMarkdown,
                }),
              },
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const generated = await requestTemplateReport(
      { DEEPSEEK_API_KEY: "paid-key", REPORT_LIBRARY_DB: {} as D1Database, REPORT_LIBRARY_BUCKET: {} as R2Bucket },
      watchlistRow(),
      evidenceBundle(),
      RESEARCH_TEMPLATES[0],
      [],
    );

    expect(generated.markdown).toBe(expandedMarkdown);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.reasoning_effort).toBe("high");
    expect(secondBody.reasoning_effort).toBe("high");
    expect(secondBody.messages[2].content).toContain("上一次 Markdown 正文过短");
  });

  test("retries with compact high reasoning when high reasoning returns no final content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: "length",
              message: { content: "" },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  title: "重试成功报告",
                  score: 72,
                  verdict: "观察",
                  summary: "High 思考耗尽输出后，紧凑 high 模式成功返回完整模板分析。",
                  keyPoints: ["要点1", "要点2", "要点3", "要点4", "要点5"],
                  riskFlags: ["风险1", "风险2", "风险3", "风险4", "风险5"],
                  followUps: ["跟踪1", "跟踪2", "跟踪3", "跟踪4", "跟踪5"],
                  markdown: `## 深度报告\n紧凑 high 模式返回完整 Markdown。\n${"救援模式补足证据、判断、反证和跟踪指标。".repeat(220)}`,
                }),
              },
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const generated = await requestTemplateReport(
      { DEEPSEEK_API_KEY: "paid-key", REPORT_LIBRARY_DB: {} as D1Database, REPORT_LIBRARY_BUCKET: {} as R2Bucket },
      watchlistRow(),
      evidenceBundle(),
      RESEARCH_TEMPLATES[9],
      [],
    );

    expect(generated.markdown).toContain("紧凑 high 模式");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.reasoning_effort).toBe("high");
    expect(secondBody.reasoning_effort).toBe("high");
    expect(secondBody.messages[2].content).toContain("救援模式");
    expect(secondBody.messages[0].content.length).toBeLessThan(firstBody.messages[0].content.length);
  });

  test("adds AnySearch supplemental evidence to template prompts when configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              title: "贵州茅台 渠道库存边际改善",
              url: "https://example.com/maotai-channel",
              description: "渠道库存和批价变化需要跟踪。",
              content: "公开信息显示渠道库存边际改善，但批价仍需交叉验证。",
              source: "news",
              quality_score: 0.9,
              published_at: "2026-05-18T00:00:00Z",
            },
          ],
          metadata: { request_id: "req_template", cached: true },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              title: "白酒行业批价和动销分化",
              url: "https://example.com/baijiu-industry",
              description: "行业批价、库存和竞争格局出现分化。",
              content: "高端白酒渠道动销需要结合批价和库存验证。",
              source: "data",
              quality_score: 0.86,
              published_at: "2026-05-18T00:00:00Z",
            },
          ],
          metadata: { request_id: "req_template_industry", cached: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              title: "贵州茅台 风险事件和监管跟踪",
              url: "https://example.com/maotai-risk",
              description: "负面舆情和监管风险需要持续跟踪。",
              content: "市场关注渠道库存、价格体系和监管环境变化。",
              source: "doc",
              quality_score: 0.84,
              published_at: "2026-05-18T00:00:00Z",
            },
          ],
          metadata: { request_id: "req_template_risk", cached: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  title: "补充搜索报告",
                  score: 66,
                  verdict: "观察",
                  summary: "已纳入外部搜索证据。",
                  keyPoints: ["要点1", "要点2", "要点3", "要点4", "要点5"],
                  riskFlags: ["风险1", "风险2", "风险3", "风险4", "风险5"],
                  followUps: ["跟踪1", "跟踪2", "跟踪3", "跟踪4", "跟踪5"],
                  markdown: `## 报告\n已纳入 AnySearch 外部搜索证据。\n${"结合外部搜索证据、公司证据包、风险条件和后续跟踪指标展开分析。".repeat(180)}`,
                }),
              },
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await requestTemplateReport(
      { ANYSEARCH_API_KEY: "any-key", DEEPSEEK_API_KEY: "paid-key", REPORT_LIBRARY_DB: {} as D1Database, REPORT_LIBRARY_BUCKET: {} as R2Bucket },
      watchlistRow(),
      evidenceBundle(),
      RESEARCH_TEMPLATES[0],
      [],
    );

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anysearch.com/v1/search");
    expect(fetchMock.mock.calls[0][1].headers).toHaveProperty("authorization", "Bearer any-key");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.anysearch.com/v1/search");
    expect(fetchMock.mock.calls[2][0]).toBe("https://api.anysearch.com/v1/search");
    const anySearchBodies = fetchMock.mock.calls.slice(0, 3).map((call) => JSON.parse(call[1].body));
    expect(anySearchBodies.map((body) => body.query).join("\n")).toContain("最新公告");
    expect(anySearchBodies.map((body) => body.query).join("\n")).toContain("所属行业");
    expect(anySearchBodies.map((body) => body.query).join("\n")).toContain("负面");
    expect(anySearchBodies.every((body) => Array.isArray(body.tags) && body.tags.length > 0)).toBe(true);
    const modelBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    const stablePayload = JSON.parse(modelBody.messages[1].content);
    const volatilePayload = JSON.parse(modelBody.messages[2].content);
    expect(JSON.stringify(stablePayload.publicEvidence)).toContain("AnySearch 外部搜索");
    expect(JSON.stringify(stablePayload.publicEvidence)).toContain("渠道库存边际改善");
    expect(JSON.stringify(stablePayload.publicEvidence)).toContain("白酒行业批价");
    expect(JSON.stringify(stablePayload.publicEvidence)).toContain("监管跟踪");
    expect(JSON.stringify(stablePayload)).not.toContain("fullPrompt");
    expect(volatilePayload.template.fullPrompt).toBe(RESEARCH_TEMPLATES[0].fullPrompt);
    expect(modelBody.messages[1].content.indexOf("publicEvidence")).toBeGreaterThan(-1);
    expect(JSON.stringify(modelBody).indexOf("publicEvidence")).toBeLessThan(JSON.stringify(modelBody).indexOf("fullPrompt"));
  });
});

describe("template evidence hash cache", () => {
  test("reuses completed reports only when template and evidence fingerprints match", () => {
    const row = {
      status: "completed",
      object_key: "user-research/v1/u/w/template.md",
      template_hash: "template-a",
      evidence_hash: "evidence-a",
    };

    expect(isTemplateAnalysisCacheReusable(row, "template-a", "evidence-a", false)).toBe(true);
    expect(isTemplateAnalysisCacheReusable(row, "template-a", "evidence-b", false)).toBe(false);
    expect(isTemplateAnalysisCacheReusable(row, "template-b", "evidence-a", false)).toBe(false);
    expect(isTemplateAnalysisCacheReusable(row, "template-a", "evidence-a", true)).toBe(false);
  });
});

describe("normalizeGeneratedAnalysis score discipline", () => {
  test("caps high scores from custom templates when the report identifies hard red flags", () => {
    const analysis = normalizeGeneratedAnalysis(
      {
        title: "差公司模板报告",
        score: 92,
        verdict: "买入",
        summary: "公司处于行业衰退期，主营收入持续下滑，经营现金流为负，负债率高企，治理混乱。",
        keyPoints: ["估值看似便宜"],
        riskFlags: ["行业衰退", "经营现金流为负", "负债率高企", "治理混乱", "明显高估"],
        followUps: ["复核现金流"],
        markdown:
          "## 结论\n公司处于行业衰退期，主营收入持续下滑，经营现金流为负，负债率高企，治理混乱，明显不适合长期股权投资。",
      },
      customTemplate(),
    );

    expect(analysis.score).toBeLessThanOrEqual(49);
    expect(analysis.verdict).toContain("回避");
    expect(analysis.riskFlags).toContain("后端保守评分约束：报告识别到重大经营、财务、治理、估值或产业红线，已限制模板总分。");
  });

  test("caps top-level scores that are far above the markdown item-score average", () => {
    const analysis = normalizeGeneratedAnalysis(
      {
        title: "分项偏弱模板报告",
        score: 88,
        verdict: "持有",
        summary: "分项评分整体偏弱，顶层分数不应明显高于分项平均。",
        keyPoints: ["仍有少量资产价值"],
        riskFlags: ["增长疲弱"],
        followUps: ["跟踪利润修复"],
        markdown: [
          "## 1. 商业模式评估（35分）",
          "## 2. 财务健康度（40分）",
          "## 3. 治理质量（45分）",
          "## 4. 估值安全边际（50分）",
        ].join("\n\n"),
      },
      customTemplate(),
    );

    expect(analysis.score).toBeLessThanOrEqual(48);
    expect(analysis.riskFlags).toContain("后端保守评分约束：顶层分数明显高于正文分项平均，已按分项均值限制总分。");
  });
});

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function customTemplate() {
  return {
    id: "custom-strict-template",
    title: "自定义严格模板",
    shortTitle: "自定义",
    focus: "自定义模板也应继承后端评分约束。",
    prompt: "给出评分。",
    fullPrompt: "请严格评分。",
  };
}

function watchlistRow() {
  return {
    id: "watch-1",
    user_id: "user-a",
    user_key: "user-a",
    company_name: "贵州茅台",
    ticker: "600519",
    market: "SH-A",
    exchange_name: "上海证券交易所",
    listing_place: "沪A",
    market_type: "A股",
    source: "eastmoney",
    added_at: "2026-05-15T00:00:00.000Z",
  };
}

function evidenceBundle() {
  return {
    company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
    retrievedAt: "2026-05-15T00:00:00.000Z",
    evidence: [],
    facts: { quote: { regularMarketPrice: 100 } },
  };
}
