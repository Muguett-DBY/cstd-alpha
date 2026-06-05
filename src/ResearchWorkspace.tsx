import { useEffect, useMemo, useState } from "react";
import { fetchResearchItems, updateResearchItemStage } from "./api";
import { groupResearchTemplates, RESEARCH_STAGE_LABELS, RESEARCH_STAGES, type ResearchStage, type ResearchWorkbenchItem } from "./shared/research-workbench";
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
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const templateGroups = useMemo(() => groupResearchTemplates(RESEARCH_TEMPLATES), []);

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

  async function changeStage(item: ResearchWorkbenchItem, stage: ResearchStage) {
    try {
      const updated = await updateResearchItemStage(item.id, stage);
      setItems((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setMessage(`${updated.title} 已移动到「${RESEARCH_STAGE_LABELS[stage]}」。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "阶段更新失败。");
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
                <div className="thesis-placeholder">
                  <h3>当前论点</h3>
                  <p>尚未形成版本化论点。后续点击刷新论点时才会调用 AI。</p>
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
