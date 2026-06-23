import { afterEach, describe, expect, test, vi } from "vitest";
import {
  computeValuationFromAssumptions,
  buildQuantitativeVersionFromAssumptions,
  buildQuantitativeVersionFromEvidence,
  generateValuationAssumptionsOrPlaceholder,
  extractValuationAnchors,
  mergeAnchorsIntoAssumptions,
  prepareValuationEvidenceContext,
  validateValuationInputs,
  type ValuationAnchors,
} from "./valuation-runner";
import type { ValuationRunRow } from "./research-workbench-db";

function makeRun(overrides?: Partial<Pick<ValuationRunRow, "method" | "archetype" | "currency" | "evidence_hash">>): Pick<ValuationRunRow, "method" | "archetype" | "currency" | "evidence_hash"> {
  return { method: "dcf_3_statement", archetype: "operating", currency: "CNY", evidence_hash: null, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractValuationAnchors", () => {
  test("extracts baseRevenue from financialTenYear revenue row", () => {
    const evidence = JSON.stringify({
      stableFacts: {
        financialTenYear: {
          rows: [
            { metric: "营业收入", values: { "2023": "1,200.00亿", "2024": "1,500.00亿" } },
            { metric: "净利润", values: { "2023": "300.00亿", "2024": "350.00亿" } },
          ],
        },
      },
      freshSignals: {},
    });
    const anchors = extractValuationAnchors(evidence);
    expect(anchors.baseRevenue).toBe(1500);
    expect(anchors.sharesOutstanding).toBeUndefined();
  });

  test("extracts sharesOutstanding from marketCap/price", () => {
    const evidence = JSON.stringify({
      stableFacts: {},
      freshSignals: {
        quote: { marketCap: 1_500_000_000_000, regularMarketPrice: 150 },
      },
    });
    const anchors = extractValuationAnchors(evidence);
    expect(anchors.sharesOutstanding).toBeCloseTo(100, 8);
  });

  test("extracts latest annual book value and does not mistake a quarterly revenue value for the base year", () => {
    const evidence = JSON.stringify({
      stableFacts: {
        financialTenYear: {
          rows: [
            { metric: "营业收入", values: { "2025": "1,800.00亿元", "2026Q1": "520.00亿元" } },
            { metric: "股东权益", values: { "2025": "2,400.00亿元", "2026Q1": "2,460.00亿元" } },
          ],
        },
      },
      freshSignals: {},
    });

    expect(extractValuationAnchors(evidence)).toMatchObject({
      baseRevenue: 1800,
      bookValue: 2400,
    });
  });

  test("normalizes raw yuan statement values into 100-million currency units", () => {
    const evidence = JSON.stringify({
      stableFacts: {
        financialTenYear: {
          rows: [{ metric: "营业收入", values: { "2025": "180000000000元" } }],
        },
      },
      freshSignals: {},
    });

    expect(extractValuationAnchors(evidence).baseRevenue).toBe(1800);
  });

  test("returns empty anchors for unparseable text", () => {
    expect(extractValuationAnchors("not json")).toEqual({});
    expect(extractValuationAnchors("")).toEqual({});
  });

  test("returns empty anchors when financialTenYear lacks revenue row", () => {
    const evidence = JSON.stringify({
      stableFacts: { financialTenYear: { rows: [{ metric: "总资产", values: { "2024": "5,000亿" } }] } },
      freshSignals: {},
    });
    const anchors = extractValuationAnchors(evidence);
    expect(anchors.baseRevenue).toBeUndefined();
  });
});

describe("prepareValuationEvidenceContext", () => {
  test("extracts anchors from the complete package before building a compact valid prompt payload", () => {
    const evidence = JSON.stringify({
      companyKey: "SH-A:600519",
      fetchedAt: "2026-06-15T00:00:00.000Z",
      stableFacts: {
        company: { name: "贵州茅台", ticker: "600519" },
        financialTenYear: {
          rows: [{ metric: "营业收入", values: { "2025": "1,800.00亿元" } }],
        },
        fundamentals: { largeNoise: "x".repeat(30_000) },
      },
      freshSignals: {
        quote: { marketCap: 1_800_000_000_000, regularMarketPrice: 1500 },
        sources: Array.from({ length: 60 }, (_, index) => ({ title: `source-${index}`, notes: "y".repeat(1000) })),
      },
    });

    const context = prepareValuationEvidenceContext(evidence);

    expect(context.anchors).toMatchObject({ baseRevenue: 1800, sharesOutstanding: 12 });
    expect(context.promptText.length).toBeLessThanOrEqual(24_000);
    expect(() => JSON.parse(context.promptText)).not.toThrow();
    expect(context.promptText).toContain("贵州茅台");
  });
});

describe("mergeAnchorsIntoAssumptions", () => {
  test("fills missing scale fields and lets trusted anchors replace conflicting model scale values", () => {
    const payload = { confidence: 0.5, operating: { sharesOutstanding: 50 } };
    const anchors: ValuationAnchors = { baseRevenue: 1000, sharesOutstanding: 100 };
    const merged = mergeAnchorsIntoAssumptions(payload, anchors);
    expect(merged.operating?.baseRevenue).toBe(1000);
    expect(merged.operating?.sharesOutstanding).toBe(100);
  });

  test("creates operating block when none exists and no other method set", () => {
    const payload = { confidence: 0.5 };
    const anchors: ValuationAnchors = { baseRevenue: 800, sharesOutstanding: 60 };
    const merged = mergeAnchorsIntoAssumptions(payload, anchors);
    expect(merged.operating?.baseRevenue).toBe(800);
    expect(merged.operating?.sharesOutstanding).toBe(60);
  });

  test("does not touch financial block when operating block exists", () => {
    const payload = { confidence: 0.5, financial: {} };
    const anchors: ValuationAnchors = { baseRevenue: 800 };
    const merged = mergeAnchorsIntoAssumptions(payload, anchors);
    expect(merged.operating).toBeUndefined();
  });

  test("fills financial shares when operating block exists", () => {
    const payload = { confidence: 0.5, operating: {}, financial: {} };
    const anchors: ValuationAnchors = { sharesOutstanding: 80 };
    const merged = mergeAnchorsIntoAssumptions(payload, anchors);
    expect(merged.operating?.sharesOutstanding).toBe(80);
    expect(merged.financial?.sharesOutstanding).toBe(80);
  });

  test("trusted evidence anchors override conflicting model-provided scale values", () => {
    const payload = { confidence: 0.5, operating: { baseRevenue: 2000, sharesOutstanding: 100 } };
    const anchors: ValuationAnchors = { baseRevenue: 1000, sharesOutstanding: 50 };
    const merged = mergeAnchorsIntoAssumptions(payload, anchors);
    expect(merged.operating?.baseRevenue).toBe(1000);
    expect(merged.operating?.sharesOutstanding).toBe(50);
  });
});

describe("validateValuationInputs", () => {
  test("throws when operating DCF lacks baseRevenue", () => {
    expect(() => validateValuationInputs(makeRun(), { confidence: 0.3, operating: { sharesOutstanding: 50 } })).toThrow("baseRevenue");
    expect(() => validateValuationInputs(makeRun(), { confidence: 0.3, operating: { baseRevenue: 0, sharesOutstanding: 50 } })).toThrow("baseRevenue");
  });

  test("throws when operating DCF lacks sharesOutstanding", () => {
    expect(() => validateValuationInputs(makeRun(), { confidence: 0.3, operating: { baseRevenue: 500 } })).toThrow("sharesOutstanding");
  });

  test("passes when operating DCF has both scale inputs", () => {
    expect(() => validateValuationInputs(makeRun(), { confidence: 0.3, operating: { baseRevenue: 500, sharesOutstanding: 50 } })).not.toThrow();
  });

  test("throws when DDM lacks bookValue", () => {
    expect(() => validateValuationInputs(makeRun({ method: "ddm_residual_income" }), { confidence: 0.3, financial: { sharesOutstanding: 1000 } })).toThrow("bookValue");
  });

  test("throws when DDM lacks sharesOutstanding", () => {
    expect(() => validateValuationInputs(makeRun({ method: "ddm_residual_income" }), { confidence: 0.3, financial: { bookValue: 5000 } })).toThrow("sharesOutstanding");
  });

  test("passes when DDM has both inputs", () => {
    expect(() => validateValuationInputs(makeRun({ method: "ddm_residual_income" }), { confidence: 0.3, financial: { bookValue: 5000, sharesOutstanding: 1000 } })).not.toThrow();
  });

  test("throws when cyclical lacks midCycleEbitda", () => {
    expect(() => validateValuationInputs(makeRun({ method: "mid_cycle_nav" }), { confidence: 0.3, cyclical: { sharesOutstanding: 200 } })).toThrow("midCycleEbitda");
  });

  test("passes when cyclical has both inputs", () => {
    expect(() => validateValuationInputs(makeRun({ method: "mid_cycle_nav" }), { confidence: 0.3, cyclical: { midCycleEbitda: { low: 60, base: 90, high: 120 }, sharesOutstanding: 200 } })).not.toThrow();
  });
});

describe("computeValuationFromAssumptions", () => {
  test("throws error for empty operating assumptions with no anchors", () => {
    expect(() => computeValuationFromAssumptions(makeRun(), { confidence: 0.3, operating: {} })).toThrow("baseRevenue");
  });

  test("throws error for empty financial assumptions with no anchors", () => {
    expect(() => computeValuationFromAssumptions(makeRun({ method: "ddm_residual_income" }), { confidence: 0.3, financial: {} })).toThrow("bookValue");
  });

  test("completes with model-provided values for operating DCF", () => {
    const result = computeValuationFromAssumptions(makeRun(), {
      confidence: 0.6,
      operating: { baseRevenue: 1000, sharesOutstanding: 100, revenueGrowth: { low: 0.04, base: 0.08, high: 0.12 }, ebitMargin: { low: 0.14, base: 0.18, high: 0.22 } },
    });
    expect(result.method).toBe("dcf_3_statement");
    expect(result.scenarios).toHaveLength(3);
    expect(result.scenarios[1].perShareValue).toBeGreaterThan(0);
  });

  test("completes with anchor-provided values when model only provides rates", () => {
    const result = computeValuationFromAssumptions(
      makeRun(),
      { confidence: 0.5, operating: { revenueGrowth: { low: 0.03, base: 0.07, high: 0.11 }, ebitMargin: { low: 0.1, base: 0.15, high: 0.2 } } },
      { baseRevenue: 2000, sharesOutstanding: 150 },
    );
    expect(result.method).toBe("dcf_3_statement");
    expect(result.scenarios[1].perShareValue).toBeGreaterThan(0);
  });

  test("marks successful valuations with the grounded methodology version", () => {
    const result = computeValuationFromAssumptions(
      makeRun({ evidence_hash: "evidence-v2" }),
      { confidence: 0.5, operating: { revenueGrowth: { low: 0.03, base: 0.07, high: 0.11 }, ebitMargin: { low: 0.1, base: 0.15, high: 0.2 } } },
      { baseRevenue: 2000, sharesOutstanding: 150 },
    );

    expect(result.methodologyVersion).toBe(2);
  });

  test("throws even with anchors when essential input still missing", () => {
    expect(() => computeValuationFromAssumptions(
      makeRun(),
      { confidence: 0.3, operating: {} },
      { sharesOutstanding: 100 },
    )).toThrow("baseRevenue");
  });

  test("evidence scale anchors determine the computed forecast even when model scale values conflict", () => {
    const result = computeValuationFromAssumptions(
      makeRun(),
      { confidence: 0.6, operating: { baseRevenue: 5000, sharesOutstanding: 300, revenueGrowth: { low: 0.04, base: 0.08, high: 0.12 }, ebitMargin: { low: 0.14, base: 0.18, high: 0.22 } } },
      { baseRevenue: 1000, sharesOutstanding: 50 },
    );
    expect(result.scenarios[1].perShareValue).toBeGreaterThan(0);
    const baseForecast = result.forecastRows?.[0];
    expect(baseForecast?.revenue).toBeGreaterThan(1000 * 1.04 * 0.99);
    expect(baseForecast?.revenue).toBeLessThan(1000 * 1.08 * 1.01);
  });
});

describe("buildQuantitativeVersionFromEvidence", () => {
  test("builds a deterministic operating draft and result from valid A-share evidence", () => {
    const evidence = JSON.stringify({
      version: 1,
      userId: "user-1",
      watchlistId: "watch-1",
      companyKey: "A股:600519",
      evidenceHash: "evidence-1",
      materialHash: "material-1",
      stableHash: "stable-1",
      freshHash: "fresh-1",
      fetchedAt: "2026-06-21T00:00:00.000Z",
      stableFacts: {
        company: { name: "贵州茅台", ticker: "600519", market: "A股" },
        financialTenYear: {
          rows: [
            { metric: "营业收入", values: { "2023": "1400亿元", "2024": "1600亿元" } },
            { metric: "EBIT", values: { "2023": "800亿元", "2024": "900亿元" } },
          ],
        },
      },
      freshSignals: {
        retrievedAt: "2026-06-21T00:00:00.000Z",
        quote: { symbol: "600519", market: "沪A", regularMarketPrice: 1500, marketCap: 1_884_000_000_000 },
      },
      evidence: {
        company: { name: "贵州茅台", ticker: "600519", market: "A股" },
        retrievedAt: "2026-06-21T00:00:00.000Z",
        evidence: [],
        facts: {},
      },
    });
    const fullRun = {
      id: "run-1", user_key: "user-1", research_item_id: "research-1", entity_id: "watch-1", title: "贵州茅台",
      archetype: "operating", method: "dcf_3_statement", currency: "CNY", evidence_hash: "evidence-1",
    } as ValuationRunRow;

    const built = buildQuantitativeVersionFromEvidence(fullRun, evidence);

    expect(built.snapshot.contentHash).toBe("material-1");
    expect(built.draft.operating?.baseRevenue).toBe(1600);
    expect(built.result.method).toBe("dcf_3_statement");
    expect(built.result.scenarios.find((scenario) => scenario.scenario === "base")?.perShareValue).toBeGreaterThan(0);
  });
});

describe("buildQuantitativeVersionFromAssumptions", () => {
  test("builds an editable quantitative workspace from grounded AI assumptions when evidence package is not ready", () => {
    const run = {
      id: "run-1",
      user_key: "user-1",
      research_item_id: "research-1",
      entity_id: "eastmoney:1.600519",
      title: "贵州茅台",
      archetype: "operating",
      method: "dcf_3_statement",
      currency: "CNY",
      evidence_hash: null,
    } as ValuationRunRow;

    const built = buildQuantitativeVersionFromAssumptions(
      run,
      {
        confidence: 0.55,
        operating: {
          baseRevenue: 1600,
          sharesOutstanding: 12.56,
          netDebt: -400,
          revenueGrowth: { low: 0.03, base: 0.06, high: 0.09 },
          ebitMargin: { low: 0.45, base: 0.5, high: 0.55 },
        },
      },
      {},
      "暂无完整公司证据包。估值对象：贵州茅台。",
    );

    expect(built.snapshot.researchItemId).toBe("research-1");
    expect(built.snapshot.contentHash).toMatch(/^ai-fallback:/);
    expect(built.draft.operating?.baseRevenue).toBe(1600);
    expect(built.draft.operating?.sharesOutstanding).toBe(12.56);
    expect(built.draft.assumptions?.some((assumption) => assumption.origin === "ai")).toBe(true);
    expect(built.result.quantitativeVersionId).toBeUndefined();
    expect(built.result.scenarios.find((scenario) => scenario.scenario === "base")?.perShareValue).toBeGreaterThan(0);
  });

  test("keeps A-share manual valuation usable when scale assumptions are missing", () => {
    const run = {
      id: "run-1",
      user_key: "user-1",
      research_item_id: "research-1",
      entity_id: "eastmoney:1.600519",
      title: "贵州茅台",
      archetype: "operating",
      method: "dcf_3_statement",
      currency: "CNY",
      evidence_hash: null,
    } as ValuationRunRow;

    const built = buildQuantitativeVersionFromAssumptions(
      run,
      { confidence: 0.3, operating: { revenueGrowth: { low: 0.02, base: 0.05, high: 0.08 } } },
      {},
      "暂无完整公司证据包。估值对象：贵州茅台。",
    );

    expect(built.draft.operating?.baseRevenue).toBeGreaterThan(0);
    expect(built.draft.operating?.sharesOutstanding).toBeGreaterThan(0);
    expect(built.draft.assumptions?.map((assumption) => assumption.key)).toEqual(expect.arrayContaining(["baseRevenue", "sharesOutstanding"]));
    expect(built.warnings.join("\n")).toContain("占位");
  });
});

describe("generateValuationAssumptionsOrPlaceholder", () => {
  test("returns editable placeholder assumptions for operating DCF when model routes fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    const run = {
      id: "run-1",
      user_key: "user-1",
      research_item_id: "research-1",
      entity_id: "eastmoney:1.600519",
      title: "贵州茅台",
      status: "running",
      archetype: "operating",
      method: "dcf_3_statement",
      currency: "CNY",
      evidence_hash: null,
    } as ValuationRunRow;

    await expect(generateValuationAssumptionsOrPlaceholder({} as never, run, "{}")).resolves.toMatchObject({
      confidence: 0.2,
      operating: {},
    });
  });
});
