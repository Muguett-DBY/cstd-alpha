import { describe, expect, test } from "vitest";
import { buildCompanyEvidencePackage, companyEvidenceObjectKey } from "./company-evidence";

describe("company evidence packages", () => {
  test("assigns stable evidence ids and separates stable facts from fresh signals", async () => {
    const pkg = await buildCompanyEvidencePackage({
      userId: "user-a",
      watchlistId: "watch-1",
      evidence: {
        company: { name: "贵州茅台", ticker: "600519", market: "沪A" },
        retrievedAt: "2026-05-20T00:00:00.000Z",
        evidence: [
          { title: "600519 Eastmoney financial statements", source: "Eastmoney public financial statement endpoints", retrievedAt: "2026-05-20T00:00:00.000Z", freshness: "latest-public", notes: "财报" },
          { title: "贵州茅台 外部搜索风险", source: "AnySearch 外部搜索", url: "https://example.com/risk", retrievedAt: "2026-05-20T00:00:00.000Z", freshness: "latest-public", notes: "风险新闻" },
        ],
        facts: {
          quote: { regularMarketPrice: 100, marketCap: 1000 },
          financialTenYear: { rows: [{ year: "2025", revenue: 1 }] },
          externalSearch: { items: [{ title: "风险新闻" }] },
        },
      },
    });

    expect(pkg.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(pkg.stableHash).toMatch(/^[a-f0-9]{64}$/);
    expect(pkg.freshHash).toMatch(/^[a-f0-9]{64}$/);
    expect(pkg.evidence.evidence.map((item) => item.id)).toEqual(["E1", "E2"]);
    expect(JSON.stringify(pkg.stableFacts)).toContain("financialTenYear");
    expect(JSON.stringify(pkg.freshSignals)).toContain("AnySearch");
    expect(companyEvidenceObjectKey("user/a", "watch:1", pkg.evidenceHash)).toBe(`user-research/v1/company-evidence/user_a/watch_1/${pkg.evidenceHash}.json`);
  });

  test("keeps hashes stable when source ordering changes", async () => {
    const base = {
      company: { name: "公司A", ticker: "000001", market: "A股" },
      retrievedAt: "2026-05-20T00:00:00.000Z",
      evidence: [
        { title: "B", source: "公告", retrievedAt: "2026-05-20T00:00:00.000Z", freshness: "latest-public", notes: "b" },
        { title: "A", source: "公告", retrievedAt: "2026-05-20T00:00:00.000Z", freshness: "latest-public", notes: "a" },
      ],
      facts: { quote: { regularMarketPrice: 1, marketCap: 2 } },
    };

    const left = await buildCompanyEvidencePackage({ userId: "u", watchlistId: "w", evidence: base });
    const right = await buildCompanyEvidencePackage({ userId: "u", watchlistId: "w", evidence: { ...base, evidence: [...base.evidence].reverse() } });

    expect(left.evidenceHash).toBe(right.evidenceHash);
  });
});
