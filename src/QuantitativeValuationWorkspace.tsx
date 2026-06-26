import { useEffect, useMemo, useState } from "react";
import { fetchQuantitativeValuationWorkspace, saveQuantitativeValuationWorkspace } from "./api";
import { calculateQuantitativeDraft, type QuantitativeDraft, type QuantitativeValuationWorkspace } from "./shared/quantitative-valuation";
import type { ValuationRunSummary, ValuationSensitivityPoint } from "./shared/valuation";
import {
  applyDraftEdit,
  applyQuantitativePreset,
  applySensitivityPoint,
  buildQuantitativeStarterPresets,
  buildDraftDecisionNote,
  compareQuantitativeDrafts,
  createQuantitativePreset,
  createDraftHistory,
  describeQuantitativeDecision,
  describeQuantitativePresetChangeSummary,
  describeQuantitativePresetImpact,
  describeQuantitativePresetLibrary,
  describeQuantitativeSaveGuidance,
  describeQuantitativeVersionPresetSummary,
  describeQuantitativeWorkflowSteps,
  describeYearlyOverrideSummary,
  deleteQuantitativePreset,
  draftWarnings,
  findAssumption,
  pushDraftHistory,
  renameQuantitativePreset,
  redoDraftHistory,
  simpleEditorFields,
  undoDraftHistory,
  userLockedAssumptions,
  type DraftHistory,
} from "./quantitative-valuation-state";
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
  const [history, setHistory] = useState<DraftHistory | null>(null);
  const [comparisonVersionId, setComparisonVersionId] = useState<string>();
  const [decisionNote, setDecisionNote] = useState("");
  const [presetName, setPresetName] = useState("");
  const [renamingPresetId, setRenamingPresetId] = useState<string>();
  const [renamingPresetName, setRenamingPresetName] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchQuantitativeValuationWorkspace(run.id)
      .then((next) => {
        if (cancelled) return;
        const nextDraft = next.versions[0]?.draft ?? null;
        setWorkspace(next);
        setDraft(nextDraft);
        setHistory(nextDraft ? createDraftHistory(nextDraft) : null);
        setComparisonVersionId(next.versions[1]?.id);
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
  const latestDraft = latest?.draft;
  const comparisonVersion = workspace?.versions.find((version) => version.id === comparisonVersionId);
  const autoDecisionNote = useMemo(() => draft ? buildDraftDecisionNote(draft, latestDraft) : "", [draft, latestDraft]);
  const saveGuidance = useMemo(() => describeQuantitativeSaveGuidance({
    phase,
    warnings,
    current: draft ?? undefined,
    baseline: latestDraft,
    decisionNote,
    autoDecisionNote,
  }), [autoDecisionNote, decisionNote, draft, latestDraft, phase, warnings]);
  const yearlyOverrideSummary = useMemo(() =>
    draft ? describeYearlyOverrideSummary(draft) : { count: 0, title: "无逐年覆写", detail: "高级逐年预测未覆盖基准假设。" },
  [draft]);
  const presetLibrary = useMemo(() =>
    draft ? describeQuantitativePresetLibrary(draft, draft.presets) : { total: 0, currentCount: 0, actionableCount: 0, title: "暂无预设" },
  [draft]);
  const presetChangeSummary = useMemo(() =>
    draft ? describeQuantitativePresetChangeSummary(draft, latestDraft) : { hasChanges: false, changedPresetCount: 0, title: "预设库已同步", detail: "当前预设库与最新版本一致。" },
  [draft, latestDraft]);
  const workflowSteps = useMemo(() => describeQuantitativeWorkflowSteps({
    saveGuidance,
    presetChangeSummary,
    hasDecisionNote: Boolean(decisionNote.trim()),
  }), [decisionNote, presetChangeSummary, saveGuidance]);
  const versionComparison = useMemo(() => {
    if (!draft || !comparisonVersion?.draft || warnings.some((warning) => warning.level === "error")) return null;
    try { return compareQuantitativeDrafts(draft, comparisonVersion.draft); } catch { return null; }
  }, [comparisonVersion, draft, warnings]);

  function pushHistory(newDraft: QuantitativeDraft) {
    setHistory((current) => pushDraftHistory(current ?? createDraftHistory(draft ?? newDraft), newDraft));
  }

  function undo() {
    if (!history || history.index <= 0) return;
    const next = undoDraftHistory(history);
    setHistory(next);
    setDraft(next.current);
  }

  function redo() {
    if (!history || history.index >= history.entries.length - 1) return;
    const next = redoDraftHistory(history);
    setHistory(next);
    setDraft(next.current);
  }

  function startRenamePreset(presetId: string, name: string) {
    setRenamingPresetId(presetId);
    setRenamingPresetName(name);
  }

  function cancelRenamePreset() {
    setRenamingPresetId(undefined);
    setRenamingPresetName("");
  }

  function commitRenamePreset(presetId: string) {
    if (!draft) return;
    const newDraft = renameQuantitativePreset(draft, presetId, renamingPresetName);
    if (newDraft !== draft) {
      pushHistory(newDraft);
      setDraft(newDraft);
      showToast("估值情景预设已重命名。", "success");
    }
    cancelRenamePreset();
  }

  function deletePreset(presetId: string, name: string) {
    if (!draft) return;
    if (!window.confirm(`删除「${name}」预设？删除后需保存新版本才会同步到历史草稿。`)) return;
    const newDraft = deleteQuantitativePreset(draft, presetId);
    if (newDraft === draft) return;
    pushHistory(newDraft);
    setDraft(newDraft);
    if (renamingPresetId === presetId) cancelRenamePreset();
    showToast("估值情景预设已删除。", "success");
  }

  const canUndo = Boolean(history && history.index > 0);
  const canRedo = Boolean(history && history.index < history.entries.length - 1);

  async function save() {
    if (!draft || !latest || warnings.some((warning) => warning.level === "error")) return;
    setPhase("saving");
    setMessage("");
    try {
      const saved = await saveQuantitativeValuationWorkspace({
        runId: run.id,
        parentVersionId: latest.id,
        assumptions: userLockedAssumptions(draft),
        decisionNote: decisionNote.trim() || autoDecisionNote,
        presets: draft.presets ?? [],
      });
      setWorkspace(saved.workspace);
      const savedDraft = saved.workspace.versions[0]?.draft ?? draft;
      setDraft(savedDraft);
      setHistory(createDraftHistory(savedDraft));
      setDecisionNote("");
      setComparisonVersionId(saved.workspace.versions[1]?.id);
      setPhase("ready");
      onSaved?.(saved.workspace);
      showToast("估值版本已保存。", "success");
    } catch (error) {
      const text = error instanceof Error ? error.message : "估值保存失败。";
      setMessage(text);
      setPhase("error");
      if (text.includes("版本已更新")) {
        void fetchQuantitativeValuationWorkspace(run.id).then((next) => {
          const nextDraft = next.versions[0]?.draft ?? null;
          setWorkspace(next);
          setDraft(nextDraft);
          setHistory(nextDraft ? createDraftHistory(nextDraft) : null);
          setComparisonVersionId(next.versions[1]?.id);
          setPhase("ready");
        });
      }
    }
  }

  if (phase === "loading") return <div className="workbench-empty">正在准备量化估值草稿…</div>;
  if (!workspace || !draft) return <div className="workbench-empty error">{message || "估值草稿尚未准备完成。"}</div>;

  const currentPrice = workspace.snapshot ? quoteValue(workspace.snapshot.payload, "regularMarketPrice") : undefined;
  const decision = preview ? describeQuantitativeDecision({
    currentPrice,
    scenarios: preview.scenarios,
  }) : null;
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
        </div>
      </header>

      <section className="quant-action-center" aria-label="估值行动中心">
        <div className="quant-action-head">
          <div>
            <p className="eyebrow">估值行动中心</p>
            <h3>说明、预设与保存</h3>
          </div>
          <div className="quant-workflow-steps" aria-label="估值保存流程">
            {workflowSteps.map((step) => (
              <span key={step.key} className={step.status} title={step.detail}>
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </span>
            ))}
          </div>
        </div>

        <section className="quant-decision-note" aria-label="版本决策备注">
          <div>
            <strong>本次版本说明</strong>
            <span>保存时会写入版本历史，方便复盘每次假设调整的原因。</span>
          </div>
          <label>
            <textarea
              value={decisionNote}
              maxLength={240}
              rows={2}
              placeholder={autoDecisionNote || "例如：上调收入增速，等待半年报订单兑现。"}
              onChange={(event) => setDecisionNote(event.target.value)}
            />
            <small>{decisionNote.trim() ? `${decisionNote.trim().length}/240` : autoDecisionNote ? `将自动记录：${autoDecisionNote}` : "可选，留空也会记录本次关键假设变化。"}</small>
          </label>
        </section>

        <section className={`quant-save-strip ${saveGuidance.tone}`} aria-live="polite" aria-label="保存版本状态">
          <div className="quant-save-status">
            <span>{saveGuidance.tone === "saving" ? "写入中" : saveGuidance.canSave ? "可保存" : "需处理"}</span>
            <strong>{saveGuidance.title}</strong>
            <p>{saveGuidance.detail}</p>
          </div>
          <div className="quant-save-audit">
            <span>{saveGuidance.changedAssumptionCount ? `${saveGuidance.changedAssumptionCount} 项变更` : "无数值变更"}</span>
            <p>{saveGuidance.notePreview}</p>
          </div>
          <div className="quant-save-audit yearly">
            <span>{yearlyOverrideSummary.title}</span>
            <p>{yearlyOverrideSummary.detail}</p>
          </div>
          <button type="button" className="primary-action" onClick={() => void save()} disabled={!saveGuidance.canSave}>
            {phase === "saving" ? "保存中…" : "保存新版本"}
          </button>
        </section>

        <section className="quant-preset-panel" aria-label="估值情景预设">
        <div className="quant-preset-create">
          <div>
            <strong>情景预设库</strong>
            <span>把当前手动锁定的关键假设保存为可复用方案，下次可一键载入。</span>
          </div>
          <div className="quant-preset-summary" aria-live="polite">
            <span>{presetLibrary.title}</span>
            <small>{presetLibrary.total} 个方案 · {presetLibrary.actionableCount} 个可载入 · {presetLibrary.currentCount} 个当前匹配</small>
            <em className={presetChangeSummary.hasChanges ? "pending" : ""} title={presetChangeSummary.detail}>{presetChangeSummary.title}</em>
          </div>
          <label>
            <span className="sr-only">预设名称</span>
            <input
              value={presetName}
              maxLength={40}
              placeholder={`例如：${scenarioLabel(scenario)}压力测试`}
              onChange={(event) => setPresetName(event.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              const newDraft = createQuantitativePreset(draft, presetName);
              if (newDraft === draft) {
                showToast("先调整并锁定至少一项关键假设，再保存预设。", "error");
                return;
              }
              pushHistory(newDraft);
              setDraft(newDraft);
              setPresetName("");
              showToast("估值情景预设已保存到当前草稿。", "success");
            }}
            disabled={!userLockedAssumptions(draft).length}
          >
            保存当前预设
          </button>
        </div>
        <div className="quant-preset-templates">
          <div>
            <strong>内置模板</strong>
            <span>生成基准复核、谨慎下修和压力测试方案，再按影响摘要选择载入。</span>
          </div>
          <button
            type="button"
            onClick={() => {
              const existingNames = new Set((draft.presets ?? []).map((preset) => preset.name));
              const starters = buildQuantitativeStarterPresets(draft).filter((preset) => !existingNames.has(preset.name));
              if (!starters.length) {
                showToast("内置模板已在当前草稿中。", "success");
                return;
              }
              const newDraft = { ...draft, presets: [...(draft.presets ?? []), ...starters].slice(-12) };
              pushHistory(newDraft);
              setDraft(newDraft);
              showToast("已生成内置估值模板。", "success");
            }}
          >
            生成内置模板
          </button>
        </div>
        {draft.presets?.length ? (
          <div className="quant-preset-list">
            {draft.presets.map((preset) => {
              const impact = describeQuantitativePresetImpact(draft, preset);
              const isRenaming = renamingPresetId === preset.id;
              return (
                <article
                  key={preset.id}
                  className={`quant-preset-card ${impact.tone}`}
                >
                  <div className="quant-preset-card-main">
                    <strong>{preset.name}</strong>
                    <span>{preset.assumptions.length} 项假设 · {new Date(preset.createdAt).toLocaleDateString("zh-CN")}</span>
                    <em>{impact.title}</em>
                    <small>
                      {impact.baseDelta === undefined
                        ? impact.detail
                        : `基准 ${formatSignedMoney(impact.baseDelta, draft.currency)}${impact.baseDeltaPercent === undefined ? "" : ` · ${formatSignedPercent(impact.baseDeltaPercent)}`}`}
                    </small>
                  </div>
                  {isRenaming ? (
                    <form className="quant-preset-rename" onSubmit={(event) => {
                      event.preventDefault();
                      commitRenamePreset(preset.id);
                    }}>
                      <label>
                        <span className="sr-only">重命名 {preset.name}</span>
                        <input
                          value={renamingPresetName}
                          maxLength={40}
                          autoFocus
                          onChange={(event) => setRenamingPresetName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              cancelRenamePreset();
                            }
                          }}
                        />
                      </label>
                      <button type="submit">保存</button>
                      <button type="button" onClick={cancelRenamePreset}>取消</button>
                    </form>
                  ) : (
                    <div className="quant-preset-actions">
                      <button
                        type="button"
                        className="quant-preset-apply"
                        disabled={!impact.canApply}
                        onClick={() => {
                          const newDraft = applyQuantitativePreset(draft, preset);
                          pushHistory(newDraft);
                          setDraft(newDraft);
                          setScenario("base");
                          showToast(`已载入「${preset.name}」预设。`, "success");
                        }}
                      >
                        {impact.canApply ? "载入" : "当前"}
                      </button>
                      <button type="button" className="quant-preset-ghost" onClick={() => startRenamePreset(preset.id, preset.name)}>
                        重命名
                      </button>
                      <button type="button" className="quant-preset-danger" onClick={() => deletePreset(preset.id, preset.name)}>
                        删除
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <p className="workbench-empty compact">保存第一个预设后，可在基准、谨慎、压力测试等方案间快速切换。</p>
        )}
        </section>
      </section>

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
              {decision ? (
                <section className={`quant-decision-band ${decision.tone}`} aria-live="polite">
                  <div>
                    <span>市场价格结论</span>
                    <strong>{decision.title}</strong>
                    <p>{decision.detail}</p>
                  </div>
                  <dl>
                    <div><dt>当前价格</dt><dd>{currentPrice ? formatMoney(currentPrice, preview.currency) : "待验证"}</dd></div>
                    <div><dt>基准价值</dt><dd>{formatMoney(preview.scenarios.find((item) => item.scenario === "base")?.perShareValue ?? 0, preview.currency)}</dd></div>
                    <div><dt>估值区间</dt><dd>{formatMoney(Math.min(...preview.scenarios.map((item) => item.perShareValue)), preview.currency)} – {formatMoney(Math.max(...preview.scenarios.map((item) => item.perShareValue)), preview.currency)}</dd></div>
                  </dl>
                </section>
              ) : null}
              <div className="quant-results-visual">
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
              </div>
              {preview.sensitivity?.length ? (
                <SensitivityTable
                  rows={preview.sensitivity}
                  currency={preview.currency}
                  currentPrice={currentPrice}
                  currentDiscountRate={draft.operating?.discountRate.base}
                  currentTerminalGrowthRate={draft.operating?.terminalGrowthRate.base}
                  onApply={(point) => {
                    const newDraft = applySensitivityPoint(draft, point);
                    pushHistory(newDraft);
                    setDraft(newDraft);
                    setScenario("base");
                    showToast(`已将 WACC ${(point.discountRate * 100).toFixed(1)}% / g ${(point.terminalGrowthRate * 100).toFixed(1)}% 应用到基准情景。`, "success");
                  }}
                />
              ) : null}
            </>
          ) : <div className="workbench-empty compact">修正错误参数后显示估值。</div>}
        </section>
      </div>

      {advanced ? <AdvancedForecast draft={draft} onChange={setDraft} onHistoryPush={pushHistory} /> : null}

      <section className="quant-version-section">
        <div className="quant-version-heading">
          <div>
            <h3>版本对比与预测复盘</h3>
            <p>选择一个历史版本，与当前草稿逐项比较；旧版本始终保持不可变。</p>
          </div>
          {comparisonVersion?.draft ? (
            <button type="button" className="quant-version-load" onClick={() => {
              if (latest?.draft && JSON.stringify(draft) !== JSON.stringify(latest.draft) && !window.confirm("当前草稿存在未保存修改，载入历史版本会替换这些本地修改。继续吗？")) return;
              setDraft(comparisonVersion.draft ?? draft);
              setHistory(createDraftHistory(comparisonVersion.draft ?? draft));
              showToast(`已载入 V${comparisonVersion.version}，保存时会生成最新后继版本。`, "success");
            }}>
              载入 V{comparisonVersion.version} 为草稿
            </button>
          ) : null}
        </div>
        <div className="quant-version-timeline">
          {workspace.versions.map((version) => (
            <VersionTimelineButton
              key={version.id}
              active={comparisonVersionId === version.id}
              version={version}
              onSelect={() => setComparisonVersionId(version.id)}
            />
          ))}
        </div>
        {comparisonVersion && versionComparison ? (
          <div className="quant-version-comparison" aria-live="polite">
            <div className="quant-version-comparison-head">
              <strong>当前草稿 vs V{comparisonVersion.version}</strong>
              <span>{versionComparison.assumptions.length ? `${versionComparison.assumptions.length} 项关键假设有变化` : "关键假设未变化"} · {describeQuantitativeVersionPresetSummary(comparisonVersion.draft).title}</span>
            </div>
            <p className="quant-version-preset-note">V{comparisonVersion.version} 预设库：{describeQuantitativeVersionPresetSummary(comparisonVersion.draft).detail}</p>
            {comparisonVersion.decisionNote ? <p className="quant-version-note">V{comparisonVersion.version} 备注：{comparisonVersion.decisionNote}</p> : null}
            <div className="quant-version-scenario-grid">
              {versionComparison.scenarios.map((item) => (
                <article key={item.scenario} className={"quant-version-scenario " + item.scenario}>
                  <span>{scenarioLabel(item.scenario)}</span>
                  <strong>{formatMoney(item.currentValue, draft.currency)}</strong>
                  <small>V{comparisonVersion.version} {formatMoney(item.baselineValue, draft.currency)}</small>
                  <em className={item.delta >= 0 ? "up" : "down"}>
                    {formatSignedMoney(item.delta, draft.currency)}
                    {item.deltaPercent === undefined ? "" : ` · ${formatSignedPercent(item.deltaPercent)}`}
                  </em>
                </article>
              ))}
            </div>
            {versionComparison.assumptions.length ? (
              <div className="valuation-table-wrap">
                <table className="quant-version-diff-table">
                  <thead><tr><th>关键假设</th><th>V{comparisonVersion.version}</th><th>当前草稿</th><th>变化</th></tr></thead>
                  <tbody>{versionComparison.assumptions.map((item) => (
                    <tr key={item.key}>
                      <th>{item.label}</th>
                      <td>{formatAssumption(item.baselineValue, item.unit)}</td>
                      <td>{formatAssumption(item.currentValue, item.unit)}</td>
                      <td className={item.delta >= 0 ? "up" : "down"}>{formatSignedAssumption(item.delta, item.unit)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <p className="workbench-empty compact">当前草稿与所选版本的关键假设一致。</p>}
          </div>
        ) : (
          <p className="workbench-empty compact">{workspace.versions.length > 1 ? "选择历史版本后显示差异。" : "保存下一版后即可进行版本对比。"}</p>
        )}
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

function VersionTimelineButton({
  active,
  version,
  onSelect,
}: {
  active: boolean;
  version: QuantitativeValuationWorkspace["versions"][number];
  onSelect: () => void;
}) {
  const presetSummary = describeQuantitativeVersionPresetSummary(version.draft);
  return (
    <button
      type="button"
      className={active ? "active" : ""}
      aria-pressed={active}
      onClick={onSelect}
    >
      <strong>V{version.version}</strong>
      <span>{version.createdBy === "user" ? "手动版本" : "自动基准"}</span>
      <span className="quant-version-preset-pill">{presetSummary.title}</span>
      {version.decisionNote ? <em>{version.decisionNote}</em> : null}
      <small>{new Date(version.createdAt).toLocaleString("zh-CN")}</small>
    </button>
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

function SensitivityTable({
  rows,
  currency,
  currentPrice,
  currentDiscountRate,
  currentTerminalGrowthRate,
  onApply,
}: {
  rows: ValuationSensitivityPoint[];
  currency: string;
  currentPrice?: number;
  currentDiscountRate?: number;
  currentTerminalGrowthRate?: number;
  onApply: (point: ValuationSensitivityPoint) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string>();
  const pointKey = (point: ValuationSensitivityPoint) => `${point.discountRate}:${point.terminalGrowthRate}`;
  const currentPoint = rows.find((point) =>
    point.discountRate === currentDiscountRate && point.terminalGrowthRate === currentTerminalGrowthRate,
  );
  const selected = rows.find((point) => pointKey(point) === selectedKey) ?? currentPoint ?? rows[0];
  const isCurrentSelection = Boolean(
    selected
    && selected.discountRate === currentDiscountRate
    && selected.terminalGrowthRate === currentTerminalGrowthRate,
  );
  const columns = Array.from(new Set(rows.map((item) => item.column)));
  const rowNames = Array.from(new Set(rows.map((item) => item.row)));
  const pointMap = new Map(rows.map((point) => [`${point.row}:${point.column}`, point]));
  return (
    <section className="quant-sensitivity-explorer" aria-label="DCF 敏感性决策矩阵">
      <div className="quant-sensitivity-heading">
        <div>
          <strong>敏感性决策矩阵</strong>
          <p>选择一个 WACC / 永续增长组合，确认后写入基准情景。</p>
        </div>
        <button type="button" onClick={() => onApply(selected)} disabled={isCurrentSelection}>
          {isCurrentSelection ? "当前基准组合" : "应用到基准情景"}
        </button>
      </div>
      <div className="quant-sensitivity-selection" aria-live="polite">
        <span>{isCurrentSelection ? "当前基准" : "待应用"} · {selected.column} · {selected.row}</span>
        <strong>{formatMoney(selected.perShareValue, currency)}</strong>
        {currentPrice ? <small>{formatUpside(selected.perShareValue, currentPrice)}</small> : null}
      </div>
      <div className="valuation-table-wrap">
        <table className="quant-sensitivity-table">
          <thead><tr><th>终值增长 / WACC</th>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>{rowNames.map((row) => (
            <tr key={row}>
              <th>{row}</th>
              {columns.map((column) => {
                const point = pointMap.get(`${row}:${column}`);
                if (!point) return <td key={column}>—</td>;
                const isSelected = pointKey(selected) === pointKey(point);
                const isCurrent = point === currentPoint;
                const gap = currentPrice ? point.perShareValue / currentPrice - 1 : undefined;
                return (
                  <td key={column}>
                    <button
                      type="button"
                      className={[
                        isSelected ? "selected" : "",
                        isCurrent ? "current" : "",
                        gap === undefined ? "" : gap >= 0 ? "positive" : "negative",
                      ].filter(Boolean).join(" ")}
                      aria-pressed={isSelected}
                      aria-label={`${column}，${row}，估值 ${formatMoney(point.perShareValue, currency)}${currentPrice ? `，${formatUpside(point.perShareValue, currentPrice)}` : ""}${isCurrent ? "，当前基准" : ""}`}
                      onClick={() => setSelectedKey(pointKey(point))}
                    >
                      <strong>{formatMoney(point.perShareValue, currency)}</strong>
                      {currentPrice ? <small>{formatUpside(point.perShareValue, currentPrice)}</small> : null}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
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

function formatSignedMoney(value: number, currency: string) {
  return `${value >= 0 ? "+" : "−"}${currency} ${formatNumber(Math.abs(value))}`;
}

function formatSignedPercent(value: number) {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(1)}%`;
}

function formatAssumption(value: number, unit?: string) {
  return `${formatNumber(value)}${unit ?? ""}`;
}

function formatSignedAssumption(value: number, unit?: string) {
  return `${value >= 0 ? "+" : "−"}${formatNumber(Math.abs(value))}${unit ?? ""}`;
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—";
}
