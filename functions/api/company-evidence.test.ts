import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestPost } from "./company-evidence";

const mocks = vi.hoisted(() => ({
  fetchPublicCompanyEvidence: vi.fn(),
  verifySessionCookie: vi.fn(async () => true),
}));

vi.mock("../_shared/auth", () => ({
  verifySessionCookie: mocks.verifySessionCookie,
}));

vi.mock("../_shared/providers", () => ({
  fetchPublicCompanyEvidence: mocks.fetchPublicCompanyEvidence,
}));

describe("/api/company-evidence", () => {
  beforeEach(() => {
    mocks.fetchPublicCompanyEvidence.mockReset();
    mocks.verifySessionCookie.mockClear();
  });

  test("rejects malformed company names before fetching evidence", async () => {
    const response = await onRequestPost(context({
      company: { name: 123 },
      companyName: 456,
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("请先提供公司名称。");
    expect(mocks.fetchPublicCompanyEvidence).not.toHaveBeenCalled();
  });

  test("drops malformed optional ticker and market values before fetching evidence", async () => {
    mocks.fetchPublicCompanyEvidence.mockResolvedValue({ facts: [], evidence: [] });

    const response = await onRequestPost(context({
      companyName: "贵州茅台",
      ticker: 600519,
      market: { value: "沪A" },
    }));

    expect(response.status).toBe(200);
    expect(mocks.fetchPublicCompanyEvidence).toHaveBeenCalledWith(expect.objectContaining({
      companyName: "贵州茅台",
      ticker: undefined,
      market: undefined,
      company: undefined,
    }));
  });
});

function context(body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/company-evidence", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "cstd_alpha_session=session-1.token" },
      body: JSON.stringify(body),
    }),
    env: {
      AUTH_SECRET: "test-secret",
      TUSHARE_TOKEN: "token-1",
    },
  } as unknown as Parameters<typeof onRequestPost>[0];
}
