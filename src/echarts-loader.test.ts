import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("ECharts bundle boundaries", () => {
  test("uses named ECharts imports in a shared lazy loader", () => {
    const loader = readFileSync("src/echarts-loader.ts", "utf8");
    const chartSources = [
      "src/AssistantView.tsx",
      "src/OpportunityDashboard.tsx",
      "src/RadarVisualCharts.tsx",
    ].map((file) => readFileSync(file, "utf8")).join("\n");

    expect(loader).toContain('from "echarts/core"');
    expect(loader).toContain("BarChart");
    expect(loader).toContain("LineChart");
    expect(loader).toContain("PieChart");
    expect(loader).toContain("ScatterChart");
    expect(chartSources).not.toContain('import("echarts/charts")');
    expect(chartSources).not.toContain('import("echarts/components")');
    expect(chartSources).not.toContain('import("echarts/renderers")');
  });
});
