import type { ReactNode } from "react";
import { LightweightPriceChart } from "./LightweightPriceChart";
import { extractFinancialChartSeries, extractModuleScoreSeries, type ChartBundle, type ChartSeries, type PriceMode } from "./shared/chart";
import type { InvestmentReport } from "./shared/report";

export type ChartPhase = "idle" | "loading" | "ready" | "error";

export function ChartDashboard({
  chartBundle,
  chartPhase,
  report,
  priceMode,
}: {
  chartBundle: ChartBundle | null;
  chartPhase: ChartPhase;
  report: InvestmentReport | null;
  priceMode: PriceMode;
}) {
  const priceSeries = chartBundle?.priceSeries.map((point) => ({ label: point.date, value: point.close })) ?? [];
  const drawdownSeries = chartBundle?.drawdownSeries.map((point) => ({ label: point.date, value: point.drawdown })) ?? [];
  const financialSeries = report ? extractFinancialChartSeries(report) : [];
  const moduleScores = report ? extractModuleScoreSeries(report) : [];
  const hasPriceData = priceSeries.length > 0;

  return (
    <section className="chart-dashboard">
      <header>
        <div>
          <p className="eyebrow">图表驾驶舱</p>
          <h2>{chartBundle?.company.name ?? "正在准备图表"}</h2>
          <p className="muted">
            {priceMode === "adjusted" ? "前复权/调整价" : "原始收盘价"}口径
            {chartBundle?.marketSnapshot.latestDate ? ` / 最新数据 ${chartBundle.marketSnapshot.latestDate}` : ""}
          </p>
        </div>
        <div className="chart-metrics">
          <InfoTile title="最新价格" value={formatMetric(chartBundle?.marketSnapshot.currentPrice)} />
          <InfoTile title="最大回撤" value={formatPercent(chartBundle?.marketSnapshot.maxDrawdown)} />
          <InfoTile title="数据点" value={chartBundle ? `${chartBundle.priceSeries.length} 个` : chartPhase === "loading" ? "读取中" : "待生成"} />
        </div>
      </header>

      {chartPhase === "loading" ? <p className="chart-placeholder">正在读取公开历史行情并计算回撤...</p> : null}
      {chartPhase === "error" && !chartBundle ? <p className="chart-placeholder">图表数据生成失败，请稍后重试。</p> : null}

      <div className="chart-grid">
        <ChartCard title="十年股价走势" empty={!hasPriceData} emptyText="公开历史价格数据不足，无法绘制股价图。">
          <LightweightPriceChart series={priceSeries} />
        </ChartCard>
        <ChartCard title="最大回撤曲线" empty={!drawdownSeries.length} emptyText="价格序列不足，无法计算回撤。">
          <LineChart series={drawdownSeries} stroke="#b3432f" suffix="%" />
        </ChartCard>
        <ChartCard title="财务趋势" empty={!financialSeries.length} emptyText="生成完整评分报告后，会从十年财务表提取收入、利润、现金流和负债率。">
          <FinancialMiniCharts series={financialSeries} />
        </ChartCard>
        <ChartCard title="估值安全边际" empty={!report} emptyText="生成完整评分报告后，会显示当前价格与合理价值、买入区间、减仓区间的关系。">
          {report ? <ValuationRange report={report} currentPrice={chartBundle?.marketSnapshot.currentPrice} /> : null}
        </ChartCard>
        <ChartCard title="10 大模块评分" empty={!moduleScores.length} emptyText="生成完整评分报告后，会显示 10 大模块评分。">
          <ScoreBarChart series={moduleScores} />
        </ChartCard>
      </div>

      {chartBundle?.evidence.length ? (
        <div className="chart-evidence">
          {chartBundle.evidence.map((item) => (
            <a key={`${item.title}-${item.url}`} href={item.url || undefined} target="_blank" rel="noreferrer">
              {item.title} / {item.freshness}
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function InfoTile({ title, value }: { title: string; value: string }) {
  return (
    <div className="info-tile">
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ChartCard({ title, empty, emptyText, children }: { title: string; empty: boolean; emptyText: string; children: ReactNode }) {
  return (
    <section className="chart-card">
      <h3>{title}</h3>
      {empty ? <p className="chart-placeholder">{emptyText}</p> : children}
    </section>
  );
}

function LineChart({ series, stroke, suffix = "" }: { series: Array<{ label: string; value: number }>; stroke: string; suffix?: string }) {
  const width = 640;
  const height = 220;
  const padding = { top: 18, right: 18, bottom: 32, left: 48 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = series.map((point) => point.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const range = max - min || 1;
  const points = series.map((point, index) => {
    const x = padding.left + (series.length === 1 ? plotWidth : (index / (series.length - 1)) * plotWidth);
    const y = padding.top + plotHeight - ((point.value - min) / range) * plotHeight;
    return `${x},${y}`;
  });
  const first = series[0];
  const last = series.at(-1);

  return (
    <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img">
      <line x1={padding.left} y1={padding.top + plotHeight} x2={width - padding.right} y2={padding.top + plotHeight} />
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + plotHeight} />
      <polyline points={points.join(" ")} fill="none" stroke={stroke} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <text x={padding.left} y={padding.top - 6}>{formatMetric(max, suffix)}</text>
      <text x={padding.left} y={padding.top + plotHeight + 18}>{formatMetric(min, suffix)}</text>
      {first ? <text x={padding.left} y={height - 8}>{first.label}</text> : null}
      {last ? <text x={width - padding.right - 90} y={height - 8}>{last.label}</text> : null}
    </svg>
  );
}

function FinancialMiniCharts({ series }: { series: ChartSeries[] }) {
  return (
    <div className="financial-mini-grid">
      {series.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <LineChart series={item.points} stroke={item.label.includes("负债") ? "#b3432f" : "#255f54"} />
        </div>
      ))}
    </div>
  );
}

function ScoreBarChart({ series }: { series: Array<{ label: string; value: number }> }) {
  return (
    <div className="score-bars">
      {series.map((item) => (
        <div key={item.label} className="score-bar-row">
          <span>{item.label}</span>
          <div>
            <i style={{ width: `${Math.max(2, Math.min(100, item.value))}%` }} />
          </div>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function ValuationRange({ report, currentPrice }: { report: InvestmentReport; currentPrice?: number }) {
  const current = currentPrice ?? parseNumbers(report.valuationAnalysis.currentPrice)[0];
  const fair = parseNumbers(report.valuationAnalysis.fairValueRange);
  const buy = parseNumbers(report.valuationAnalysis.buyRange);
  const sell = parseNumbers(report.valuationAnalysis.sellReduceRange);
  const values = [current, ...fair, ...buy, ...sell].filter((value): value is number => value !== undefined);
  if (!values.length) return <p className="chart-placeholder">估值区间无法解析为图形，保留文字判断：{report.valuationAnalysis.conclusion}</p>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const position = (value: number) => ((value - min) / span) * 100;
  const buyLow = buy.length >= 2 ? Math.min(...buy) : min;
  const buyHigh = buy.length >= 2 ? Math.max(...buy) : buy[0];
  const fairLow = fair.length >= 2 ? Math.min(...fair) : undefined;
  const fairHigh = fair.length >= 2 ? Math.max(...fair) : undefined;
  return (
    <div className="valuation-range">
      <div className="range-track">
        {buyHigh !== undefined ? <span className="buy-range" style={{ left: `${position(buyLow)}%`, width: `${Math.max(2, position(buyHigh) - position(buyLow))}%` }} /> : null}
        {fairLow !== undefined && fairHigh !== undefined ? <span className="fair-range" style={{ left: `${position(fairLow)}%`, width: `${Math.max(2, position(fairHigh) - position(fairLow))}%` }} /> : null}
        {sell[0] !== undefined ? <span className="sell-marker" style={{ left: `${position(sell[0])}%` }} /> : null}
        {current !== undefined ? <span className="current-marker" style={{ left: `${position(current)}%` }} /> : null}
      </div>
      <div className="range-labels">
        <span>低估/买入：{report.valuationAnalysis.buyRange}</span>
        <span>合理：{report.valuationAnalysis.fairValueRange}</span>
        <span>当前：{formatMetric(current)}</span>
      </div>
      <p>{report.valuationAnalysis.conclusion}</p>
    </div>
  );
}

function parseNumbers(value: string) {
  return Array.from(value.replace(/[,，]/g, "").replace(/(\d)\s*[-–—~至到]\s*(\d)/g, "$1 $2").matchAll(/-?\d+(?:\.\d+)?/g))
    .map((match) => Number(match[0]))
    .filter((number) => Number.isFinite(number));
}

function formatMetric(value?: number, suffix = "") {
  if (value === undefined || Number.isNaN(value)) return "暂无";
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿${suffix}`;
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(2)}万${suffix}`;
  return `${Number(value.toFixed(2)).toLocaleString("zh-CN")}${suffix}`;
}

function formatPercent(value?: number) {
  if (value === undefined || Number.isNaN(value)) return "暂无";
  return `${value.toFixed(2)}%`;
}
