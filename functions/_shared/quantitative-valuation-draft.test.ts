import { describe, expect, test } from "vitest";
import { assertAshare, createQuantitativeBaseline, growthTriple } from "./quantitative-valuation-draft";
import type { CompanyEvidencePackage } from "./company-evidence";
import type { ValuationRunRow } from "./research-workbench-db";

function makeRun(overrides: Partial<Pick<ValuationRunRow, "id" | "user_key" | "research_item_id" | "entity_id" | "title" | "archetype" | "method" | "currency" | "evidence_hash">> = {}) {
  return {
    id: "run-1",
    user_key: "user-1",
    research_item_id: "research-1",
    entity_id: "watch-1",
    title: "贵州茅台",
    archetype: "operating",
    method: "dcf_3_statement",
    currency: "CNY",
    evidence_hash: "run-evidence-hash",
    ...overrides,
  } satisfies Pick<ValuationRunRow, "id" | "user_key" | "research_item_id" | "entity_id" | "title" | "archetype" | "method" | "currency" | "evidence_hash">;
}

function makeEvidencePackage(overrides: Partial<CompanyEvidencePackage> = {}): CompanyEvidencePackage {
  return {
    version: 1,
    userId: "user-1",
    watchlistId: "watch-1",
    companyKey: "A股:600519",
    evidenceHash: "evidence-hash-1",
    materialHash: "material-hash-1",
    stableHash: "stable-hash-1",
    freshHash: "fresh-hash-1",
    fetchedAt: "2026-06-20T08:30:00.000Z",
    stableFacts: {
      company: { name: "贵州茅台", ticker: "600519", market: "A股" },
      selectedCompany: { code: "600519", listingPlace: "沪A", marketType: "A股" },
      financialTenYear: {
        rows: [
          { metric: "营业收入", values: { "2022": "1,250.00亿元", "2023": "1,475.00亿元", "2024": "1,730.00亿元" } },
          { metric: "EBIT", values: { "2022": "760.00亿元", "2023": "905.00亿元", "2024": "1,050.00亿元" } },
          { metric: "资本开支", values: { "2024": "80.00亿元" } },
          { metric: "经营营运资本增加", values: { "2024": "20.00亿元" } },
          { metric: "所得税费用", values: { "2024": "260.00亿元" } },
          { metric: "税前利润", values: { "2024": "1,040.00亿元" } },
          { metric: "有息负债", values: { "2024": "150.00亿元" } },
          { metric: "货币资金", values: { "2024": "2,000.00亿元" } },
        ],
      },
    },
    freshSignals: {
      retrievedAt: "2026-06-21T09:00:00.000Z",
      quote: {
        symbol: "600519",
        market: "沪A",
        regularMarketPrice: 1500,
        marketCap: 1_884_000_000_000,
      },
      warnings: ["行情可能延迟。"],
    },
    evidence: {
      company: { name: "贵州茅台", ticker: "600519", market: "A股" },
      retrievedAt: "2026-06-21T09:00:00.000Z",
      evidence: [],
      facts: {},
    },
    ...overrides,
  };
}

function assumptionByKey(result: ReturnType<typeof createQuantitativeBaseline>, key: string) {
  const assumption = result.draft.assumptions.find((item) => item.key === key);
  expect(assumption, `missing assumption ${key}`).toBeDefined();
  return assumption!;
}

function expectGeneratedAssumption(assumption: ReturnType<typeof assumptionByKey>) {
  expect(assumption.locked).toBe(false);
  expect(["provider", "formula"]).toContain(assumption.origin);
  expect(assumption.origin).not.toBe("user");
  expect(assumption.confidence).toBeGreaterThan(0);
  expect(Array.isArray(assumption.evidenceRefs)).toBe(true);
  expect(assumption.explanation.length).toBeGreaterThan(0);
}

describe("quantitative valuation draft baseline", () => {
  test("creates a formula-backed A-share operating baseline from annual evidence", () => {
    const result = createQuantitativeBaseline(makeEvidencePackage(), makeRun());

    expect(result.draft).toMatchObject({
      runId: "run-1",
      sourceSnapshotId: "pending",
      market: "A股",
      archetype: "operating",
      method: "dcf_3_statement",
      currency: "CNY",
      asOf: "2026-06-21",
      currentPrice: 1500,
    });
    expect(result.draft.operating?.baseRevenue).toBe(1730);
    expect(result.draft.operating?.sharesOutstanding).toBeCloseTo(12.56, 6);
    expect(result.draft.operating?.netDebt).toBe(-1850);
    expect(assumptionByKey(result, "revenueGrowth")).toMatchObject({
      key: "revenueGrowth",
      origin: "formula",
      locked: false,
      bear: expect.any(Number),
      base: expect.any(Number),
      bull: expect.any(Number),
      evidenceRefs: expect.arrayContaining(["financialTenYear:营业收入"]),
      explanation: expect.stringContaining("营业收入"),
    });
    expect(assumptionByKey(result, "ebitMargin")).toMatchObject({
      origin: "formula",
      locked: false,
      bear: expect.any(Number),
      base: expect.any(Number),
      bull: expect.any(Number),
      evidenceRefs: expect.arrayContaining(["financialTenYear:EBIT"]),
    });
    const ebitMargin = assumptionByKey(result, "ebitMargin");
    expect(ebitMargin.bear).toBeCloseTo(result.draft.operating!.ebitMargin.low * 100, 6);
    expect(ebitMargin.base).toBeCloseTo(result.draft.operating!.ebitMargin.base * 100, 6);
    expect(ebitMargin.bull).toBeCloseTo(result.draft.operating!.ebitMargin.high * 100, 6);
    expect(ebitMargin.bear).toBeLessThanOrEqual(ebitMargin.base);
    expect(ebitMargin.base).toBeLessThanOrEqual(ebitMargin.bull);
    expect(result.draft.operating?.revenueGrowth.base).toBeCloseTo(growthTriple([1250, 1475, 1730]).base, 8);
  });

  test("rejects non-A-share evidence", () => {
    const pkg = makeEvidencePackage({
      companyKey: "US:AAPL",
      stableFacts: {
        company: { name: "Apple", ticker: "AAPL", market: "US" },
        financialTenYear: { rows: [] },
      },
      freshSignals: { quote: { symbol: "AAPL", market: "NASDAQ", regularMarketPrice: 200 } },
      evidence: {
        company: { name: "Apple", ticker: "AAPL", market: "US" },
        retrievedAt: "2026-06-21T09:00:00.000Z",
        evidence: [],
        facts: {},
      },
    });

    expect(() => createQuantitativeBaseline(pkg, makeRun())).toThrow("仅支持 A 股公司创建可编辑量化估值。");
    expect(() => assertAshare("NASDAQ", "AAPL")).toThrow("仅支持 A 股公司创建可编辑量化估值。");
  });

  test("baseline snapshot preserves source payload metadata", () => {
    const pkg = makeEvidencePackage();
    const result = createQuantitativeBaseline(JSON.stringify(pkg), makeRun());

    expect(result.snapshot).toMatchObject({
      userKey: "user-1",
      researchItemId: "research-1",
      market: "A股",
      asOf: "2026-06-21",
      evidenceHash: "evidence-hash-1",
      contentHash: "material-hash-1",
      warnings: ["行情可能延迟。"],
    });
    expect(result.snapshot.payload).toMatchObject({
      companyKey: "A股:600519",
      evidenceHash: "evidence-hash-1",
      materialHash: "material-hash-1",
      stableHash: "stable-hash-1",
      freshHash: "fresh-hash-1",
      fetchedAt: "2026-06-20T08:30:00.000Z",
    });
  });

  test("compacts oversized evidence before storing the valuation source snapshot", () => {
    const pkg = makeEvidencePackage();
    (pkg.evidence as Record<string, unknown>).rawResearchBody = "x".repeat(3_000_000);

    const result = createQuantitativeBaseline(pkg, makeRun());

    expect(JSON.stringify(result.snapshot.payload).length).toBeLessThan(200_000);
    expect(result.snapshot.payload).toMatchObject({
      companyKey: "A股:600519",
      stableFacts: { financialTenYear: { rows: expect.any(Array) } },
      freshSignals: { quote: { regularMarketPrice: 1500 } },
    });
    expect(result.snapshot.payload).not.toHaveProperty("evidence");
  });

  test("generated assumptions are unlocked provider or formula values, never user values", () => {
    const result = createQuantitativeBaseline(makeEvidencePackage(), makeRun());
    const assumptions = result.draft.assumptions;

    expect(assumptions.map((item) => item.key)).toEqual(expect.arrayContaining([
      "revenueGrowth",
      "ebitMargin",
      "capexRate",
      "workingCapitalRate",
      "taxRate",
      "discountRate",
      "terminalGrowthRate",
      "netDebt",
      "sharesOutstanding",
    ]));
    for (const assumption of assumptions) {
      expectGeneratedAssumption(assumption);
    }
    expect(assumptionByKey(result, "discountRate")).toMatchObject({
      origin: "formula",
      locked: false,
      bear: 11.5,
      base: 10,
      bull: 8.5,
      evidenceRefs: expect.arrayContaining(["formula:ashare-default-wacc"]),
    });
    expect(assumptionByKey(result, "terminalGrowthRate")).toMatchObject({
      origin: "formula",
      locked: false,
      bear: 1.5,
      base: 2.5,
      bull: 3.5,
      evidenceRefs: expect.arrayContaining(["formula:ashare-default-terminal-growth"]),
    });
    expect(assumptionByKey(result, "netDebt")).toMatchObject({
      origin: "formula",
      locked: false,
      value: -1850,
      base: -1850,
      evidenceRefs: expect.arrayContaining(["financialTenYear:有息负债", "financialTenYear:货币资金"]),
    });
    expect(assumptionByKey(result, "sharesOutstanding")).toMatchObject({
      origin: "provider",
      locked: false,
      value: 12.56,
      base: 12.56,
      evidenceRefs: expect.arrayContaining(["freshSignals.quote"]),
    });
  });

  test("uses percent-point display values while keeping operating calculation inputs as decimals", () => {
    const result = createQuantitativeBaseline(makeEvidencePackage(), makeRun());

    expect(assumptionByKey(result, "revenueGrowth").base).toBeCloseTo(result.draft.operating!.revenueGrowth.base * 100, 6);
    expect(assumptionByKey(result, "capexRate").base).toBeCloseTo(result.draft.operating!.capexRate.base * 100, 6);
    expect(assumptionByKey(result, "workingCapitalRate").base).toBeCloseTo(result.draft.operating!.workingCapitalRate * 100, 6);
    expect(assumptionByKey(result, "taxRate").base).toBeCloseTo(result.draft.operating!.taxRate * 100, 6);
    expect(assumptionByKey(result, "discountRate").base).toBe(10);
    expect(result.draft.operating?.discountRate.base).toBe(0.1);
  });

  test("marks missing financial fields as fallback assumptions without absent evidence refs", () => {
    const result = createQuantitativeBaseline(
      makeEvidencePackage({
        stableFacts: {
          company: { name: "样本公司", ticker: "000001", market: "深A" },
          selectedCompany: { code: "000001", listingPlace: "深A", marketType: "A股" },
          financialTenYear: {
            rows: [
              { metric: "营业收入", values: { "2023": "900亿元", "2024": "1,000亿元" } },
              { metric: "EBIT", values: { "2023": "90亿元", "2024": "120亿元" } },
              { metric: "货币资金", values: { "2024": "50亿元" } },
            ],
          },
        },
        freshSignals: {
          retrievedAt: "2026-06-21T09:00:00.000Z",
          quote: { symbol: "000001", market: "深A", regularMarketPrice: 10, marketCap: 100_000_000_000 },
        },
        evidence: {
          company: { name: "样本公司", ticker: "000001", market: "深A" },
          retrievedAt: "2026-06-21T09:00:00.000Z",
          evidence: [],
          facts: {},
        },
      }),
      makeRun({ title: "样本公司" }),
    );

    for (const key of ["capexRate", "workingCapitalRate", "taxRate"]) {
      const assumption = assumptionByKey(result, key);
      expect(assumption.origin).toBe("formula");
      expect(assumption.locked).toBe(false);
      expect(assumption.confidence).toBeLessThan(0.5);
      expect(assumption.explanation).toMatch(/fallback|default|默认|缺少/);
      expect(assumption.evidenceRefs).toEqual([]);
    }
    expect(assumptionByKey(result, "netDebt")).toMatchObject({
      origin: "formula",
      locked: false,
      value: -50,
      base: -50,
      evidenceRefs: ["financialTenYear:货币资金"],
    });
    expect(assumptionByKey(result, "netDebt").explanation).not.toMatch(/fallback|default|默认/);
  });

  test("marks insufficient revenue history fallback without misleading revenue evidence refs", () => {
    const result = createQuantitativeBaseline(
      makeEvidencePackage({
        stableFacts: {
          company: { name: "样本公司", ticker: "000001", market: "深A" },
          selectedCompany: { code: "000001", listingPlace: "深A", marketType: "A股" },
          financialTenYear: {
            rows: [
              { metric: "营业收入", values: { "2024": "1,000亿元" } },
              { metric: "EBIT", values: { "2024": "120亿元" } },
            ],
          },
        },
        freshSignals: {
          retrievedAt: "2026-06-21T09:00:00.000Z",
          quote: { symbol: "000001", market: "深A", regularMarketPrice: 10, marketCap: 100_000_000_000 },
        },
        evidence: {
          company: { name: "样本公司", ticker: "000001", market: "深A" },
          retrievedAt: "2026-06-21T09:00:00.000Z",
          evidence: [],
          facts: {},
        },
      }),
      makeRun({ title: "样本公司" }),
    );

    const revenueGrowth = assumptionByKey(result, "revenueGrowth");
    expect(revenueGrowth.base).toBe(7);
    expect(revenueGrowth.confidence).toBeLessThan(0.5);
    expect(revenueGrowth.explanation).toMatch(/fallback|default|默认|不足/);
    expect(revenueGrowth.evidenceRefs).toEqual([]);
  });

  test("marks EBIT margin fallback without unusable paired metric evidence refs", () => {
    const result = createQuantitativeBaseline(
      makeEvidencePackage({
        stableFacts: {
          company: { name: "样本公司", ticker: "000001", market: "深A" },
          selectedCompany: { code: "000001", listingPlace: "深A", marketType: "A股" },
          financialTenYear: {
            rows: [
              { metric: "营业收入", values: { "2023": "900亿元", "2024": "1,000亿元" } },
            ],
          },
        },
        freshSignals: {
          retrievedAt: "2026-06-21T09:00:00.000Z",
          quote: { symbol: "000001", market: "深A", regularMarketPrice: 10, marketCap: 100_000_000_000 },
        },
        evidence: {
          company: { name: "样本公司", ticker: "000001", market: "深A" },
          retrievedAt: "2026-06-21T09:00:00.000Z",
          evidence: [],
          facts: {},
        },
      }),
      makeRun({ title: "样本公司" }),
    );

    const ebitMargin = assumptionByKey(result, "ebitMargin");
    expect(ebitMargin.base).toBe(13);
    expect(ebitMargin.confidence).toBeLessThan(0.5);
    expect(ebitMargin.explanation).toMatch(/fallback|default|默认|缺少/);
    expect(ebitMargin.evidenceRefs).toEqual([]);
  });

  test("marks missing quote share fallback without quote evidence refs", () => {
    const result = createQuantitativeBaseline(
      makeEvidencePackage({
        freshSignals: {
          retrievedAt: "2026-06-21T09:00:00.000Z",
          quote: { symbol: "600519", market: "沪A", regularMarketPrice: 1500 },
        },
      }),
      makeRun(),
    );

    const sharesOutstanding = assumptionByKey(result, "sharesOutstanding");
    expect(sharesOutstanding.value).toBe(0);
    expect(sharesOutstanding.confidence).toBeLessThan(0.5);
    expect(sharesOutstanding.explanation).toMatch(/fallback|default|默认|缺少|暂置/);
    expect(sharesOutstanding.evidenceRefs).toEqual([]);
  });

  test("parses parenthesized negative financial values and quote market-cap unit strings", () => {
    const result = createQuantitativeBaseline(
      makeEvidencePackage({
        stableFacts: {
          company: { name: "贵州茅台", ticker: "600519", market: "A股" },
          selectedCompany: { code: "600519", listingPlace: "沪A", marketType: "A股" },
          financialTenYear: {
            rows: [
              { metric: "营业收入", values: { "2023": "1,475.00亿元", "2024": "1,730.00亿元" } },
              { metric: "EBIT", values: { "2023": "905.00亿元", "2024": "1,050.00亿元" } },
              { metric: "资本开支", values: { "2024": "(80亿元)" } },
              { metric: "有息负债", values: { "2024": "(150亿元)" } },
              { metric: "货币资金", values: { "2024": "2,000.00亿元" } },
            ],
          },
        },
        freshSignals: {
          retrievedAt: "2026-06-21T09:00:00.000Z",
          quote: { symbol: "600519", market: "沪A", regularMarketPrice: 1500, marketCap: "1.884万亿" },
        },
      }),
      makeRun(),
    );

    expect(result.draft.operating?.capexRate.base).toBeCloseTo(80 / 1730, 8);
    expect(assumptionByKey(result, "capexRate").base).toBeCloseTo((80 / 1730) * 100, 6);
    expect(result.draft.operating?.netDebt).toBe(-2150);
    expect(result.draft.operating?.sharesOutstanding).toBeCloseTo(12.56, 6);
  });

  test("normalizes legacy Tencent market-cap numbers expressed in 亿元", () => {
    const result = createQuantitativeBaseline(
      makeEvidencePackage({
        freshSignals: {
          retrievedAt: "2026-06-21T09:00:00.000Z",
          quote: { symbol: "600519", market: "沪A", quoteSourceName: "Tencent", regularMarketPrice: 1215, marketCap: 15188.49 },
        },
      }),
      makeRun(),
    );

    expect(result.draft.operating?.sharesOutstanding).toBeCloseTo(12.5, 2);
  });
});
