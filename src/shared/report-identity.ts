export type ReportIdentitySource = {
  company: {
    ticker?: unknown;
    market?: unknown;
    name?: unknown;
  };
};

export function reportIdentityKey(report: ReportIdentitySource) {
  const ticker = normalizeIdentity(report.company.ticker);
  const market = normalizeIdentity(report.company.market);
  const name = normalizeIdentity(report.company.name);
  return ticker ? `${market}:${ticker}` : `${market}:${name}`;
}

export function normalizeIdentity(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function stockCodeIdentity(value: unknown) {
  if (typeof value !== "string") return "";
  const match = value.trim().toUpperCase().match(/\b(\d{6})\b/);
  return match ? `CN:${match[1]}` : "";
}
