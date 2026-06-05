import { useEffect, useMemo, useState } from "react";
import { createValuationRun, fetchResearchItems, fetchValuations } from "./api";
import type { ResearchWorkbenchItem } from "./shared/research-workbench";
import type { ValuationRunSummary } from "./shared/valuation";

export function ValuationLabView() {
  const [runs, setRuns] = useState<ValuationRunSummary[]>([]);
  const [items, setItems] = useState<ResearchWorkbenchItem[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const selected = useMemo(() => items.find((item) => item.id === selectedEntityId) ?? items[0], [items, selectedEntityId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchValuations(), fetchResearchItems()])
      .then(([valuationData, researchData]) => {
        if (cancelled) return;
        setRuns(valuationData.runs);
        setItems(researchData.items);
        setSelectedEntityId((current) => current || researchData.items[0]?.id || "");
        setPhase("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : "估值实验室读取失败。");
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function startValuation() {
    if (!selected) return;
    try {
      const run = await createValuationRun({
        researchItemId: selected.id,
        entityType: selected.entityType,
        entityId: selected.entityId,
        title: selected.title,
        industry: selected.subtitle,
        currency: inferCurrency(selected.subtitle),
        evidenceHash: selected.evidenceHash,
      });
      setRuns((current) => [run, ...current]);
      setMessage(`${selected.title} 估值任务已进入后台队列。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "估值任务创建失败。");
    }
  }

  return (
    <section className="workbench-page valuation-page">
      <div className="workbench-hero compact">
        <div>
          <p className="eyebrow">估值实验室</p>
          <h1>由 AI 生成假设，公式负责计算结果</h1>
          <p className="hero-copy">普通企业、银行保险和周期资源会自动切换方法；每次估值都保存为版本。</p>
        </div>
        <button type="button" className="primary-action" onClick={startValuation} disabled={!selected}>创建估值任务</button>
      </div>
      {message ? <div className="workbench-notice">{message}</div> : null}
      {phase === "loading" ? <div className="workbench-empty">正在读取估值历史…</div> : null}
      {phase === "error" ? <div className="workbench-empty error">{message}</div> : null}
      {phase === "ready" ? (
        <div className="valuation-layout">
          <aside className="terminal-panel valuation-picker">
            <header className="panel-header">
              <h2>研究对象</h2>
              <p>从研究队列选择对象后生成估值。</p>
            </header>
            {items.length ? items.map((item) => (
              <button type="button" key={item.id} className={`valuation-pick ${selected?.id === item.id ? "selected" : ""}`} onClick={() => setSelectedEntityId(item.id)}>
                <strong>{item.title}</strong>
                <span>{item.subtitle || item.entityType}</span>
              </button>
            )) : <div className="workbench-empty compact">先从今日机会加入研究对象。</div>}
          </aside>

          <main className="terminal-panel valuation-result">
            <header className="panel-header">
              <h2>估值版本</h2>
              <p>运行完成后展示三情景、关键假设、敏感性和同业区间。</p>
            </header>
            {runs.length ? runs.map((run) => <ValuationRunCard key={run.id} run={run} />) : <div className="workbench-empty compact">暂无估值记录。</div>}
          </main>
        </div>
      ) : null}
    </section>
  );
}

function ValuationRunCard({ run }: { run: ValuationRunSummary }) {
  const scenarios = run.result?.scenarios ?? [];
  return (
    <article className={`valuation-run-card ${run.status}`}>
      <div className="valuation-run-head">
        <div>
          <strong>{run.title}</strong>
          <p>{methodLabel(run.method)} / {archetypeLabel(run.archetype)} / {run.currency}</p>
        </div>
        <span className="status-pill">{statusLabel(run.status)}</span>
      </div>
      {scenarios.length ? (
        <>
          <div className="scenario-strip">
            {scenarios.map((scenario) => (
              <div key={scenario.scenario}>
                <span>{scenarioLabel(scenario.scenario)}</span>
                <strong>{formatMoney(scenario.perShareValue, run.currency)}</strong>
                <small>{scenario.summary}</small>
              </div>
            ))}
          </div>
          {run.result?.forecastRows?.length ? (
            <div className="valuation-table-wrap">
              <table className="financial-mini-table">
                <thead><tr><th>年份</th><th>收入</th><th>EBIT</th><th>FCF</th></tr></thead>
                <tbody>
                  {run.result.forecastRows.map((row) => (
                    <tr key={row.year}><td>第{row.year}年</td><td>{formatNumber(row.revenue)}</td><td>{formatNumber(row.ebit)}</td><td>{formatNumber(row.freeCashFlow)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : (
        <p className="valuation-pending">{run.status === "failed" ? "估值任务失败，可稍后重试。" : "估值任务正在后台运行。"}</p>
      )}
    </article>
  );
}

function methodLabel(value: string) {
  if (value === "ddm_residual_income") return "DDM/剩余收益";
  if (value === "mid_cycle_nav") return "中周期/NAV";
  return "三表 DCF";
}

function archetypeLabel(value: string) {
  if (value === "bank") return "银行";
  if (value === "insurance") return "保险";
  if (value === "cyclical") return "周期资源";
  return "普通企业";
}

function statusLabel(value: string) {
  if (value === "completed") return "已完成";
  if (value === "running") return "运行中";
  if (value === "failed") return "失败";
  return "排队中";
}

function scenarioLabel(value: string) {
  if (value === "bear") return "保守";
  if (value === "bull") return "乐观";
  return "中性";
}

function inferCurrency(subtitle?: string) {
  if (/港股|HK|H股/i.test(subtitle ?? "")) return "HKD";
  if (/美股|NASDAQ|NYSE|USD/i.test(subtitle ?? "")) return "USD";
  return "CNY";
}

function formatMoney(value: number, currency: string) {
  return `${currency} ${formatNumber(value)}`;
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "-";
}
