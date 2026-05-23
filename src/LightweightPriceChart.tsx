import { useEffect, useRef } from "react";

type LightweightPriceChartProps = {
  series: Array<{ label: string; value: number }>;
};

type LightweightChartApi = {
  addSeries: (seriesType: unknown, options: Record<string, unknown>) => { setData: (data: Array<{ time: string; value: number }>) => void };
  timeScale: () => { fitContent: () => void };
  applyOptions: (options: Record<string, unknown>) => void;
  remove: () => void;
};

export function LightweightPriceChart({ series }: LightweightPriceChartProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let disposed = false;
    let chart: LightweightChartApi | null = null;
    const data = series
      .map((point) => ({ time: normalizeChartDate(point.label), value: point.value }))
      .filter((point) => point.time && Number.isFinite(point.value)) as Array<{ time: string; value: number }>;
    void import("lightweight-charts").then((module) => {
      if (!ref.current || disposed || !data.length) return;
      chart = module.createChart(ref.current, {
        autoSize: true,
        height: 220,
        layout: { background: { color: "transparent" }, textColor: "#465450" },
        grid: { vertLines: { color: "#edf1ef" }, horzLines: { color: "#edf1ef" } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: false },
        crosshair: { mode: 1 },
      }) as LightweightChartApi;
      const line = chart.addSeries(module.LineSeries, {
        color: "#255f54",
        lineWidth: 2,
        lastValueVisible: true,
        priceLineVisible: false,
      });
      line.setData(data);
      chart.timeScale().fitContent();
    });
    return () => {
      disposed = true;
      chart?.remove();
    };
  }, [series]);
  return <div ref={ref} className="lightweight-price-chart" />;
}

function normalizeChartDate(label: string) {
  const match = label.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}
