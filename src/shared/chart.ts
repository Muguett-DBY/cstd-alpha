import type { CompanyIdentity, EvidenceItem, InvestmentReport } from "./report";

export type PriceMode = "adjusted" | "raw";

export type PricePoint = {
  date: string;
  open?: number;
  close: number;
  adjustedClose: number;
  rawClose?: number;
  high?: number;
  low?: number;
  volume: number;
  amount?: number;
  changePercent?: number;
};

export type DrawdownPoint = {
  date: string;
  price: number;
  peak: number;
  drawdown: number;
};

export type MarketSnapshot = {
  currentPrice?: number;
  latestDate?: string;
  currency?: string;
  exchangeName?: string;
  maxDrawdown?: number;
  maxDrawdownDate?: string;
  source?: string;
};

export type ChartBundle = {
  company: CompanyIdentity;
  asOf: string;
  priceMode: PriceMode;
  priceSeries: PricePoint[];
  drawdownSeries: DrawdownPoint[];
  marketSnapshot: MarketSnapshot;
  evidence: EvidenceItem[];
};

export type ChartSeries = {
  label: string;
  points: Array<{ label: string; value: number }>;
};

export function normalizeChartBundle(value: ChartBundle): ChartBundle {
  const priceSeries = value.priceSeries.filter((point) => Number.isFinite(point.close));
  const drawdownSeries = value.drawdownSeries.length ? value.drawdownSeries : buildDrawdownSeries(priceSeries);
  const worstDrawdown = drawdownSeries.reduce<DrawdownPoint | undefined>((worst, point) => (!worst || point.drawdown < worst.drawdown ? point : worst), undefined);
  return {
    ...value,
    priceSeries,
    drawdownSeries,
    marketSnapshot: {
      ...value.marketSnapshot,
      latestDate: value.marketSnapshot.latestDate ?? priceSeries.at(-1)?.date,
      currentPrice: value.marketSnapshot.currentPrice ?? priceSeries.at(-1)?.close,
      maxDrawdown: value.marketSnapshot.maxDrawdown ?? worstDrawdown?.drawdown,
      maxDrawdownDate: value.marketSnapshot.maxDrawdownDate ?? worstDrawdown?.date,
    },
  };
}

export function buildDrawdownSeries(priceSeries: PricePoint[]): DrawdownPoint[] {
  let peak = 0;
  return priceSeries.map((point) => {
    peak = Math.max(peak, point.close);
    const drawdown = peak > 0 ? round(((point.close - peak) / peak) * 100, 2) : 0;
    return { date: point.date, price: point.close, peak, drawdown };
  });
}

export function extractFinancialChartSeries(report: InvestmentReport): ChartSeries[] {
  const targets = [
    { label: "营业收入", patterns: ["营业收入", "收入", "total revenue"] },
    { label: "净利润", patterns: ["归母净利润", "净利润", "net income"] },
    { label: "经营现金流", patterns: ["经营活动现金流", "经营现金流", "operating cash"] },
    { label: "资产负债率", patterns: ["资产负债率", "负债率", "debt"] },
  ];

  return targets
    .map((target) => {
      const row = report.financialTenYear.rows.find((item) => target.patterns.some((pattern) => item.metric.toLowerCase().includes(pattern.toLowerCase())));
      if (!row) return undefined;
      const points = Object.entries(row.values)
        .map(([label, raw]) => ({ label, value: parseMetricValue(raw) }))
        .filter((point): point is { label: string; value: number } => point.value !== undefined)
        .sort((a, b) => a.label.localeCompare(b.label));
      return points.length ? { label: target.label, points } : undefined;
    })
    .filter((item): item is ChartSeries => Boolean(item));
}

export function extractModuleScoreSeries(report: InvestmentReport): Array<{ label: string; value: number }> {
  return report.moduleScores.slice(0, 10).map((module) => ({ label: module.name, value: module.score }));
}

export function renderLineChartSvg({
  title,
  series,
  width = 720,
  height = 260,
  stroke = "#255f54",
}: {
  title: string;
  series: Array<{ label: string; value: number }>;
  width?: number;
  height?: number;
  stroke?: string;
}) {
  const padding = { top: 36, right: 24, bottom: 34, left: 52 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = series.map((point) => point.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const range = max - min || 1;
  const points = series.map((point, index) => {
    const x = padding.left + (series.length === 1 ? plotWidth : (index / (series.length - 1)) * plotWidth);
    const y = padding.top + plotHeight - ((point.value - min) / range) * plotHeight;
    return `${round(x, 1)},${round(y, 1)}`;
  });
  const first = series[0];
  const last = series.at(-1);

  return svgDocument(
    width,
    height,
    `<rect width="100%" height="100%" fill="#fffdf8"/>
    <text x="24" y="24" font-size="18" font-weight="700" fill="#211f1c">${escapeXml(title)}</text>
    <line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${width - padding.right}" y2="${padding.top + plotHeight}" stroke="#d8d0c4"/>
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" stroke="#d8d0c4"/>
    <polyline fill="none" stroke="${stroke}" stroke-width="3" points="${points.join(" ")}"/>
    ${first ? `<text x="${padding.left}" y="${height - 10}" font-size="12" fill="#6f675d">${escapeXml(first.label)}</text>` : ""}
    ${last ? `<text x="${width - padding.right - 80}" y="${height - 10}" font-size="12" fill="#6f675d">${escapeXml(last.label)}</text>` : ""}
    <text x="${padding.left}" y="${padding.top - 8}" font-size="12" fill="#6f675d">${formatNumber(max)}</text>
    <text x="${padding.left}" y="${padding.top + plotHeight + 16}" font-size="12" fill="#6f675d">${formatNumber(min)}</text>`,
  );
}

export function renderBarChartSvg({
  title,
  series,
  width = 720,
  height = 320,
}: {
  title: string;
  series: Array<{ label: string; value: number }>;
  width?: number;
  height?: number;
}) {
  const rowHeight = 24;
  const top = 42;
  const content = series
    .slice(0, 10)
    .map((point, index) => {
      const y = top + index * rowHeight;
      const barWidth = Math.max(2, Math.min(100, point.value)) * 4.8;
      return `<text x="24" y="${y + 14}" font-size="12" fill="#211f1c">${escapeXml(shortLabel(point.label))}</text>
      <rect x="180" y="${y}" width="500" height="14" fill="#efe6d8" rx="4"/>
      <rect x="180" y="${y}" width="${barWidth}" height="14" fill="#255f54" rx="4"/>
      <text x="${Math.min(690, 190 + barWidth)}" y="${y + 12}" font-size="12" fill="#211f1c">${formatNumber(point.value)}</text>`;
    })
    .join("");
  return svgDocument(
    width,
    height,
    `<rect width="100%" height="100%" fill="#fffdf8"/>
    <text x="24" y="26" font-size="18" font-weight="700" fill="#211f1c">${escapeXml(title)}</text>
    ${content}`,
  );
}

function parseMetricValue(value: string) {
  const cleaned = value.replace(/[,，]/g, "").trim();
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : undefined;
}

function svgDocument(width: number, height: number, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">${body}</svg>`;
}

function escapeXml(value: string) {
  return value.replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char] ?? char);
}

function formatNumber(value: number) {
  return Math.abs(value) >= 1000 ? value.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function shortLabel(value: string) {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
