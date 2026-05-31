export type ReportIdentitySource = {
  company: {
    ticker?: ReportIdentityValue;
    market?: ReportIdentityValue;
    name?: ReportIdentityValue;
  };
};

export type ReportIdentityValue = string | number | null | undefined;

export function reportIdentityKey(report: ReportIdentitySource): string {
  const ticker = normalizeIdentity(report.company.ticker);
  const market = normalizeIdentity(report.company.market);
  const name = normalizeIdentity(report.company.name);
  return ticker ? `${market}:${ticker}` : `${market}:${name}`;
}

export function normalizeIdentity(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim().toUpperCase();
}

export function stockCodeIdentity(value: unknown): string {
  if (value === null || value === undefined) return "";
  const match = String(value).trim().toUpperCase().match(/\b(\d{6})\b/);
  return match ? `CN:${match[1]}` : "";
}
