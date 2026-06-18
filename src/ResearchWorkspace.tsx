import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addResearchItem, createValuationRun, deleteResearchItems, fetchActivityEvents, fetchResearchCatalysts, fetchResearchItems, fetchResearchTheses, fetchValuations, refreshResearchThesis, reorderResearchItems, searchCompanies, syncResearchCatalystsFromThesis, updateResearchCatalystStatus, updateResearchItemStage, type ActivityEvent } from "./api";
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

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) => part.toLowerCase() === query.toLowerCase() ? <mark key={i} className="search-highlight">{part}</mark> : part);
}

export function ResearchWorkspace({ onOpenLegacyMine, onOpenAssistant, onOpenReport }: Props) {
  const [items, setItems] = useState<ResearchWorkbenchItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [queueQuery, setQueueQuery] = useState("");
  const [quickAddQuery, setQuickAddQuery] = useState("");
  const [quickAddSuggestions, setQuickAddSuggestions] = useState<Array<{ id: string; name: string; code: string; listingPlace: string; source: string }>>([]);
  const [quickAddLoading, setQuickAddLoading] = useState(false);
  const quickAddTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [valuationRuns, setValuationRuns] = useState<ValuationRunSummary[]>([]);
  const thesisRequestRef = useRef<{ itemId: string; controller: AbortController } | null>(null);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);
  const [itemOrder, setItemOrder] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(localStorage.getItem("cstd_research_item_order") || "{}"); } catch { return {}; }
  });
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      if (filteredItems.length === 0) return;
      const currentIdx = filteredItems.findIndex((i) => i.id === selectedId);
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        const next = currentIdx < filteredItems.length - 1 ? currentIdx + 1 : 0;
        setSelectedId(filteredItems[next].id);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        const prev = currentIdx > 0 ? currentIdx - 1 : filteredItems.length - 1;
        setSelectedId(filteredItems[prev].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filteredItems, selectedId]);

  useEffect(() => {
    if (!selected?.id) return;
    let cancelled = false;
    void fetchActivityEvents(selected.id).then((events) => { if (!cancelled) { setActivityEvents(events); setActivityLoading(false); } }).catch(() => { if (!cancelled) setActivityLoading(false); });
    return () => { cancelled = true; };
  }, [selected?.id]);

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

  useEffect(() => {
    if (quickAddTimerRef.current) clearTimeout(quickAddTimerRef.current);
    if (!quickAddQuery.trim() || quickAddQuery.trim().length < 2) return;
    quickAddTimerRef.current = setTimeout(() => {
      searchCompanies(quickAddQuery.trim()).then((results) => {
        setQuickAddSuggestions(results.slice(0, 6));
        setQuickAddLoading(false);
      }).catch(() => setQuickAddLoading(false));
    }, 300);
    return () => { if (quickAddTimerRef.current) clearTimeout(quickAddTimerRef.current); };
  }, [quickAddQuery]);

  async function quickAddCompany(company: { id: string; name: string; code: string; listingPlace: string; source: string }) {
    try {
      await addResearchItem({
        entityType: "company",
        entityId: company.id,
        title: company.name,
        subtitle: `${company.code} / ${company.listingPlace}`,
        source: company.source,
        stage: "screening",
      });
      const data = await fetchResearchItems();
      setItems(data.items);
      setSelectedId(company.id);
      setQuickAddQuery("");
      setQuickAddSuggestions([]);
      showToast(`${company.name} 已加入研究队列。`, "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "加入研究队列失败。", "error");
    }
  }

  async function changeStage(item: ResearchWorkbenchItem, stage: ResearchStage) {
    try {
      const updated = await updateResearchItemStage(item.id, stage);
      setItems((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      showToast(`${updated.title} 已移动到「${RESEARCH_STAGE_LABELS[stage]}」。`, "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "阶段更新失败。");
    }
  }

  function toggleSelectItem(id: string) {
    setSelectedItemIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedItemIds(new Set(filteredItems.map((i) => i.id)));
  }

  function clearSelection() {
    setSelectedItemIds(new Set());
  }

  const saveItemOrder = useCallback((order: Record<string, string[]>) => {
    setItemOrder(order);
    try { localStorage.setItem("cstd_research_item_order", JSON.stringify(order)); } catch { /* ignore */ }
  }, []);

  function handleDragStart(e: React.DragEvent, itemId: string) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", itemId);
    setDraggedItemId(itemId);
  }

  function handleDragOver(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (targetId !== draggedItemId) setDragOverItemId(targetId);
  }

  function handleDragLeave() {
    setDragOverItemId(null);
  }

  function handleDrop(e: React.DragEvent, targetStage: string, targetId: string) {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData("text/plain");
    setDraggedItemId(null);
    setDragOverItemId(null);
    if (!sourceId || sourceId === targetId) return;

    const sourceItem = items.find((i) => i.id === sourceId);
    const targetItem = items.find((i) => i.id === targetId);
    if (!sourceItem || !targetItem) return;

    const isCrossStage = sourceItem.stage !== targetStage;
    const stageId = targetStage;

    const sourceStageItems = isCrossStage
      ? filteredItems.filter((i) => i.stage === sourceItem.stage && i.id !== sourceId)
      : filteredItems.filter((i) => i.stage === sourceItem.stage);
    const targetStageItems = isCrossStage
      ? filteredItems.filter((i) => i.stage === targetStage)
      : sourceStageItems;

    const sourceOrder = itemOrder[sourceItem.stage] ?? sourceStageItems.map((i) => i.id);
    const targetOrder = isCrossStage ? (itemOrder[targetStage] ?? targetStageItems.map((i) => i.id)) : sourceOrder;

    const fromIndex = sourceOrder.indexOf(sourceId);
    const toIndex = targetOrder.indexOf(targetId);
    if (toIndex === -1) return;

    const newSourceOrder = isCrossStage ? sourceOrder.filter((id) => id !== sourceId) : [...sourceOrder];
    const newTargetOrder = isCrossStage ? [...targetOrder] : newSourceOrder;

    if (!isCrossStage) {
      newTargetOrder.splice(fromIndex, 1);
    }
    const insertIndex = newTargetOrder.indexOf(targetId);
    newTargetOrder.splice(isCrossStage ? insertIndex + 0 : insertIndex, 0, sourceId);

    const new_itemOrder = { ...itemOrder };
    if (isCrossStage) {
      new_itemOrder[sourceItem.stage] = newSourceOrder;
    }
    new_itemOrder[stageId] = newTargetOrder;
    saveItemOrder(new_itemOrder);

    const updates: Array<{ id: string; stage: string; sortOrder: number }> = [];
    if (isCrossStage) {
      updates.push({ id: sourceId, stage: targetStage, sortOrder: newTargetOrder.indexOf(sourceId) });
      newSourceOrder.forEach((id, index) => updates.push({ id, stage: sourceItem.stage, sortOrder: index }));
    }
    newTargetOrder.forEach((id, index) => {
      if (!updates.some((u) => u.id === id)) updates.push({ id, stage: targetStage, sortOrder: index });
    });

    if (isCrossStage) {
      setItems((current) => current.map((entry) => entry.id === sourceId ? { ...entry, stage: targetStage as ResearchStage } : entry));
    }

    void reorderResearchItems(updates).catch(() => {});
  }

  function handleDragEnd() {
    setDraggedItemId(null);
    setDragOverItemId(null);
  }

  function getStageItemOrder(stage: string, stageItems: ResearchWorkbenchItem[]): ResearchWorkbenchItem[] {
    const order = itemOrder[stage];
    if (!order?.length) return stageItems;
    const idToItem = new Map(stageItems.map((i) => [i.id, i]));
    const ordered = order.map((id) => idToItem.get(id)).filter((i): i is ResearchWorkbenchItem => Boolean(i));
    const remaining = stageItems.filter((i) => !order.includes(i.id));
    return [...ordered, ...remaining];
  }

  async function batchChangeStage(targetStage: ResearchStage) {
    const ids = Array.from(selectedItemIds);
    if (!ids.length) return;
    setBatchProcessing(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => updateResearchItemStage(id, targetStage)));
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;
      if (succeeded > 0) {
        setItems((current) => current.map((entry) => ids.includes(entry.id) ? { ...entry, stage: targetStage } : entry));
        showToast(`已将 ${succeeded} 项移动到「${RESEARCH_STAGE_LABELS[targetStage]}」${failed ? `，${failed} 项失败` : ""}。`, succeeded > 0 ? "success" : "error");
      }
      if (failed > 0) showToast(`${failed} 项阶段更新失败。`, "error");
      clearSelection();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量操作失败。");
    } finally {
      setBatchProcessing(false);
    }
  }

  async function batchDeleteItems() {
    const ids = Array.from(selectedItemIds);
    if (!ids.length) return;
    if (!window.confirm(`确定删除 ${ids.length} 个研究项？此操作不可撤销。`)) return;
    setBatchProcessing(true);
    try {
      await deleteResearchItems(ids);
      setItems((current) => current.filter((entry) => !ids.includes(entry.id)));
      showToast(`已删除 ${ids.length} 个研究项。`, "success");
      clearSelection();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量删除失败。");
    } finally {
      setBatchProcessing(false);
    }
  }

  async function batchGenerateThesis() {
    const ids = Array.from(selectedItemIds);
    if (!ids.length) return;
    setBatchProcessing(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => refreshResearchThesis(id)));
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;
      if (succeeded > 0) {
        const data = await fetchResearchItems();
        setItems(data.items);
        showToast(`已为 ${succeeded} 项生成论点${failed ? `，${failed} 项失败` : ""}。`, succeeded > 0 ? "success" : "error");
      }
      if (failed > 0) showToast(`${failed} 项论点生成失败。`, "error");
      clearSelection();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量生成论点失败。");
    } finally {
      setBatchProcessing(false);
    }
  }

  function exportFilteredCSV() {
    const rows = [["名称", "实体类型", "副标题", "阶段", "来源", "有论点", "有证据", "创建时间", "更新时间"]];
    for (const item of filteredItems) {
      rows.push([item.title, item.entityType, item.subtitle || "", RESEARCH_STAGE_LABELS[item.stage as keyof typeof RESEARCH_STAGE_LABELS] || item.stage, item.source, item.currentThesisVersionId ? "是" : "否", item.evidenceHash ? "是" : "否", item.createdAt, item.updatedAt]);
    }
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const bom = "\uFEFF";
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `研究队列_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${filteredItems.length} 项研究数据。`, "success");
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
                <p>AI 只提出建议，阶段变化必须由你确认。<span className="kbd-hint">Ctrl+←→ 切换</span></p>
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
            <div className="quick-add-section">
              <label className="research-queue-search">
                <span>快速添加</span>
                <input value={quickAddQuery} onChange={(event) => { setQuickAddQuery(event.target.value); if (event.target.value.trim().length < 2) { setQuickAddSuggestions([]); setQuickAddLoading(false); } else { setQuickAddLoading(true); } }} placeholder="搜索公司名称或代码添加到研究队列" />
              </label>
              {quickAddLoading ? <span className="muted" style={{ fontSize: 12 }}>搜索中...</span> : null}
              {quickAddSuggestions.length > 0 ? (
                <div className="quick-add-suggestions">
                  {quickAddSuggestions.map((company) => (
                    <button key={company.id} type="button" className="quick-add-item" onClick={() => void quickAddCompany(company)}>
                      <strong>{company.name}</strong>
                      <span>{company.code}</span>
                      <small>{company.listingPlace}</small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="stage-board">
              {RESEARCH_STAGES.map((stage) => {
                const stageTotal = items.filter((item) => item.stage === stage).length;
                const stageItems = filteredItems.filter((item) => item.stage === stage);
                const orderedItems = getStageItemOrder(stage, stageItems);
                return (
                  <section className="stage-column" key={stage}>
                    <h3>{RESEARCH_STAGE_LABELS[stage]} <span>{queueQuery ? `${stageItems.length}/${stageTotal}` : stageTotal}</span></h3>
                    {orderedItems.length ? orderedItems.map((item) => {
                      const valuation = valuationByItem.get(item.id);
                      const isSelected = selectedItemIds.has(item.id);
                      return (
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => handleDragStart(e, item.id)}
                          onDragOver={(e) => handleDragOver(e, item.id)}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, stage, item.id)}
                          onDragEnd={handleDragEnd}
                          className={`research-card ${selected?.id === item.id ? "selected" : ""} ${isSelected ? "multi-selected" : ""} ${item.source === "radar" ? "source-radar" : item.source === "watchlist" ? "source-watchlist" : ""} ${draggedItemId === item.id ? "dragging" : ""} ${dragOverItemId === item.id ? "drag-over" : ""}`}
                          key={item.id}
                          onClick={(e) => { if (e.shiftKey) { toggleSelectItem(item.id); } else { setSelectedId(item.id); } }}
                        >
                          <div className="card-header">
                            <input type="checkbox" checked={isSelected} onChange={() => toggleSelectItem(item.id)} onClick={(e) => e.stopPropagation()} aria-label={`选择 ${item.title}`} className="card-checkbox" />
                            <strong>{highlightMatch(item.title, queueQuery)}</strong>
                            <span className="card-source">{item.source === "radar" ? "雷达" : item.source === "watchlist" ? "自选" : item.source}</span>
                          </div>
                          <span className="card-subtitle">{highlightMatch(item.subtitle || item.entityType, queueQuery)}</span>
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
                            <button type="button" className="card-expand-toggle" onClick={(e) => { e.stopPropagation(); setExpandedCardId(expandedCardId === item.id ? null : item.id); }} aria-label={expandedCardId === item.id ? "收起详情" : "展开详情"}>
                              {expandedCardId === item.id ? "▲" : "▼"}
                            </button>
                          </div>
                          {expandedCardId === item.id ? (
                            <div className="card-detail-preview">
                              <div className="detail-row"><span>类型</span><span>{item.entityType}</span></div>
                              <div className="detail-row"><span>来源</span><span>{item.source}</span></div>
                              {item.currentThesisVersionId ? <div className="detail-row"><span>论点版本</span><span>{item.currentThesisVersionId.slice(0, 8)}...</span></div> : null}
                              {item.evidenceHash ? <div className="detail-row"><span>证据哈希</span><span>{item.evidenceHash.slice(0, 8)}...</span></div> : null}
                              <div className="detail-row"><span>更新时间</span><span>{new Date(item.updatedAt).toLocaleString("zh-CN", { hour12: false })}</span></div>
                            </div>
                          ) : null}
                        </button>
                      );
                    }) : <p className="stage-empty">{queueQuery && stageTotal ? "无匹配" : "暂无"}</p>}
                  </section>
                );
              })}
            </div>
            {selectedItemIds.size > 0 ? (
              <div className="batch-action-bar">
                <span>已选 {selectedItemIds.size} 项</span>
                <button type="button" className="ghost-button" onClick={selectAllVisible}>全选当前筛选</button>
                <button type="button" className="ghost-button" onClick={clearSelection}>取消选择</button>
                <select onChange={(e) => { if (e.target.value) { void batchChangeStage(e.target.value as ResearchStage); e.target.value = ""; } }} disabled={batchProcessing} defaultValue="">
                  <option value="" disabled>批量移动到...</option>
                  {RESEARCH_STAGES.map((stage) => <option key={stage} value={stage}>{RESEARCH_STAGE_LABELS[stage]}</option>)}
                </select>
                <button type="button" className="ghost-button" onClick={() => void batchGenerateThesis()} disabled={batchProcessing}>
                  {batchProcessing ? "生成中..." : "批量生成论点"}
                </button>
                <button type="button" className="ghost-button" onClick={() => exportFilteredCSV()}>导出 CSV</button>
                <button type="button" className="ghost-button danger-button" onClick={() => void batchDeleteItems()} disabled={batchProcessing}>
                  {batchProcessing ? "删除中..." : "批量删除"}
                </button>
              </div>
            ) : null}
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
              <div className="activity-timeline">
                {activityLoading ? <p className="muted" style={{ fontSize: 12, padding: 8 }}>加载中...</p> : null}
                {activityEvents.length > 0 ? activityEvents.map((event) => (
                  <div key={event.id} className="timeline-item">
                    <span className={`timeline-dot ${event.eventType === "thesis_generated" ? "thesis" : event.eventType === "stage_change" ? "confirmed" : event.eventType === "evidence_collected" ? "evidence" : event.eventType === "valuation_updated" ? "valuation" : "created"}`} />
                    <div className="timeline-content">
                      <strong>{event.title}</strong>
                      {event.description ? <p>{event.description}</p> : null}
                      <time>{new Date(event.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
                    </div>
                  </div>
                )) : !activityLoading ? (
                  <>
                    {selected.currentThesisVersionId ? (
                      <div className="timeline-item">
                        <span className="timeline-dot thesis" />
                        <div className="timeline-content">
                          <strong>论点已生成</strong>
                          <p>研究论点已完成分析</p>
                          <time>{new Date(selected.updatedAt).toLocaleString("zh-CN", { hour12: false })}</time>
                        </div>
                      </div>
                    ) : null}
                    {selected.evidenceHash ? (
                      <div className="timeline-item">
                        <span className="timeline-dot evidence" />
                        <div className="timeline-content">
                          <strong>证据包已采集</strong>
                          <p>证据哈希: {selected.evidenceHash.slice(0, 12)}...</p>
                          <time>{new Date(selected.updatedAt).toLocaleString("zh-CN", { hour12: false })}</time>
                        </div>
                      </div>
                    ) : null}
                    <div className="timeline-item">
                      <span className="timeline-dot created" />
                      <div className="timeline-content">
                        <strong>研究项创建</strong>
                        <p>来源: {selected.source === "radar" ? "雷达扫描" : selected.source === "watchlist" ? "自选股" : selected.source}</p>
                        <time>{new Date(selected.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
                      </div>
                    </div>
                  </>
                ) : null}
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
