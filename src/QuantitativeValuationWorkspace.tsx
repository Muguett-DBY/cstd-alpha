import { useEffect, useMemo, useState } from "react";
import { fetchQuantitativeValuationWorkspace, saveQuantitativeValuationWorkspace } from "./api";
import { calculateQuantitativeDraft, type QuantitativeDraft, type QuantitativeValuationWorkspace } from "./shared/quantitative-valuation";
import type { ValuationRunSummary } from "./shared/valuation";
import { applyDraftEdit, draftWarnings, findAssumption, simpleEditorFields, userLockedAssumptions } from "./quantitative-valuation-state";
import { showToast } from "./toast-state";
import { ValuationScenarioChart } from "./ValuationScenarioChart";

type Props = {
  run: ValuationRunSummary;
  onSaved?: (workspace: QuantitativeValuationWorkspace) => void;
};

const SCENARIOS = [
  { key: "bear" as const, label: "保守" },
  { key: "base" as const, label: "基准" },
  { key: "bull" as const, label: "乐观" },
];

const ADVANCED_FIELDS = [
  { key: "revenueGrowth", label: "收入增速" },
  { key: "ebitMargin", label: "EBIT 利润率" },
  { key: "capexRate", label: "资本开支率" },
  { key: "workingCapitalRate", label: "营运资本率" },
];

export function QuantitativeValuationWorkspace({ run, onSaved }: Props) {
  const [workspace, setWorkspace] = useState<QuantitativeValuationWorkspace | null>(null);
  const [draft, setDraft] = useState<QuantitativeDraft | null>(null);
  const [scenario, setScenario] = useState<"bear" | "base" | "bull">("base");
  const [advanced, setAdvanced] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<QuantitativeDraft[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  useEffect(() => {
    let cancelled = false;
    fetchQuantitativeValuationWorkspace(run.id)
      .then((next) => {
        if (cancelled) return;
        setWorkspace(next);
        setDraft(next.versions[0]?.draft ?? null);
        setPhase("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : "估值工作区读取失败。");
        setPhase("error");
      });
    return () => { cancelled = true; };
  }, [run.id]);

  const warnings = useMemo(() => draft ? draftWarnings(draft) : [], [draft]);
  const preview = useMemo(() => {
    if (!draft || warnings.some((warning) => warning.level === "error")) return null;
    try { return calculateQuantitativeDraft(draft); } catch { return null; }
  }, [draft, warnings]);
  const latest = workspace?.versions[0];

  function pushHistory(newDraft: QuantitativeDraft) {
    setHistory((prev) => {
      const trimmed = prev.slice(0, historyIndex + 1);
      return [...trimmed, newDraft].slice(-50);
    });
    setHistoryIndex((prev) => Math.min(prev + 1, 49));
  }

  function undo() {
    if (historyIndex <= 0 || !history[historyIndex - 1]) return;
    setHistoryIndex((prev) => prev - 1);
    setDraft(history[historyIndex - 1]);
  }

  function redo() {
    if (historyIndex >= history.length - 1 || !history[historyIndex + 1]) return;
    setHistoryIndex((prev) => prev + 1);
    setDraft(history[historyIndex + 1]);
  }

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  async function save() {
    if (!draft || !latest || warnings.some((warning) => warning.level === "error")) return;
    setPhase("saving");
    setMessage("");
    try {
      const saved = await saveQuantitativeValuationWorkspace({
        runId: run.id,
        parentVersionId: latest.id,
        assumptions: userLockedAssumptions(draft),
      });
      setWorkspace(saved.workspace);
      setDraft(saved.workspace.versions[0]?.draft ?? draft);
      setPhase("ready");
      onSaved?.(saved.workspace);
      showToast("估值版本已保存。", "success");
    } catch (error) {
      const text = error instanceof Error ? error.message : "估值保存失败。";
      setMessage(text);
      setPhase("error");
      if (text.includes("版本已更新")) {
        void fetchQuantitativeValuationWorkspace(run.id).then((next) => {
          setWorkspace(next);
          setDraft(next.versions[0]?.draft ?? null);
          setPhase("ready");
        });
      }
    }
  }

  if (phase === "loading") return <div className="workbench-empty">正在准备量化估值草稿…</div>;
  if (!workspace || !draft) return <div className="workbench-empty error">{message || "估值草稿尚未准备完成。"}</div>;

  const currentPrice = workspace.snapshot ? quoteValue(workspace.snapshot.payload, "regularMarketPrice") : undefined;
  return (
    <section className="quant-valuation-workspace" aria-label={run.title + " 量化估值"}>
      <header className="quant-snapshot">
        <div>
          <p className="eyebrow">量化估值工作区</p>
          <h2>{run.title}</h2>
          <p>{draft.asOf} · {methodLabel(draft.method)} · 数据快照 {workspace.snapshot?.contentHash.slice(0, 10) || "—"}</p>
        </div>
        <div className="quant-snapshot-metrics">
          <span>当前价格<strong>{currentPrice !== undefined ? formatMoney(currentPrice, run.currency) : "待验证"}</strong></span>
          <span>最新版本<strong>V{latest?.version ?? 1}</strong></span>
          <div className="quant-undo-redo">
            <button type="button" className="quant-undo-btn" onClick={undo} disabled={!canUndo} aria-label="撤销 Ctrl+Z" title="撤销 Ctrl+Z">↩</button>
            <button type="button" className="quant-redo-btn" onClick={redo} disabled={!canRedo} aria-label="重做 Ctrl+Y" title="重做 Ctrl+Y">↪</button>
          </div>
          <button type="button" className="quant-export-btn" onClick={() => {
            if (!preview) return;
            const text = [
              `${run.title} 量化估值摘要`,
              `日期: ${draft.asOf}`,
              `方法: ${methodLabel(draft.method)}`,
              `当前价格: ${currentPrice !== undefined ? formatMoney(currentPrice, run.currency) : "待验证"}`,
              "",
              "三情景估值:",
              ...preview.scenarios.map((s) => `  ${scenarioLabel(s.scenario)}: ${formatMoney(s.perShareValue, preview.currency)}${currentPrice ? ` (${formatUpside(s.perShareValue, currentPrice)})` : ""}`),
              "",
              preview.sensitivity?.length ? `敏感性分析: ${preview.sensitivity.length} 个参数组合` : "",
              `版本: V${latest?.version ?? 1}`,
            ].filter(Boolean).join("\n");
            navigator.clipboard.writeText(text).then(() => showToast("估值摘要已复制到剪贴板。", "success")).catch(() => showToast("复制失败。", "error"));
          }} aria-label="复制估值摘要">
            📋 复制摘要
          </button>
          <button type="button" className="quant-export-btn" onClick={() => window.print()} aria-label="打印估值报告">
            🖨️ 打印
          </button>
          <button type="button" className="primary-action" onClick={() => void save()} disabled={phase === "saving" || warnings.some((warning) => warning.level === "error")}>
            {phase === "saving" ? "保存中…" : "保存新版本"}
          </button>
        </div>
      </header>

      {message ? <div className="workbench-notice">{message}</div> : null}
      {warnings.length ? (
        <div className="quant-warning-list">
          {warnings.map((warning, index) => <div key={warning.message + index} className={"quant-warning " + warning.level}>{warning.message}</div>)}
        </div>
      ) : null}

      <div className="quant-scenario-tabs" role="tablist" aria-label="估值情景">
        {SCENARIOS.map((item) => (
          <button key={item.key} type="button" role="tab" aria-selected={scenario === item.key} className={scenario === item.key ? "active" : ""} onClick={() => setScenario(item.key)}>
            {item.label}
          </button>
        ))}
        <button type="button" className={advanced ? "active advanced-toggle" : "advanced-toggle"} onClick={() => setAdvanced((value) => !value)}>
          {advanced ? "收起高级模式" : "高级逐年预测"}
        </button>
      </div>

      <div className="quant-editor-grid">
        <section className="quant-editor-panel">
          <h3>关键预测驱动</h3>
          <p>系统已根据历史财务预填；修改后会立即重算。</p>
          <div className="quant-input-grid">
            {simpleEditorFields(draft).map((assumption) => {
              const value = scenarioValue(assumption, scenario);
              const numericValue = Number(value);
              const hasWarning = warnings.some((w) => w.message.includes(assumption.label));
              const isValid = numericValue >= 0 && numericValue <= 999;
              return (
                <label className={`quant-input ${hasWarning ? "has-warning" : ""} ${!isValid && value !== "" ? "has-error" : ""}`} key={assumption.key}>
                  <span>{assumption.label}<small>{assumption.origin === "user" ? "手动锁定" : "自动填入"}</small></span>
                  <div>
                    <input
                      type="number"
                      step="0.1"
                      value={value}
                      onChange={(event) => {
                        const newDraft = applyDraftEdit(draft, { key: assumption.key, scenario, rawValue: event.target.value });
                        pushHistory(newDraft);
                        setDraft(newDraft);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.currentTarget.blur();
                          return;
                        }
                        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                          event.preventDefault();
                          const delta = event.shiftKey ? 1.0 : 0.1;
                          const current = Number(event.currentTarget.value) || 0;
                          const next = event.key === "ArrowUp" ? current + delta : current - delta;
                          const clamped = Math.max(0, Math.min(next, 999));
                          const newDraft = applyDraftEdit(draft, { key: assumption.key, scenario, rawValue: String(Math.round(clamped * 100) / 100) });
                          pushHistory(newDraft);
                          setDraft(newDraft);
                        }
                      }}
                      aria-label={`${assumption.label}，${assumption.unit}，当前值 ${value}，上下箭头微调，Shift 加速`}
                    />
                    <em>{assumption.unit}</em>
                  </div>
                  <small title={assumption.explanation}>{assumption.explanation || "公式推导"}</small>
                  {hasWarning ? <span className="quant-field-warning">⚠️ {warnings.find((w) => w.message.includes(assumption.label))?.message}</span> : null}
                </label>
              );
            })}
          </div>
        </section>

        <section className="quant-results-panel">
          <h3>即时估值结果</h3>
          {preview ? (
            <>
              <ValuationScenarioChart
                scenarios={preview.scenarios.map((s) => ({
                  scenario: s.scenario,
                  label: scenarioLabel(s.scenario),
                  value: s.perShareValue,
                  currency: preview.currency,
                }))}
                currentPrice={currentPrice}
                currency={preview.currency}
              />
              <div className="quant-results-grid">
                {preview.scenarios.map((item) => (
                  <div key={item.scenario} className={"quant-result-card " + item.scenario}>
                    <span>{scenarioLabel(item.scenario)}</span>
                    <strong>{formatMoney(item.perShareValue, preview.currency)}</strong>
                    {currentPrice ? <small>{formatUpside(item.perShareValue, currentPrice)}</small> : null}
                  </div>
                ))}
              </div>
              {preview.sensitivity?.length ? <SensitivityTable rows={preview.sensitivity} currency={preview.currency} /> : null}
            </>
          ) : <div className="workbench-empty compact">修正错误参数后显示估值。</div>}
        </section>
      </div>

      {advanced ? <AdvancedForecast draft={draft} onChange={setDraft} onHistoryPush={pushHistory} /> : null}

      <section className="quant-version-section">
        <h3>版本与预测复盘</h3>
        <div className="quant-version-timeline">
          {workspace.versions.map((version) => (
            <div key={version.id}><strong>V{version.version}</strong><span>{version.createdBy === "user" ? "手动版本" : "自动基准"}</span><small>{new Date(version.createdAt).toLocaleString("zh-CN")}</small></div>
          ))}
        </div>
        {workspace.actualReviews.length ? (
          <div className="valuation-table-wrap">
            <table className="quant-review-table">
              <thead><tr><th>年度</th><th>指标</th><th>预测</th><th>实际</th><th>误差</th></tr></thead>
              <tbody>{workspace.actualReviews.map((review) => (
                <tr key={review.metricKey + review.forecastYear}>
                  <td>{review.forecastYear}</td><td>{metricLabel(review.metricKey)}</td>
                  <td>{formatNumber(review.forecastValue)}</td><td>{formatNumber(review.actualValue)}</td>
                  <td>{review.percentageError === undefined ? "—" : (review.percentageError * 100).toFixed(1) + "%"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="workbench-empty compact">新财报披露后，这里会自动对比预测与实际。</p>}
      </section>
    </section>
  );
}

function AdvancedForecast({ draft, onChange, onHistoryPush }: { draft: QuantitativeDraft; onChange: (draft: QuantitativeDraft) => void; onHistoryPush: (draft: QuantitativeDraft) => void }) {
  return (
    <section className="quant-advanced-panel">
      <h3>未来五年逐年覆写</h3>
      <div className="valuation-table-wrap">
        <table className="quant-forecast-table">
          <thead><tr><th>预测年</th>{ADVANCED_FIELDS.map((field) => <th key={field.key}>{field.label}</th>)}</tr></thead>
          <tbody>{[1, 2, 3, 4, 5].map((year) => (
            <tr key={year}><td>第 {year} 年</td>{ADVANCED_FIELDS.map((field) => {
              const value = findAssumption(draft, field.key, year)?.base ?? findAssumption(draft, field.key)?.base ?? "";
              return <td key={field.key}><input type="number" step="0.1" value={value} onChange={(event) => {
                const newDraft = applyDraftEdit(draft, { key: field.key, scenario: "base", forecastYear: year, rawValue: event.target.value });
                onHistoryPush(newDraft);
                onChange(newDraft);
              }} onKeyDown={(event) => {
                if (event.key === "Escape") { event.currentTarget.blur(); return; }
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  event.preventDefault();
                  const delta = event.shiftKey ? 1.0 : 0.1;
                  const current = Number(event.currentTarget.value) || 0;
                  const next = event.key === "ArrowUp" ? current + delta : current - delta;
                  const clamped = Math.max(0, Math.min(next, 999));
                  const newDraft = applyDraftEdit(draft, { key: field.key, scenario: "base", forecastYear: year, rawValue: String(Math.round(clamped * 100) / 100) });
                  onHistoryPush(newDraft);
                  onChange(newDraft);
                }
              }} /></td>;
            })}</tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function SensitivityTable({ rows, currency }: { rows: Array<{ row: string; column: string; perShareValue: number }>; currency: string }) {
  const columns = Array.from(new Set(rows.map((item) => item.column)));
  const rowNames = Array.from(new Set(rows.map((item) => item.row)));
  return <div className="valuation-table-wrap"><table className="quant-sensitivity-table"><thead><tr><th>终值增长 / WACC</th>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rowNames.map((row) => <tr key={row}><th>{row}</th>{columns.map((column) => <td key={column}>{formatMoney(rows.find((item) => item.row === row && item.column === column)?.perShareValue ?? 0, currency)}</td>)}</tr>)}</tbody></table></div>;
}

function scenarioValue(assumption: { bear?: number; base?: number; bull?: number; value?: number }, scenario: "bear" | "base" | "bull") {
  return assumption[scenario] ?? assumption.value ?? "";
}

function quoteValue(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object") return undefined;
  const freshSignals = (payload as Record<string, unknown>).freshSignals;
  if (!freshSignals || typeof freshSignals !== "object") return undefined;
  const quote = (freshSignals as Record<string, unknown>).quote;
  if (!quote || typeof quote !== "object") return undefined;
  const value = (quote as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function methodLabel(method: string) {
  if (method === "ddm_residual_income") return "剩余收益";
  if (method === "mid_cycle_nav") return "中周期估值";
  return "五年 FCFF DCF";
}

function scenarioLabel(value: string) {
  return value === "bear" ? "保守" : value === "bull" ? "乐观" : "基准";
}

function metricLabel(value: string) {
  return value === "revenue" ? "营业收入" : value === "ebit" ? "EBIT" : "自由现金流";
}

function formatUpside(value: number, price: number) {
  const percentage = (value / price - 1) * 100;
  return (percentage >= 0 ? "上行 " : "下行 ") + Math.abs(percentage).toFixed(1) + "%";
}

function formatMoney(value: number, currency: string) {
  return currency + " " + formatNumber(value);
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—";
}
