import type { CompanyEvidencePackage } from "./company-evidence";
import { calculateActualReview, type QuantitativeDraft } from "../../src/shared/quantitative-valuation";
import type { ValuationResult } from "../../src/shared/valuation";

export function buildActualReviews(
  draft: QuantitativeDraft,
  result: ValuationResult,
  evidence: CompanyEvidencePackage,
): NonNullable<ValuationResult["actualReviews"]> {
  const rows = financialRows(evidence);
  const reported = {
    revenue: annualValues(rows, [/营业收入/, /营收/, /^收入$/]),
    ebit: annualValues(rows, [/^EBIT$/i, /息税前利润/, /营业利润/]),
    freeCashFlow: annualValues(rows, [/自由现金流/, /free cash flow/i]),
  };
  const baseYear = Number.parseInt(draft.asOf.slice(0, 4), 10);
  if (!Number.isInteger(baseYear)) return [];
  const inputs = [];
  for (const forecast of result.forecastRows ?? []) {
    const forecastYear = baseYear + forecast.year;
    for (const metricKey of ["revenue", "ebit", "freeCashFlow"] as const) {
      const actualValue = reported[metricKey].get(forecastYear);
      if (actualValue === undefined) continue;
      inputs.push({
        metricKey,
        forecastYear,
        forecastValue: forecast[metricKey],
        actualValue,
      });
    }
  }
  return calculateActualReview(inputs);
}

function financialRows(evidence: CompanyEvidencePackage) {
  const stableFacts = recordValue(evidence.stableFacts);
  const tenYear = recordValue(stableFacts?.financialTenYear);
  return Array.isArray(tenYear?.rows) ? tenYear.rows.map(recordValue).filter(Boolean) as Record<string, unknown>[] : [];
}

function annualValues(rows: Record<string, unknown>[], patterns: RegExp[]) {
  const row = rows.find((candidate) => patterns.some((pattern) => pattern.test(String(candidate.metric ?? ""))));
  const values = recordValue(row?.values);
  const result = new Map<number, number>();
  for (const [period, raw] of Object.entries(values ?? {})) {
    if (!/^\d{4}$/.test(period)) continue;
    const value = parseFinancialValue(raw);
    if (value !== undefined) result.set(Number(period), value);
  }
  return result;
}

function parseFinancialValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").replace(/[,，\s]/g, "");
  const negative = /^[（(].+[）)]$/.test(text);
  const normalized = text.replace(/[()（）]/g, "");
  const number = Number.parseFloat(normalized);
  if (!Number.isFinite(number)) return undefined;
  const signed = negative ? -number : number;
  if (normalized.includes("万亿")) return signed * 10_000;
  if (normalized.includes("亿")) return signed;
  if (normalized.includes("万")) return signed / 10_000;
  if (normalized.includes("元")) return signed / 100_000_000;
  return signed;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

