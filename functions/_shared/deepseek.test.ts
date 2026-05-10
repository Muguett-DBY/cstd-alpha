import { describe, expect, test, vi } from "vitest";
import { callDeepSeekReport, MODEL_OUTPUT_LENGTH_MESSAGE } from "./deepseek";
import type { EvidenceBundle } from "./providers";

const evidence: EvidenceBundle = {
  company: { name: "Example Inc.", ticker: "EXM", market: "US" },
  retrievedAt: "2026-05-10T00:00:00.000Z",
  evidence: [],
  facts: { quote: { regularMarketPrice: 10 } },
};

function modelResponse(payload: Record<string, unknown>, finishReason = "stop") {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          finish_reason: finishReason,
          message: { content: JSON.stringify(payload) },
        },
      ],
    }),
  };
}

function reportPayload(overrides: Record<string, unknown> = {}) {
  return {
    company: { name: "Example Inc.", ticker: "EXM", market: "US" },
    asOf: "2026-05-10T00:00:00.000Z",
    conclusion: "观察",
    oneSentence: "A test company.",
    cqs: 60,
    ias: 55,
    moduleScores: [],
    redFlags: [],
    evidence: [],
    sections: {
      companyOverview: "overview",
      industry: "industry",
      businessModel: "model",
      moat: "moat",
      governance: "governance",
      financialQuality: "financials",
      growth: "growth",
      valuation: "valuation",
      risks: "risks",
      finalConclusion: "final",
    },
    disclaimer: "Research only.",
    ...overrides,
  };
}

function narrativePayload() {
  return {
    fullSections: {
      onePageConclusion: "完整一页结论",
      companyOverview: "完整公司概况",
      industryTrack: "完整行业分析",
      businessModel: "完整商业模式",
      moat: "完整护城河",
      governance: "完整治理分析",
      financialQuality: "完整财务分析",
      growthInflection: "完整成长分析",
      valuation: "完整估值分析",
      risks: "完整风险分析",
      finalConclusion: "完整最终结论",
      accountRules: "完整仓位规则",
    },
  };
}

describe("DeepSeek report client", () => {
  test("requests DeepSeek V4 Pro in max thinking mode with JSON output", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(modelResponse(reportPayload())).mockResolvedValueOnce(modelResponse(narrativePayload()));

    await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.reasoning_effort).toBe("max");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  test("throws a user-facing error instead of returning a zero-score report when DeepSeek output is truncated", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: "length", message: { content: "" } }],
      }),
    });

    await expect(callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock })).rejects.toMatchObject({
      message: MODEL_OUTPUT_LENGTH_MESSAGE,
      code: "MODEL_OUTPUT_LENGTH",
    });
  });

  test("combines structured scoring and narrative sections without losing provider company identity", async () => {
    const maotaiEvidence: EvidenceBundle = {
      ...evidence,
      company: { name: "贵州茅台", ticker: "600519", market: "沪A", sector: "AStock" },
      evidence: [
        {
          title: "600519 Eastmoney financial statements",
          source: "Eastmoney",
          url: "https://example.com/600519",
          retrievedAt: "2026-05-10T00:00:00.000Z",
          freshness: "latest-public",
          notes: "ok",
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(modelResponse(reportPayload({ company: { name: "贵州茅台" }, scoreItems20: [] })))
      .mockResolvedValueOnce(modelResponse(narrativePayload()));

    const report = await callDeepSeekReport({ apiKey: "key", evidence: maotaiEvidence, fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(report.company).toMatchObject({ name: "贵州茅台", ticker: "600519", market: "沪A" });
    expect(report.scoreItems20).toHaveLength(20);
    expect(report.fullSections.onePageConclusion).toBe("完整一页结论");
    expect(report.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ title: "600519 Eastmoney financial statements" })]));
  });

  test("falls back to provider company identity when model omits company fields", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(modelResponse(reportPayload({ company: undefined })))
      .mockResolvedValueOnce(modelResponse(narrativePayload()));

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    expect(report.company.name).toBe("Example Inc.");
    expect(report.company.ticker).toBe("EXM");
  });

  test("fills missing template sections with traceable fallback text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(modelResponse(reportPayload({ company: { name: "Example Inc." }, sections: undefined })))
      .mockResolvedValueOnce(modelResponse(narrativePayload()));

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    expect(report.sections.companyOverview).toBe("完整公司概况");
    expect(report.fullSections.companyOverview).toBe("完整公司概况");
  });

  test("repairs malformed JSON before schema validation", async () => {
    const malformed = `{
      "company": {"name": "Example Inc."}
      "asOf": "2026-05-10T00:00:00.000Z",
      "conclusion": "观察",
      "oneSentence": "A test company.",
      "cqs": 60,
      "ias": 55,
      "moduleScores": [],
      "redFlags": [],
      "evidence": [],
      "sections": {
        "companyOverview": "overview",
        "industry": "industry",
        "businessModel": "model",
        "moat": "moat",
        "governance": "governance",
        "financialQuality": "financials",
        "growth": "growth",
        "valuation": "valuation",
        "risks": "risks",
        "finalConclusion": "final"
      },
      "disclaimer": "Research only."
    }`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ finish_reason: "stop", message: { content: malformed } }],
        }),
      })
      .mockResolvedValueOnce(modelResponse(narrativePayload()));

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    expect(report.company.name).toBe("Example Inc.");
    expect(report.sections.finalConclusion).toBe("完整最终结论");
  });
});
