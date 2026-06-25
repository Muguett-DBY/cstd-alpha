import { scenarioBarHeight } from "./valuation-scenario-chart-state";

type ScenarioData = {
  scenario: "bear" | "base" | "bull";
  label: string;
  value: number;
  currency: string;
  upside?: number;
};

type ValuationScenarioChartProps = {
  scenarios: ScenarioData[];
  currentPrice?: number;
  currency: string;
};

function scenarioColor(scenario: string) {
  if (scenario === "bear") return "var(--red)";
  if (scenario === "bull") return "var(--teal)";
  return "var(--blue)";
}

function formatMoney(value: number, currency: string) {
  return `${currency} ${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

export function ValuationScenarioChart({ scenarios, currentPrice, currency }: ValuationScenarioChartProps) {
  const maxValue = Math.max(...scenarios.map((s) => s.value), 1);
  
  return (
    <div className="valuation-scenario-chart" role="img" aria-label="估值情景图表">
      <div className="valuation-scenario-bars">
        {scenarios.map((item) => {
          const height = scenarioBarHeight(item.value, maxValue);
          return (
            <div key={item.scenario} className="valuation-scenario-bar-group">
              <div className="valuation-scenario-value">
                {formatMoney(item.value, item.currency)}
              </div>
              <div 
                className="valuation-scenario-bar"
                style={{ 
                  height: `${height}px`,
                  backgroundColor: scenarioColor(item.scenario)
                }}
              >
                <div className="valuation-scenario-label">{item.label}</div>
              </div>
            </div>
          );
        })}
      </div>
      {currentPrice && (
        <div className="valuation-scenario-legend">
          <span>当前价格: {formatMoney(currentPrice, currency)}</span>
        </div>
      )}
    </div>
  );
}
