import { useState, useEffect, useRef } from "react";
import type { EChartsType } from "echarts";
import type { RadarIndustryPacket, RadarIndustryStage } from "./shared/radar";

type RadarVisualChartsProps = {
  packets: RadarIndustryPacket[];
  onSelectIndustry: (industry: string) => void;
};

const STAGE_COLORS: Record<RadarIndustryStage, string> = {
  扎实增长: "#d64f32",
  即将增长: "#f08c2e",
  泡沫风险: "#8b5cf6",
  衰退: "#2f6f73",
  平稳现金流: "#2e7d57",
  继续观察: "#2f6ba7",
  证据不足: "#8a969d",
};

export function RadarVisualCharts({ packets, onSelectIndustry }: RadarVisualChartsProps) {
  return (
    <div className="radar-echarts-grid" aria-label="雷达图形化总览">
      <RadarBubbleChart packets={packets} onSelectIndustry={onSelectIndustry} />
      <RadarStageDistribution packets={packets} onSelectIndustry={onSelectIndustry} />
    </div>
  );
}

async function loadRadarECharts() {
  const [core, charts, components, renderers] = await Promise.all([import("echarts/core"), import("echarts/charts"), import("echarts/components"), import("echarts/renderers")]);
  core.use([charts.ScatterChart, charts.BarChart, components.GridComponent, components.TooltipComponent, renderers.CanvasRenderer]);
  return core;
}

function RadarBubbleChart({ packets, onSelectIndustry }: RadarVisualChartsProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [chartState, setChartState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let disposed = false;
    let chart: EChartsType | null = null;
    loadRadarECharts()
      .then((echarts) => {
        if (!ref.current || disposed) return;
        const nextChart = echarts.init(ref.current, undefined, { renderer: "canvas" });
        chart = nextChart;
        const data = packets.map((packet) => {
          const scores = packet.scores ?? emptyScores();
          const growth = Math.round(Math.max(scores.growth, scores.momentum));
          const risk = Math.round(Math.max(scores.bubbleRisk, scores.declineRisk, scores.valuationRisk));
          const stage = packet.stage ?? "证据不足";
          return {
            name: packet.industry,
            value: [growth, risk, Math.max(6, Math.sqrt(packet.sourceCount || 0) * 6 + Math.max(0, scores.evidence) / 4), packet.sourceCount],
            itemStyle: { color: STAGE_COLORS[stage] },
            stage,
            group: packet.group,
          };
        });
        nextChart.setOption({
          animation: false,
          grid: { top: 34, right: 24, bottom: 42, left: 46 },
          tooltip: {
            trigger: "item",
            formatter: (params: { data?: { name?: string; value?: number[]; stage?: string; group?: string } }) => {
              const item = params.data;
              if (!item?.value) return "";
              return `${item.name}<br/>阶段：${item.stage}<br/>增长动量：${item.value[0]}<br/>风险压力：${item.value[1]}<br/>证据：${item.value[3]} 条<br/>分组：${item.group || "未分组"}`;
            },
          },
          xAxis: { name: "增长动量", min: 0, max: 100, splitLine: { lineStyle: { color: "#e3e8e5" } } },
          yAxis: { name: "风险压力", min: 0, max: 100, splitLine: { lineStyle: { color: "#e3e8e5" } } },
          series: [
            {
              type: "scatter",
              data,
              symbolSize: (value: number[]) => Math.max(8, Math.min(44, value[2] || 10)),
              label: {
                show: true,
                formatter: "{b}",
                position: "right",
                color: "#111418",
                fontSize: 11,
              },
              emphasis: { focus: "self" },
            },
          ],
        });
        nextChart.on("click", (params: unknown) => {
          const data = (params as { data?: { name?: string } }).data;
          if (data?.name) onSelectIndustry(data.name);
        });
        if (!disposed) setChartState("ready");
      })
      .catch(() => { if (!disposed) setChartState("error"); });
    const resize = () => chart?.resize();
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      chart?.dispose();
    };
  }, [onSelectIndustry, packets]);
  return (
    <article className="radar-echart-card">
      <div>
        <h4>产业热力气泡图</h4>
        <p>横轴增长动量，纵轴风险压力，气泡越大代表证据越多。</p>
      </div>
      {chartState === "loading" ? <div className="radar-echart-loading">加载图表中…</div> : null}
      {chartState === "error" ? <div className="radar-echart-loading">图表加载失败</div> : null}
      <div ref={ref} className="radar-echart-canvas" style={chartState !== "ready" ? { display: "none" } : undefined} />
    </article>
  );
}

function RadarStageDistribution({ packets, onSelectIndustry }: RadarVisualChartsProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [chartState, setChartState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let disposed = false;
    let chart: EChartsType | null = null;
    loadRadarECharts()
      .then((echarts) => {
        if (!ref.current || disposed) return;
        const nextChart = echarts.init(ref.current, undefined, { renderer: "canvas" });
        chart = nextChart;
        const buckets = stageBuckets(packets);
        nextChart.setOption({
          animation: false,
          tooltip: { trigger: "item" },
          grid: { top: 28, right: 18, bottom: 28, left: 78 },
          xAxis: { type: "value", minInterval: 1, splitLine: { lineStyle: { color: "#e3e8e5" } } },
          yAxis: { type: "category", data: buckets.map((bucket) => bucket.stage), axisLabel: { color: "#2d3a37" } },
          series: [
            {
              type: "bar",
              data: buckets.map((bucket) => ({
                name: bucket.stage,
                value: bucket.count,
                itemStyle: { color: STAGE_COLORS[bucket.stage] },
                industries: bucket.industries,
              })),
              label: { show: true, position: "right" },
            },
          ],
        });
        nextChart.on("click", (params: unknown) => {
          const stage = (params as { name?: RadarIndustryStage }).name;
          const first = packets.find((packet) => (packet.stage ?? "证据不足") === stage);
          if (first) onSelectIndustry(first.industry);
        });
        if (!disposed) setChartState("ready");
      })
      .catch(() => { if (!disposed) setChartState("error"); });
    const resize = () => chart?.resize();
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      chart?.dispose();
    };
  }, [onSelectIndustry, packets]);
  return (
    <article className="radar-echart-card">
      <div>
        <h4>产业阶段分布</h4>
        <p>展示全行业包阶段，正式结论数量以卡片章节为准。</p>
      </div>
      {chartState === "loading" ? <div className="radar-echart-loading">加载图表中…</div> : null}
      {chartState === "error" ? <div className="radar-echart-loading">图表加载失败</div> : null}
      <div ref={ref} className="radar-echart-canvas radar-stage-chart" style={chartState !== "ready" ? { display: "none" } : undefined} />
    </article>
  );
}

function stageBuckets(packets: RadarIndustryPacket[]) {
  const stages: RadarIndustryStage[] = ["扎实增长", "即将增长", "泡沫风险", "衰退", "平稳现金流", "继续观察", "证据不足"];
  return stages
    .map((stage) => ({
      stage,
      count: packets.filter((packet) => (packet.stage ?? "证据不足") === stage).length,
      industries: packets.filter((packet) => (packet.stage ?? "证据不足") === stage).map((packet) => packet.industry),
    }))
    .filter((bucket) => bucket.count > 0);
}

function emptyScores() {
  return { growth: 0, momentum: 0, evidence: 0, valuationRisk: 0, bubbleRisk: 0, declineRisk: 0, confidence: 0, change: 0 };
}
