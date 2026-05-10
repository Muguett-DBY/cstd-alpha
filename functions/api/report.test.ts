import { describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./report";
import { verifySessionCookie } from "../_shared/auth";
import { callDeepSeekReport, MODEL_OUTPUT_LENGTH_MESSAGE } from "../_shared/deepseek";
import { fetchPublicCompanyEvidence, type EvidenceBundle } from "../_shared/providers";

vi.mock("../_shared/auth", () => ({
  verifySessionCookie: vi.fn(),
}));

vi.mock("../_shared/deepseek", () => ({
  MODEL_OUTPUT_LENGTH_MESSAGE: "模型输出超过长度限制，本次报告未完成，请重试。",
  callDeepSeekReport: vi.fn(),
}));

vi.mock("../_shared/providers", () => ({
  fetchPublicCompanyEvidence: vi.fn(),
}));

const evidence: EvidenceBundle = {
  company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
  retrievedAt: "2026-05-10T00:00:00.000Z",
  evidence: [
    {
      title: "600519 identity",
      source: "Eastmoney",
      url: "https://example.com/identity",
      retrievedAt: "2026-05-10T00:00:00.000Z",
      freshness: "latest-public",
      notes: "ok",
    },
    {
      title: "600519 financials",
      source: "Eastmoney",
      url: "https://example.com/financials",
      retrievedAt: "2026-05-10T00:00:00.000Z",
      freshness: "latest-public",
      notes: "ok",
    },
  ],
  facts: {},
};

describe("report API stream", () => {
  test("emits a structured evidence count before model generation", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockResolvedValue({ company: evidence.company, evidence: evidence.evidence });

    const events = await postReportEvents();

    expect(events.find((event) => event.stage === "evidence_ready")).toMatchObject({
      type: "progress",
      evidenceCount: 2,
    });
    expect(events.at(-1)).toMatchObject({ type: "final" });
  });

  test("streams model length failures as errors instead of final reports", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    vi.mocked(fetchPublicCompanyEvidence).mockResolvedValue(evidence);
    vi.mocked(callDeepSeekReport).mockRejectedValue(Object.assign(new Error(MODEL_OUTPUT_LENGTH_MESSAGE), { code: "MODEL_OUTPUT_LENGTH", retryable: true }));

    const events = await postReportEvents();

    expect(events.some((event) => event.type === "final")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: MODEL_OUTPUT_LENGTH_MESSAGE,
      code: "MODEL_OUTPUT_LENGTH",
      retryable: true,
    });
  });
});

async function postReportEvents() {
  const response = await onRequestPost({
    request: new Request("https://alpha.custard.top/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session=ok" },
      body: JSON.stringify({
        company: {
          id: "eastmoney:1.600519",
          name: "贵州茅台",
          code: "600519",
          exchange: "上海证券交易所",
          listingPlace: "沪A",
          marketType: "AStock",
          quoteId: "1.600519",
          source: "eastmoney",
        },
      }),
    }),
    env: { AUTH_SECRET: "secret", DEEPSEEK_API_KEY: "key" },
  } as Parameters<typeof onRequestPost>[0]);

  return (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
