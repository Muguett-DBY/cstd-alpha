import { useEffect, useMemo, useState } from "react";
import { createValuationRun, fetchResearchItems, fetchValuations } from "./api";
import { showToast } from "./toast-state";
import type { ResearchWorkbenchItem } from "./shared/research-workbench";
import type { ValuationRunSummary } from "./shared/valuation";
import {
  filterValuationRunsForDisplay,
  mergeValuationRuns,
  retryValuationInputFromRun,
  valuationAssumptionsForDisplay,
} from "./valuation-state";

export function ValuationLabView() {
  const [runs, setRuns] = useState<ValuationRunSummary[]>([]);
  const [items, setItems] = useState<ResearchWorkbenchItem[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [sortBy, setSortBy] = useState<"updated" | "base" | "bull" | "bear">("updated");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const selected = useMemo(() => items.find((item) => item.id === selectedEntityId) ?? items[0], [items, selectedEntityId]);
  const activeRunIds = useMemo(
    () => runs.filter((run) => run.status === "queued" || run.status === "running").map((run) => run.id).sort().join(","),
    [runs],
  );
  const displayRuns = useMemo(() => {
    const base = filterValuationRunsForDisplay(runs);
    if (sortBy === "updated") {
      return [...base].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    const sortKey = sortBy;
    return [...base].sort((a, b) => {
      const aVal = a.result?.scenarios.find((s) => s.scenario === sortKey)?.perShareValue ?? -Infinity;
      const bVal = b.result?.scenarios.find((s) => s.scenario === sortKey)?.perShareValue ?? -Infinity;
      return bVal - aVal;
    });
  }, [runs, sortBy]);

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
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!activeRunIds) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const latest = await fetchValuations();
        if (!cancelled) setRuns((current) => mergeValuationRuns(current, latest.runs));
      } catch {
        // Keep the optimistic task visible and retry on the next interval.
      }
    };
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRunIds]);

  async function startValuation() {
    if (!selected) return;
    try {
      const run = await createValuationRun({
        researchItemId: selected.id,
        entityType: selected.entityType,
        entityId: selected.entityId,
        title: selected.title,
        industry: selected.subtitle,
        currency: inferCurrency(selected.entityId, selected.subtitle),
        evidenceHash: selected.evidenceHash,
      });
      setRuns((current) => [run, ...current]);
        showToast(`${selected.title} 估值任务已进入后台队列。`, "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "估值任务创建失败。");
    }
  }

  async function retryValuation(run: ValuationRunSummary) {
    try {
      const nextRun = await createValuationRun(retryValuationInputFromRun(run));
      setRuns((current) => [nextRun, ...current]);
      showToast(`${run.title} 估值任务已重新进入后台队列。`, "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "估值任务重新创建失败。");
    }
  }

  return (
    <section className="workbench-page valuation-page">
      <div className="workbench-hero compact">
        <div>
          <p className="eyebrow">估值实验室</p>
          <h1>由 AI 生成假设，公式负责计算结果</h1>
          <p className="hero-copy">普通企业、银行保险和周期资源会自动切换方法；每次估值都保存为版本。估值任务也可以从研究工作台直接创建。</p>
        </div>
        <button type="button" className="primary-action" onClick={startValuation} disabled={!selected}>创建估值任务</button>
      </div>
      {message ? <div className="workbench-notice">{message}</div> : null}
      {phase === "loading" ? <div className="workbench-empty">正在读取估值历史…</div> : null}
      {phase === "error" ? (
        <div className="workbench-empty error">
          <p>{message}</p>
          <button type="button" className="secondary-button" onClick={() => { setPhase("loading"); setMessage(""); void Promise.all([fetchValuations(), fetchResearchItems()]).then(([valuationData, researchData]) => { setRuns(valuationData.runs); setItems(researchData.items); setSelectedEntityId((current) => current || researchData.items[0]?.id || ""); setPhase("ready"); }).catch((error) => { setMessage(error instanceof Error ? error.message : "估值实验室读取失败。"); setPhase("error"); }); }}>重试</button>
        </div>
      ) : null}
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
            {displayRuns.length ? (
              <>
                <div className="valuation-sort-bar" role="group" aria-label="排序">
                  <span className="filter-label">排序</span>
                  {[
                    { key: "updated" as const, label: "最近更新" },
                    { key: "base" as const, label: "中性情景" },
                    { key: "bull" as const, label: "乐观情景" },
                    { key: "bear" as const, label: "保守情景" },
                  ].map((opt) => (
                    <button key={opt.key} type="button" className={`valuation-sort-pill ${sortBy === opt.key ? "active" : ""}`} onClick={() => setSortBy(opt.key)}>
                      {opt.label}
                    </button>
                  ))}
                </div>
                <ValuationVersionTrend runs={displayRuns} />
                {displayRuns.map((run) => (
                  <ValuationRunCard
                    key={run.id}
                    run={run}
                    onRetry={retryValuation}
                    isComparing={compareIds.includes(run.id)}
                    canCompare={compareIds.length < 2}
                    onCompareToggle={(id) => {
                      setCompareIds((current) => current.includes(id) ? current.filter((x) => x !== id) : current.length < 2 ? [...current, id] : current);
                    }}
                  />
                ))}
                {compareIds.length === 2 ? (
                  <ValuationCompareStrip compareIds={compareIds} runs={displayRuns} onClear={() => setCompareIds([])} />
                ) : compareIds.length === 1 ? (
                  <div className="valuation-compare-hint">再选 1 个版本开始对比</div>
                ) : null}
              </>
            ) : <div className="workbench-empty compact">暂无可信估值记录。</div>}
          </main>
        </div>
      ) : null}
    </section>
  );
}

function ValuationVersionTrend({ runs }: { runs: ValuationRunSummary[] }) {
  const trend = useMemo(() => {
    const completed = runs
      .filter((r) => r.status === "completed" && r.result?.scenarios)
      .slice(0, 8);
    if (completed.length < 2) return null;
    const baseByRun = completed.map((r) => {
      const base = r.result?.scenarios.find((s) => s.scenario === "base");
      return {
        id: r.id,
        title: r.title,
        asOf: r.createdAt,
        value: base?.perShareValue ?? null,
        currency: r.currency,
      };
    }).filter((entry) => entry.value !== null);

    if (baseByRun.length < 2) return null;
    const newest = baseByRun[0];
    const oldest = baseByRun[baseByRun.length - 1];
    const delta = (newest.value as number) - (oldest.value as number);
    const deltaPct = oldest.value ? (delta / oldest.value) * 100 : 0;
    return {
      count: baseByRun.length,
      newest,
      oldest,
      delta,
      deltaPct,
      points: baseByRun.reverse(),
    };
  }, [runs]);

  if (!trend) return null;
  const isUp = trend.delta >= 0;
  return (
    <div className="valuation-trend" role="img" aria-label={`最近 ${trend.count} 次估值变化：${isUp ? "上升" : "下降"} ${Math.abs(trend.delta).toFixed(2)} ${trend.newest.currency}（${trend.deltaPct.toFixed(1)}%）`}>
      <div className="valuation-trend-head">
        <span className="valuation-trend-label">最近 {trend.count} 次中性估值趋势</span>
        <span className={`valuation-trend-delta ${isUp ? "up" : "down"}`}>
          {isUp ? "↑" : "↓"} {Math.abs(trend.delta).toFixed(2)} {trend.newest.currency} ({trend.deltaPct.toFixed(1)}%)
        </span>
      </div>
      <div className="valuation-trend-points" aria-hidden="true">
        {trend.points.map((point, index) => {
          const minVal = Math.min(...trend.points.map((p) => p.value as number));
          const maxVal = Math.max(...trend.points.map((p) => p.value as number));
          const range = maxVal - minVal || 1;
          const height = 20 + ((point.value as number - minVal) / range) * 60;
          return (
            <span key={point.id || index} className="valuation-trend-bar" style={{ height: `${height}%` }} title={`${point.title} ${point.asOf}: ${point.value} ${point.currency}`} />
          );
        })}
      </div>
    </div>
  );
}

function ValuationRunCard({ run, onRetry, onCompareToggle, isComparing, canCompare }: { run: ValuationRunSummary; onRetry?: (run: ValuationRunSummary) => void; onCompareToggle?: (id: string) => void; isComparing?: boolean; canCompare?: boolean }) {
  const scenarios = useMemo(() => run.result?.scenarios ?? [], [run]);
  const assumptions = valuationAssumptionsForDisplay(run);
  const rangeInfo = useMemo(() => {
    if (scenarios.length < 2) return null;
    const values = scenarios.map((s) => s.perShareValue).filter((v) => Number.isFinite(v));
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mid = [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? values[0];
    return { min, max, mid, spread: max - min, spreadPct: min > 0 ? ((max - min) / min) * 100 : 0 };
  }, [scenarios]);

  return (
    <article className={`valuation-run-card ${run.status} ${isComparing ? "comparing" : ""}`}>
      <div className="valuation-run-head">
        <div>
          <strong>{run.title}</strong>
          <p>{methodLabel(run.method)} / {archetypeLabel(run.archetype)} / {run.currency}</p>
        </div>
        <div className="valuation-run-head-actions">
          {onCompareToggle && run.status === "completed" ? (
            <label className="valuation-compare-toggle">
              <input
                type="checkbox"
                checked={isComparing ?? false}
                disabled={!isComparing && !canCompare}
                onChange={() => onCompareToggle(run.id)}
                aria-label={`选择 ${run.title} 进行对比`}
              />
              <span>对比</span>
            </label>
          ) : null}
          <span className="status-pill">{statusLabel(run.status)}</span>
        </div>
      </div>
      {scenarios.length ? (
        <>
          <div className="scenario-strip">
            {scenarios.map((scenario) => (
              <div key={scenario.scenario} className={`scenario-cell scenario-${scenario.scenario}`}>
                <span className="scenario-name">{scenarioLabel(scenario.scenario)}</span>
                <strong className="scenario-value">{formatMoney(scenario.perShareValue, run.currency)}</strong>
                <small className="scenario-summary">{scenario.summary}</small>
              </div>
            ))}
          </div>
          {rangeInfo && rangeInfo.spread > 0 ? (
            <div className="valuation-range-bar" role="img" aria-label={`估值区间：保守 ${formatMoney(rangeInfo.min, run.currency)} 至 乐观 ${formatMoney(rangeInfo.max, run.currency)}，区间幅度 ${rangeInfo.spreadPct.toFixed(1)}%`}>
              <div className="valuation-range-label">
                <span>估值区间</span>
                <strong>{formatMoney(rangeInfo.min, run.currency)} — {formatMoney(rangeInfo.max, run.currency)}</strong>
                <em>区间幅度 {rangeInfo.spreadPct.toFixed(1)}%</em>
              </div>
              <div className="valuation-range-track">
                {scenarios.map((scenario) => {
                  const ratio = rangeInfo.spread > 0 ? ((scenario.perShareValue - rangeInfo.min) / rangeInfo.spread) * 100 : 50;
                  return (
                    <div key={scenario.scenario} className={`valuation-range-marker scenario-${scenario.scenario}`} style={{ left: `${Math.max(0, Math.min(100, ratio))}%` }} title={`${scenarioLabel(scenario.scenario)}：${formatMoney(scenario.perShareValue, run.currency)}`}>
                      <span className="marker-dot" />
                      <span className="marker-label">{scenarioLabel(scenario.scenario)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {assumptions.length ? (
            <div className="valuation-assumptions">
              <span>关键假设</span>
              <div>
                {assumptions.map((assumption) => (
                  <small key={assumption.key} title={assumption.meta}>
                    {assumption.label} <strong>{assumption.value}</strong>
                  </small>
                ))}
              </div>
            </div>
          ) : null}
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
        <div className="valuation-pending">
          <p>{run.status === "failed" ? "估值任务失败，可以直接重新创建任务。" : "估值任务正在后台运行。"}</p>
          {run.status === "failed" ? (
            <button type="button" className="secondary-action compact-action" onClick={() => onRetry?.(run)}>重新创建估值</button>
          ) : null}
        </div>
      )}
    </article>
  );
}

function ValuationCompareStrip({ compareIds, runs, onClear }: { compareIds: string[]; runs: ValuationRunSummary[]; onClear: () => void }) {
  const selected = runs.filter((r) => compareIds.includes(r.id));
  if (selected.length !== 2) return null;
  const [a, b] = selected;
  const aBase = a.result?.scenarios.find((s) => s.scenario === "base");
  const bBase = b.result?.scenarios.find((s) => s.scenario === "base");
  const baseDelta = aBase && bBase ? bBase.perShareValue - aBase.perShareValue : 0;
  const aBull = a.result?.scenarios.find((s) => s.scenario === "bull");
  const bBull = b.result?.scenarios.find((s) => s.scenario === "bull");
  return (
    <div className="valuation-compare-strip" role="region" aria-label="两个版本对比">
      <div className="valuation-compare-head">
        <span>版本对比 ({a.currency})</span>
        <button type="button" className="valuation-compare-clear" onClick={onClear}>清除对比</button>
      </div>
      <div className="valuation-compare-grid">
        <div className="valuation-compare-col">
          <strong>{a.title}</strong>
          <small>{new Date(a.createdAt).toLocaleString("zh-CN")}</small>
          <span className="valuation-compare-base">中性 {aBase ? formatMoney(aBase.perShareValue, a.currency) : "—"}</span>
          <span>乐观 {aBull ? formatMoney(aBull.perShareValue, a.currency) : "—"}</span>
        </div>
        <div className="valuation-compare-arrow" aria-hidden="true">→</div>
        <div className="valuation-compare-col">
          <strong>{b.title}</strong>
          <small>{new Date(b.createdAt).toLocaleString("zh-CN")}</small>
          <span className="valuation-compare-base">中性 {bBase ? formatMoney(bBase.perShareValue, b.currency) : "—"}</span>
          <span>乐观 {bBull ? formatMoney(bBull.perShareValue, b.currency) : "—"}</span>
        </div>
        <div className="valuation-compare-delta">
          <span>中性差异</span>
          <strong className={baseDelta >= 0 ? "up" : "down"}>
            {baseDelta >= 0 ? "+" : ""}{baseDelta.toFixed(2)} {a.currency}
          </strong>
        </div>
      </div>
    </div>
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

function inferCurrency(entityId?: string, subtitle?: string) {
  const id = entityId ?? subtitle ?? "";
  if (/^\d{1,5}$/.test(id) || /港股|HK|H股|港交所/i.test(id)) return "HKD";
  if (/^[A-Z]{1,5}\.?[A-Z]?$/.test(id) || /美股|NASDAQ|NYSE|USD/i.test(id)) return "USD";
  return "CNY";
}

function formatMoney(value: number, currency: string) {
  return `${currency} ${formatNumber(value)}`;
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "-";
}
