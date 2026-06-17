import { useEffect, useMemo, useRef, useState } from "react";
import { fetchResearchCatalysts, fetchResearchItems, fetchResearchTheses, refreshResearchThesis, syncResearchCatalystsFromThesis, updateResearchCatalystStatus, updateResearchItemStage } from "./api";
import { parseAssistantMarkdown } from "./assistant-markdown";
import { filterResearchCatalystsByStatus, groupResearchTemplates, RESEARCH_CATALYST_STATUS_LABELS, RESEARCH_CATALYST_STATUSES, RESEARCH_STAGE_LABELS, RESEARCH_STAGES, summarizeResearchCatalystStatuses, type ResearchCatalyst, type ResearchCatalystStatus, type ResearchCatalystStatusFilter, type ResearchStage, type ResearchThesisVersion, type ResearchWorkbenchItem } from "./shared/research-workbench";
import { RESEARCH_TEMPLATES } from "./shared/user-research";

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
  const thesisRequestRef = useRef<{ itemId: string; controller: AbortController } | null>(null);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const visibleThesisVersions = thesisItemId === selected?.id ? thesisVersions : [];
  const displayedThesis = visibleThesisVersions.find((thesis) => thesis.id === displayedThesisId) ?? visibleThesisVersions[0];
  const thesisLoading = Boolean(selected?.id && thesisItemId !== selected.id && thesisPhase !== "generating");
  const templateGroups = useMemo(() => groupResearchTemplates(RESEARCH_TEMPLATES), []);
  const catalystStatusSummary = useMemo(() => summarizeResearchCatalystStatuses(catalysts), [catalysts]);
  const filteredCatalysts = useMemo(() => filterResearchCatalystsByStatus(catalysts, catalystStatusFilter), [catalysts, catalystStatusFilter]);

  useEffect(() => {
    let cancelled = false;
    fetchResearchItems()
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setSelectedId((current) => current || data.items[0]?.id || "");
        setPhase("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : "研究队列读取失败。");
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
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
      setMessage(`${updated.title} 已移动到「${RESEARCH_STAGE_LABELS[stage]}」。`);
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
    setMessage("正在读取最新证据并生成版本化论点，旧版本会继续保留。");
    try {
      const result = await refreshResearchThesis(item.id, controller.signal);
      if (controller.signal.aborted || thesisRequestRef.current?.itemId !== item.id) return;
      setItems((current) => current.map((entry) => (entry.id === result.item.id ? result.item : entry)));
      setThesisVersions((current) => [result.thesis, ...current.filter((entry) => entry.id !== result.thesis.id)]);
      setThesisItemId(item.id);
      setDisplayedThesisId(result.thesis.id);
      setThesisPhase("idle");
      setMessage(`${item.title} 的投资论点已更新为 v${result.thesis.version}。`);
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
      setMessage(`${item.title} 已同步 ${result.created ?? result.catalysts.length} 个催化剂、反证和跟踪项。`);
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
      setMessage(`${catalyst.title} 已标记为「${RESEARCH_CATALYST_STATUS_LABELS[status]}」。`);
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
      {phase === "loading" ? <div className="workbench-empty">正在读取研究队列…</div> : null}
      {phase === "error" ? <div className="workbench-empty error">{message}</div> : null}
      {phase === "ready" ? (
        <div className={`research-layout ${assistantCollapsed ? "assistant-collapsed" : ""}`}>
          <div className="terminal-panel research-queue">
            <header className="panel-header">
              <h2>研究队列</h2>
              <p>AI 只提出建议，阶段变化必须由你确认。</p>
            </header>
            <div className="stage-board">
              {RESEARCH_STAGES.map((stage) => {
                const stageItems = items.filter((item) => item.stage === stage);
                return (
                  <section className="stage-column" key={stage}>
                    <h3>{RESEARCH_STAGE_LABELS[stage]} <span>{stageItems.length}</span></h3>
                    {stageItems.length ? stageItems.map((item) => (
                      <button
                        type="button"
                        className={`research-card ${selected?.id === item.id ? "selected" : ""}`}
                        key={item.id}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <strong>{item.title}</strong>
                        <span>{item.subtitle || item.entityType}</span>
                      </button>
                    )) : <p className="stage-empty">暂无</p>}
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

function formatResearchDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
