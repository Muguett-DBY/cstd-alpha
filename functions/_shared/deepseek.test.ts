import { describe, expect, test, vi } from "vitest";
import { callDeepSeekReport } from "./deepseek";
import type { EvidenceBundle } from "./providers";

const evidence: EvidenceBundle = {
  company: { name: "Example Inc.", ticker: "EXM", market: "US" },
  retrievedAt: "2026-05-10T00:00:00.000Z",
  evidence: [],
  facts: { quote: { regularMarketPrice: 10 } },
};

describe("DeepSeek report client", () => {
  test("requests DeepSeek V4 Pro in max thinking mode with JSON output", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
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
              }),
            },
          },
        ],
      }),
    });

    await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.reasoning_effort).toBe("max");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  test("falls back to provider company identity when model omits company fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
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
              }),
            },
          },
        ],
      }),
    });

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    expect(report.company.name).toBe("Example Inc.");
    expect(report.company.ticker).toBe("EXM");
  });

  test("fills missing template sections with traceable fallback text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                company: { name: "Example Inc." },
                asOf: "2026-05-10T00:00:00.000Z",
                conclusion: "观察",
                oneSentence: "A test company.",
                cqs: 60,
                ias: 55,
                moduleScores: [],
                redFlags: [],
                evidence: [],
                disclaimer: "Research only.",
              }),
            },
          },
        ],
      }),
    });

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    expect(report.sections.companyOverview).toContain("未由模型按模板提供完整段落");
    expect(report.sections.finalConclusion).toContain("Example Inc.");
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: malformed } }],
      }),
    });

    const report = await callDeepSeekReport({ apiKey: "key", evidence, fetchImpl: fetchMock });

    expect(report.company.name).toBe("Example Inc.");
    expect(report.sections.finalConclusion).toBe("final");
  });
});
