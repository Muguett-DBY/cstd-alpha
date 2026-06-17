import { useEffect, useMemo, useRef, useState } from "react";
import { createValuationRun, fetchResearchCatalysts, fetchResearchItems, fetchResearchTheses, fetchValuations, refreshResearchThesis, syncResearchCatalystsFromThesis, updateResearchCatalystStatus, updateResearchItemStage } from "./api";
import { parseAssistantMarkdown } from "./assistant-markdown";
import { filterResearchCatalystsByStatus, filterResearchWorkbenchItems, groupResearchTemplates, RESEARCH_CATALYST_STATUS_LABELS, RESEARCH_CATALYST_STATUSES, RESEARCH_STAGE_LABELS, RESEARCH_STAGES, summarizeResearchCatalystStatuses, type ResearchCatalyst, type ResearchCatalystStatus, type ResearchCatalystStatusFilter, type ResearchStage, type ResearchThesisVersion, type ResearchWorkbenchItem } from "./shared/research-workbench";
import { RESEARCH_TEMPLATES } from "./shared/user-research";
import type { ValuationRunSummary } from "./shared/valuation";
import { showToast } from "./toast-state";

type Props = {
  onOpenLegacyMine: () => void;
  onOpenAssistant: () => void;
  onOpenReport: () => void;
};

export function ResearchWorkspace({ onOpenLegacyMine, onOpenAssistant, onOpenReport }: Props) {
  const [items, setItems] = useState<ResearchWorkbenchItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [queueQuery, setQueueQuery] = useState("");
  const [assistantCollapsed, setAssistantCollapsed] = useState(false);
  const [thesisVersions, setThesisVersions] = useState<ResearchThesisVersion[]>([]);
  const [thesisItemId, setThesisItemId] = useState("");
  const [displayedThesisId, setDisplayedThesisId] = useState("");
  const [thesisPhase, setThesisPhase] = useState<"idle" | "loading" | "generating" | "error">("idle");
  const [catalysts, setCatalysts] = useState<ResearchCatalyst[]>([]);
  const [catalystItemId, setCatalystItemId] = useState("");
  const [catalystPhase, setCatalystPhase] = useState<"idle" | "loading" | "syncing" | "error">("idle");
  const [updatingCatalystId, setUpdatingCatalystId] = useState("");
  const [catalystStatusFilter, setCatalystStatusFilter] = useState<ResearchCatalystStatusFilter>("all");
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [thesisFilter, setThesisFilter] = useState<"all" | "with" | "without">("all");
  const [sortOrder, setSortOrder] = useState<"recent" | "name" | "stage">("recent");
  const [valuationRuns, setValuationRuns] = useState<ValuationRunSummary[]>([]);
  const thesisRequestRef = useRef<{ itemId: string; controller: AbortController } | null>(null);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const visibleThesisVersions = thesisItemId === selected?.id ? thesisVersions : [];
  const displayedThesis = visibleThesisVersions.find((thesis) => thesis.id === displayedThesisId) ?? visibleThesisVersions[0];
  const thesisLoading = Boolean(selected?.id && thesisItemId !== selected.id && thesisPhase !== "generating");
  const templateGroups = useMemo(() => groupResearchTemplates(RESEARCH_TEMPLATES), []);
  const filteredItems = useMemo(() => {
    let result = filterResearchWorkbenchItems(items, queueQuery);
    if (stageFilter !== "all") result = result.filter((i) => i.stage === stageFilter);
    if (thesisFilter === "with") result = result.filter((i) => i.currentThesisVersionId);
    if (thesisFilter === "without") result = result.filter((i) => !i.currentThesisVersionId);
    if (sortOrder === "recent") result = [...result].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    else if (sortOrder === "name") result = [...result].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    else if (sortOrder === "stage") {
      const stageOrder: Record<string, number> = { screening: 0, deepResearch: 1, awaitingCatalyst: 2, opinionFormed: 3, archived: 4 };
      result = [...result].sort((a, b) => (stageOrder[a.stage] ?? 99) - (stageOrder[b.stage] ?? 99));
    }
    return result;
  }, [items, queueQuery, stageFilter, thesisFilter, sortOrder]);
  const catalystStatusSummary = useMemo(() => summarizeResearchCatalystStatuses(catalysts), [catalysts]);
  const filteredCatalysts = useMemo(() => filterResearchCatalystsByStatus(catalysts, catalystStatusFilter), [catalysts, catalystStatusFilter]);
  const [recentCutoff] = useState(() => Date.now() - 7 * 24 * 60 * 60 * 1000);
  const valuationByItem = useMemo(() => {
    const map = new Map<string, ValuationRunSummary>();
    for (const run of valuationRuns) {
      if (run.researchItemId && (!map.has(run.researchItemId) || run.updatedAt > (map.get(run.researchItemId)?.updatedAt ?? ""))) {
        map.set(run.researchItemId, run);
      }
    }
    return map;
  }, [valuationRuns]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchResearchItems(), fetchValuations()])
      .then(([researchData, valuationData]) => {
        if (cancelled) return;
        setItems(researchData.items);
        setSelectedId((current) => current || researchData.items[0]?.id || "");
        setValuationRuns(valuationData.runs);
        setPhase("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : "研究队列读取失败。");
        setPhase("error");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected?.id) {
      thesisRequestRef.current?.controller.abort("research-item-cleared");
      thesisRequestRef.current = null;
      return;
    }
    if (thesisRequestRef.current && thesisRequestRef.current.itemId !== selected.id) {
      thesisRequestRef.current.controller.abort("research-item-changed");
      thesisRequestRef.current = null;
    }
    let cancelled = false;
    fetchResearchTheses(selected.id)
      .then((data) => {
        if (cancelled) return;
        setThesisVersions(data.versions);
        setThesisItemId(selected.id);
        setDisplayedThesisId(data.current?.id || data.versions[0]?.id || "");
        setThesisPhase("idle");
      })
      .catch((error) => {
        if (cancelled) return;
        setThesisItemId(selected.id);
        setMessage(error instanceof Error ? error.message : "研究论点读取失败。");
        setThesisPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  useEffect(() => {
    if (!selected?.id) {
      return;
    }
    let cancelled = false;
    fetchResearchCatalysts(selected.id)
      .then((data) => {
        if (cancelled) return;
        setCatalysts(data.catalysts);
        setCatalystItemId(selected.id);
        setCatalystPhase("idle");
      })
      .catch((error) => {
        if (cancelled) return;
        setCatalysts([]);
        setCatalystItemId(selected.id);
        setCatalystPhase("error");
        setMessage(error instanceof Error ? error.message : "研究跟踪项读取失败。");
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  async function changeStage(item: ResearchWorkbenchItem, stage: ResearchStage) {
    try {
      const updated = await updateResearchItemStage(item.id, stage);
      setItems((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      showToast(`${updated.title} 已移动到「${RESEARCH_STAGE_LABELS[stage]}」。`, "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "阶段更新失败。");
    }
  }

  async function generateThesis(item: ResearchWorkbenchItem) {
    thesisRequestRef.current?.controller.abort("research-thesis-restarted");
    const controller = new AbortController();
    thesisRequestRef.current = { itemId: item.id, controller };
    const timeout = window.setTimeout(() => controller.abort("research-thesis-timeout"), 245_000);
    setThesisPhase("generating");
    showToast("正在读取最新证据并生成版本化论点...", "info");
    try {
      const result = await refreshResearchThesis(item.id, controller.signal);
      if (controller.signal.aborted || thesisRequestRef.current?.itemId !== item.id) return;
      setItems((current) => current.map((entry) => (entry.id === result.item.id ? result.item : entry)));
      setThesisVersions((current) => [result.thesis, ...current.filter((entry) => entry.id !== result.thesis.id)]);
      setThesisItemId(item.id);
      setDisplayedThesisId(result.thesis.id);
      setThesisPhase("idle");
      showToast(`${item.title} 的投资论点已更新为 v${result.thesis.version}。`, "success");
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason !== "research-thesis-timeout") return;
      setThesisPhase("error");
      setMessage(controller.signal.reason === "research-thesis-timeout" ? "论点生成超时，已保留当前版本。" : error instanceof Error ? error.message : "研究论点生成失败，已保留当前版本。");
    } finally {
      window.clearTimeout(timeout);
      if (thesisRequestRef.current?.controller === controller) thesisRequestRef.current = null;
    }
  }

  async function syncCatalysts(item: ResearchWorkbenchItem) {
    setCatalystPhase("syncing");
    try {
      const result = await syncResearchCatalystsFromThesis(item.id);
      setCatalysts(result.catalysts);
      setCatalystItemId(item.id);
      setCatalystPhase("idle");
      const createdNote = result.created !== undefined ? `新增 ${result.created} 个` : `共 ${result.catalysts.length} 个`;
      showToast(`${item.title} 已同步 ${createdNote} 催化剂、反证和跟踪项。`, "success");
    } catch (error) {
      setCatalystPhase("error");
      setMessage(error instanceof Error ? error.message : "研究跟踪项同步失败。");
    }
  }

  async function changeCatalystStatus(item: ResearchWorkbenchItem, catalyst: ResearchCatalyst, status: ResearchCatalystStatus) {
    setUpdatingCatalystId(catalyst.id);
    try {
      const updated = await updateResearchCatalystStatus(item.id, catalyst.id, status);
      setCatalysts((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      showToast(`${catalyst.title} 已标记为「${RESEARCH_CATALYST_STATUS_LABELS[status]}」。`, "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "研究跟踪项状态更新失败。");
    } finally {
      setUpdatingCatalystId("");
    }
  }

  return (
    <section className="workbench-page research-page">
      <div className="workbench-hero compact">
        <div>
          <p className="eyebrow">研究工作区</p>
          <h1>从机会进入论点，再跟踪催化剂和反证</h1>
        </div>
        <div className="hero-actions">
          <button type="button" className="primary-action" onClick={onOpenLegacyMine}>打开模板研究</button>
          <button type="button" className="secondary-action" onClick={onOpenReport}>生成评分报告</button>
        </div>
      </div>
      {message ? <div className="workbench-notice">{message}</div> : null}
      {phase === "ready" && items.length > 0 ? (() => {
        const total = items.length;
        const withThesis = items.filter((i) => i.currentThesisVersionId).length;
        const active = items.filter((i) => i.stage !== "archived").length;
        const withValuation = valuationRuns.filter((r) => r.status === "completed").length;
        const recentlyUpdated = items.filter((i) => new Date(i.updatedAt).getTime() > recentCutoff).length;
        return (
          <div className="research-metrics-bar">
            <div className="research-metric"><strong>{total}</strong><span>研究项</span></div>
            <div className="research-metric"><strong>{active}</strong><span>进行中</span></div>
            <div className="research-metric"><strong>{withThesis}</strong><span>已生成论点</span></div>
            <div className="research-metric"><strong>{withValuation}</strong><span>已完成估值</span></div>
            <div className="research-metric"><strong>{recentlyUpdated}</strong><span>7天内更新</span></div>
          </div>
        );
      })() : null}
      {phase === "loading" ? <div className="workbench-empty">正在读取研究队列…</div> : null}
      {phase === "error" ? (
        <div className="workbench-empty error">
          <p>{message}</p>
          <button type="button" className="secondary-button" onClick={() => { setPhase("loading"); setMessage(""); void fetchResearchItems().then((data) => { setItems(data.items); setSelectedId((current) => current || data.items[0]?.id || ""); setPhase("ready"); }).catch((error) => { setMessage(error instanceof Error ? error.message : "研究队列读取失败。"); setPhase("error"); }); }}>重试</button>
        </div>
      ) : null}
      {phase === "ready" ? (
        <div className={`research-layout ${assistantCollapsed ? "assistant-collapsed" : ""}`}>
          <div className="terminal-panel research-queue">
            <header className="panel-header">
              <div>
                <h2>研究队列</h2>
                <p>AI 只提出建议，阶段变化必须由你确认。</p>
              </div>
              <label className="research-queue-search">
                <span>搜索</span>
                <input value={queueQuery} onChange={(event) => setQueueQuery(event.currentTarget.value)} placeholder="公司、代码、行业" />
              </label>
            </header>
            <div className="filter-bar">
              <div className="filter-group">
                <span className="filter-label">阶段</span>
                <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
                  <option value="all">全部阶段</option>
                  {RESEARCH_STAGES.map((stage) => <option key={stage} value={stage}>{RESEARCH_STAGE_LABELS[stage]}</option>)}
                </select>
              </div>
              <div className="filter-group">
                <span className="filter-label">论点</span>
                <select value={thesisFilter} onChange={(e) => setThesisFilter(e.target.value as typeof thesisFilter)}>
                  <option value="all">全部</option>
                  <option value="with">已有论点</option>
                  <option value="without">未生成</option>
                </select>
              </div>
              <div className="filter-group">
                <span className="filter-label">排序</span>
                <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}>
                  <option value="recent">最近更新</option>
                  <option value="name">按名称</option>
                  <option value="stage">按阶段</option>
                </select>
              </div>
            </div>
            <div className="stage-board">
              {RESEARCH_STAGES.map((stage) => {
                const stageTotal = items.filter((item) => item.stage === stage).length;
                const stageItems = filteredItems.filter((item) => item.stage === stage);
                return (
                  <section className="stage-column" key={stage}>
                    <h3>{RESEARCH_STAGE_LABELS[stage]} <span>{queueQuery ? `${stageItems.length}/${stageTotal}` : stageTotal}</span></h3>
                    {stageItems.length ? stageItems.map((item) => {
                      const valuation = valuationByItem.get(item.id);
                      return (
                        <button
                          type="button"
                          className={`research-card ${selected?.id === item.id ? "selected" : ""} ${item.source === "radar" ? "source-radar" : item.source === "watchlist" ? "source-watchlist" : ""}`}
                          key={item.id}
                          onClick={() => setSelectedId(item.id)}
                        >
                          <div className="card-header">
                            <strong>{item.title}</strong>
                            <span className="card-source">{item.source === "radar" ? "雷达" : item.source === "watchlist" ? "自选" : item.source}</span>
                          </div>
                          <span className="card-subtitle">{item.subtitle || item.entityType}</span>
                          <div className="card-meta">
                            <span className={`card-thesis ${item.currentThesisVersionId ? "has-thesis" : ""}`}>
                              {item.currentThesisVersionId ? "论点" : "无论点"}
                            </span>
                            <span className={`card-evidence ${item.evidenceHash ? "has-evidence" : ""}`}>
                              {item.evidenceHash ? "证据" : "无证据"}
                            </span>
                            {valuation ? (
                              <span className={`card-valuation ${valuation.status === "completed" ? "has-valuation" : valuation.status === "running" || valuation.status === "queued" ? "valuation-pending" : ""}`}>
                                {valuation.status === "completed" && valuation.result ? `${valuation.currency} ${formatValuationPrice(valuation.result.scenarios.find((s) => s.scenario === "base")?.perShareValue)}` : valuation.status === "running" || valuation.status === "queued" ? "估值中" : valuation.status === "failed" ? "估值失败" : "估值"}
                              </span>
                            ) : null}
                            <span className="card-time">{relativeTime(item.updatedAt)}</span>
                          </div>
                        </button>
                      );
                    }) : <p className="stage-empty">{queueQuery && stageTotal ? "无匹配" : "暂无"}</p>}
                  </section>
                );
              })}
            </div>
          </div>

          <aside className="terminal-panel research-detail">
            {selected ? (
              <>
                <p className="eyebrow">{selected.entityType === "company" ? "公司研究" : "行业研究"}</p>
                <h2>{selected.title}</h2>
                <p>{selected.subtitle || "等待补充研究论点。"}</p>
                <div className="stage-actions">
                  {RESEARCH_STAGES.map((stage) => (
                    <button key={stage} type="button" className={selected.stage === stage ? "active" : ""} onClick={() => changeStage(selected, stage)}>
                      {RESEARCH_STAGE_LABELS[stage]}
                    </button>
                  ))}
                </div>
                <div className="research-thesis">
                  <div className="research-thesis-header">
                    <div>
                      <p className="eyebrow">版本化研究资产</p>
                      <h3>当前论点{displayedThesis ? ` · v${displayedThesis.version}` : ""}</h3>
                    </div>
                    <button
                      type="button"
                      className="primary-action"
                      disabled={thesisLoading || thesisPhase === "generating"}
                      onClick={() => generateThesis(selected)}
                    >
                      {thesisPhase === "generating" ? "生成中…" : visibleThesisVersions.length ? "刷新论点" : "生成论点"}
                    </button>
                  </div>
                  {visibleThesisVersions.length > 1 ? (
                    <label className="thesis-version-select">
                      <span>历史版本</span>
                      <select value={displayedThesis?.id || ""} onChange={(event) => setDisplayedThesisId(event.target.value)}>
                        {visibleThesisVersions.map((thesis) => (
                          <option key={thesis.id} value={thesis.id}>v{thesis.version} · {formatResearchDate(thesis.createdAt)}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {thesisLoading ? <p className="thesis-status">正在读取当前论点…</p> : null}
                  {displayedThesis ? (
                    <>
                      <ResearchThesisContent markdown={displayedThesis.thesisMarkdown} />
                      <div className="thesis-meta">
                        <span>{formatResearchDate(displayedThesis.createdAt)}</span>
                        <span>核心引用 {displayedThesis.coreCitations.length} 条</span>
                        {displayedThesis.evidenceHash ? <span>证据指纹 {displayedThesis.evidenceHash.slice(0, 10)}</span> : null}
                      </div>
                    </>
                  ) : !thesisLoading ? (
                    <div className="thesis-empty">
                      <p>尚未形成版本化论点。</p>
                      <span>点击生成后，系统会读取公司证据包或行业雷达证据；只有用户主动点击时才调用模型。</span>
                    </div>
                  ) : null}
                </div>
                <div className="research-catalysts">
                  <div className="research-thesis-header">
                    <div>
                      <p className="eyebrow">催化剂与反证跟踪</p>
                      <h3>跟踪项{catalystItemId === selected.id ? ` · ${catalysts.length}` : ""}</h3>
                    </div>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={!displayedThesis || catalystPhase === "loading" || catalystPhase === "syncing"}
                      onClick={() => syncCatalysts(selected)}
                    >
                      {catalystPhase === "syncing" ? "同步中…" : "从论点同步"}
                    </button>
                  </div>
                  {catalystPhase === "loading" ? <p className="thesis-status">正在读取跟踪项…</p> : null}
                  {catalystItemId === selected.id && catalysts.length ? (
                    <>
                      <div className="catalyst-filter">
                        <button type="button" className={catalystStatusFilter === "all" ? "active" : ""} onClick={() => setCatalystStatusFilter("all")}>
                          全部 <span>{catalystStatusSummary.all}</span>
                        </button>
                        {RESEARCH_CATALYST_STATUSES.map((status) => (
                          <button key={status} type="button" className={catalystStatusFilter === status ? "active" : ""} onClick={() => setCatalystStatusFilter(status)}>
                            {RESEARCH_CATALYST_STATUS_LABELS[status]} <span>{catalystStatusSummary[status]}</span>
                          </button>
                        ))}
                      </div>
                      {filteredCatalysts.length ? (
                        <div className="catalyst-list">
                          {filteredCatalysts.slice(0, 8).map((entry) => (
                            <article key={entry.id}>
                              <strong>{entry.title}</strong>
                              {entry.description ? <p>{entry.description}</p> : null}
                              <div>
                                <span>{RESEARCH_CATALYST_STATUS_LABELS[entry.status]}</span>
                                {entry.evidenceRefs.length ? <span>{entry.evidenceRefs.join(" / ")}</span> : null}
                              </div>
                              <div className="catalyst-actions">
                                {entry.status !== "confirmed" ? (
                                  <button type="button" disabled={updatingCatalystId === entry.id} onClick={() => changeCatalystStatus(selected, entry, "confirmed")}>标记确认</button>
                                ) : null}
                                {entry.status !== "invalid" ? (
                                  <button type="button" disabled={updatingCatalystId === entry.id} onClick={() => changeCatalystStatus(selected, entry, "invalid")}>标记失效</button>
                                ) : null}
                                {entry.status !== "open" ? (
                                  <button type="button" disabled={updatingCatalystId === entry.id} onClick={() => changeCatalystStatus(selected, entry, "open")}>恢复跟踪</button>
                                ) : null}
                              </div>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <div className="thesis-empty compact">
                          <p>当前状态下暂无跟踪项。</p>
                          <span>切换到其他状态，或从论点同步新的催化剂和反证。</span>
                        </div>
                      )}
                    </>
                  ) : catalystPhase !== "loading" ? (
                    <div className="thesis-empty">
                      <p>暂无跟踪项。</p>
                      <span>生成论点后点击同步，将关键催化剂、反证和跟踪清单沉淀为可复核事项。</span>
                    </div>
                  ) : null}
                </div>
                {selected && (() => {
                  const valuation = valuationByItem.get(selected.id);
                  return (
                    <div className="thesis-panel">
                      <h3>估值状态</h3>
                      {valuation ? (
                        <div className="valuation-summary">
                          <div className="valuation-status">
                            <span className={`valuation-badge ${valuation.status}`}>{valuation.status === "completed" ? "已完成" : valuation.status === "running" ? "进行中" : valuation.status === "queued" ? "排队中" : valuation.status === "failed" ? "失败" : valuation.status}</span>
                            <span className="valuation-method">{valuation.method === "dcf_3_statement" ? "DCF三表" : valuation.method === "ddm_residual_income" ? "DDM/剩余收益" : "中周期NAV"}</span>
                          </div>
                          {valuation.status === "completed" && valuation.result ? (
                            <div className="valuation-results">
                              {valuation.result.scenarios.map((scenario) => (
                                <div key={scenario.scenario} className="valuation-scenario">
                                  <span>{scenario.scenario === "bear" ? "保守" : scenario.scenario === "bull" ? "乐观" : "中性"}</span>
                                  <strong>{valuation.currency} {formatValuationPrice(scenario.perShareValue)}</strong>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="thesis-empty">
                          <p>尚未创建估值任务。</p>
                          <button type="button" className="secondary-button" onClick={async () => {
                            try {
                              const run = await createValuationRun({
                                researchItemId: selected.id,
                                entityType: selected.entityType,
                                entityId: selected.entityId,
                                title: selected.title,
                              });
                              setValuationRuns((current) => [run, ...current]);
                              showToast(`${selected.title} 估值任务已创建。`, "success");
                            } catch (error) {
                              showToast(error instanceof Error ? error.message : "估值任务创建失败。", "error");
                            }
                          }}>创建估值任务</button>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            ) : (
              <div className="workbench-empty compact">从今日机会加入行业或公司后，会出现在这里。</div>
            )}
          </aside>

          <aside className="terminal-panel template-groups">
            <header className="panel-header">
              <h2>模板分组</h2>
              <p>按公司质量、财务、竞争优势、估值、风险和回报模式组织。</p>
            </header>
            {templateGroups.map((group) => (
              <details key={group.id} open={group.id === "quality" || group.id === "valuation"}>
                <summary>{group.label}<span>{group.templates.length}</span></summary>
                <div className="template-chip-list">
                  {group.templates.map((template) => <span key={template.id}>{template.shortTitle}</span>)}
                </div>
              </details>
            ))}
          </aside>

          <aside className="terminal-panel activity-feed">
            <header className="panel-header">
              <h2>最近动态</h2>
              <p>{selected ? `${selected.title} 的最新进展` : "选中研究项后显示动态"}</p>
            </header>
            {selected ? (
              <div className="activity-list">
                {selected.currentThesisVersionId ? (
                  <div className="activity-item">
                    <span className="activity-dot thesis" />
                    <div>
                      <strong>论文已生成</strong>
                      <p>{relativeTime(selected.updatedAt)}</p>
                    </div>
                  </div>
                ) : null}
                {catalystItemId === selected.id && catalysts.filter((c) => c.status === "confirmed").length > 0 ? (
                  <div className="activity-item">
                    <span className="activity-dot confirmed" />
                    <div>
                      <strong>{catalysts.filter((c) => c.status === "confirmed").length} 项催化剂已确认</strong>
                      <p>{relativeTime(catalysts.filter((c) => c.status === "confirmed").sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]?.updatedAt || selected.updatedAt)}</p>
                    </div>
                  </div>
                ) : null}
                {valuationByItem.get(selected.id) ? (
                  <div className="activity-item">
                    <span className="activity-dot valuation" />
                    <div>
                      <strong>估值{valuationByItem.get(selected.id)?.status === "completed" ? "已完成" : "进行中"}</strong>
                      <p>{relativeTime(valuationByItem.get(selected.id)?.updatedAt || selected.updatedAt)}</p>
                    </div>
                  </div>
                ) : null}
                {selected.evidenceHash ? (
                  <div className="activity-item">
                    <span className="activity-dot evidence" />
                    <div>
                      <strong>证据包已采集</strong>
                      <p>{relativeTime(selected.updatedAt)}</p>
                    </div>
                  </div>
                ) : null}
                <div className="activity-item">
                  <span className="activity-dot info" />
                  <div>
                    <strong>研究项创建</strong>
                    <p>{relativeTime(selected.createdAt)}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="thesis-empty">
                <p>选中一个研究项后显示其最新进展。</p>
              </div>
            )}
          </aside>

          <aside className="terminal-panel linked-assistant">
            <button type="button" className="collapse-link" onClick={() => setAssistantCollapsed((current) => !current)}>
              {assistantCollapsed ? "展开关联助手" : "收起关联助手"}
            </button>
            {!assistantCollapsed ? (
              <div>
                <h2>关联助手</h2>
                <p>带着当前研究对象进入全局助手，继续追问证据、反证或估值假设。</p>
                <button type="button" className="primary-action" onClick={onOpenAssistant}>打开助手</button>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </section>
  );
}

function ResearchThesisContent({ markdown }: { markdown: string }) {
  const blocks = parseAssistantMarkdown(markdown);
  return (
    <div className="research-thesis-content">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Heading = block.level <= 2 ? "h4" : "h5";
          return <Heading key={`heading-${index}`}>{renderResearchInline(block.text)}</Heading>;
        }
        if (block.type === "list") {
          return (
            <ul key={`list-${index}`}>
              {block.items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{renderResearchInline(item)}</li>)}
            </ul>
          );
        }
        if (block.type === "table") {
          return (
            <div className="research-thesis-table" key={`table-${index}`}>
              <table>
                <thead><tr>{block.headers.map((cell, cellIndex) => <th key={`${cell}-${cellIndex}`}>{renderResearchInline(cell)}</th>)}</tr></thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`row-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}>{renderResearchInline(cell)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === "hr") return <hr key={`rule-${index}`} />;
        return <p key={`paragraph-${index}`}>{renderResearchInline(block.text)}</p>;
      })}
    </div>
  );
}

function renderResearchInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => (
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>
      : part
  ));
}

function relativeTime(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天前`;
  return `${Math.floor(diff / 604_800_000)}周前`;
}

function formatValuationPrice(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value >= 1000 ? `${Math.round(value)}` : value.toFixed(2);
}

function formatResearchDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
