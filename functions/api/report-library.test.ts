import { beforeEach, describe, expect, test, vi } from "vitest";
import { onRequestGet } from "./report-library";
import { verifySessionCookie } from "../_shared/auth";

vi.mock("../_shared/auth", () => ({
  verifySessionCookie: vi.fn(),
}));

describe("report library API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("matches durable ticker filters regardless of query casing", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(true);
    const db = fakeReportLibraryD1([
      {
        id: "report-msft",
        company_name: "Microsoft",
        ticker: "MSFT",
        market: "US",
        industry: "Software",
        sector: "Technology",
        cqs: 88,
        ias: 82,
        conclusion: "买入",
        qualitative_band: "A",
        position_advice: "标准仓 8-15%",
        valuation_view: "合理",
        as_of: "2026-07-11",
        imported_at: "2026-07-11T00:00:00.000Z",
        evidence_count: 8,
        score_item_count: 20,
        object_key: "report-library/v1/reports/report-msft.json",
        report_hash: "hash-msft",
      },
    ]);

    const response = await onRequestGet({
      request: new Request("https://example.test/api/report-library?tickers=msft&seedCodes=msft"),
      env: {
        AUTH_SECRET: "test-secret",
        REPORT_LIBRARY_DB: db,
        REPORT_LIBRARY_BUCKET: {} as R2Bucket,
      },
    } as Parameters<typeof onRequestGet>[0]);

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      entries?: Array<{ ticker?: string }>;
      matchedTickers?: string[];
      total?: number;
    };
    expect(payload.total).toBe(1);
    expect(payload.entries?.map((entry) => entry.ticker)).toEqual(["MSFT"]);
    expect(payload.matchedTickers).toEqual(["MSFT"]);
  });
});

type ReportLibraryRow = {
  id: string;
  company_name: string;
  ticker: string | null;
  market: string | null;
  industry: string | null;
  sector: string | null;
  cqs: number;
  ias: number;
  conclusion: string;
  qualitative_band: string;
  position_advice: string;
  valuation_view: string;
  as_of: string;
  imported_at: string;
  evidence_count: number;
  score_item_count: number;
  object_key: string;
  report_hash: string;
};

function fakeReportLibraryD1(rows: ReportLibraryRow[]): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...values: unknown[]) => fakeStatementResult(sql, values, rows)),
    })),
  } as unknown as D1Database;
}

function fakeStatementResult(sql: string, values: unknown[], rows: ReportLibraryRow[]) {
  const filteredRows = filterRows(sql, values, rows);
  return {
    first: vi.fn().mockResolvedValue({ count: filteredRows.length }),
    all: vi.fn().mockResolvedValue({
      results: sql.includes("SELECT DISTINCT ticker")
        ? filteredRows.map((row) => ({ ticker: row.ticker })).filter((row) => row.ticker)
        : filteredRows,
    }),
  };
}

function filterRows(sql: string, values: unknown[], rows: ReportLibraryRow[]) {
  if (!sql.includes("ticker IN")) return rows;
  const tickers = new Set(values.filter((value): value is string => typeof value === "string"));
  return rows.filter((row) => row.ticker !== null && tickers.has(row.ticker));
}
