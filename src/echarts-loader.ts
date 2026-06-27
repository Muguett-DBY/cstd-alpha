import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

let registered = false;

export function loadSharedECharts() {
  if (!registered) {
    echarts.use([
      BarChart,
      LineChart,
      PieChart,
      ScatterChart,
      GridComponent,
      TooltipComponent,
      LegendComponent,
      CanvasRenderer,
    ]);
    registered = true;
  }
  return echarts;
}
