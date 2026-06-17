import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  addWatchlistItem,
  completeResearchTemplateDraft,
  fetchCompanyNews,
  fetchResearchTemplates,
  fetchTemplateAnalyses,
  fetchTemplateAnalysis,
  fetchWatchlist,
  generateTemplateAnalysis,
  removeWatchlistItem,
  resetResearchTemplatesToDefault,
  saveResearchTemplates,
  saveResearchTemplatesAsDefault,
  searchCompanies,
} from "./api";
import type { CompanyNewsBundle, NewsItem } from "./shared/news";
import type { CompanyCandidate } from "./shared/report";
import { normalizeMarkdownForReading } from "./markdown-report";
import {
  FULL_ANALYSIS_TEMPLATE_ID,
  isRetryableTemplateStatus,
  type ResearchTemplate,
  type TemplateAnalysisResult,
  type TemplateAnalysisStatus,
  type UserSession,
  type WatchlistItem,
} from "./shared/user-research";
import {
  buildFullAnalysisTemplateCardState,
  resolveTemplateManagerView,
  shouldScrollTemplateEditor,
  type TemplateGenerationPhase,
  type TemplateManagerView,
} from "./template-manager-state";
import { filterWatchlistItems, findWatchlistItemForCompany, summarizeWatchlistAnalysis } from "./my-research-state";

type MyResearchViewProps = {
  user: UserSession | null;
  selectedCompany: CompanyCandidate | null;
  onOpenCompany: (company: CompanyCandidate) => void;
};

type ActiveGeneration = {
  watchlistId: string;
  templateId: string;
  label: string;
  companyName: string;
};

export function MyResearchView({ user, selectedCompany, onOpenCompany }: MyResearchViewProps) {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [analyses, setAnalyses] = useState<TemplateAnalysisResult[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState("");
  const [activeAnalysis, setActiveAnalysis] = useState<TemplateAnalysisResult | null>(null);
  const [activeNews, setActiveNews] = useState(false);
  const [companyQuery, setCompanyQuery] = useState("");
  const [companyCandidates, setCompanyCandidates] = useState<CompanyCandidate[]>([]);
  const [watchlistQuery, setWatchlistQuery] = useState("");
  const [searchingCompany, setSearchingCompany] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "generating" | "error">("loading");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [activeGeneration, setActiveGeneration] = useState<ActiveGeneration | null>(null);
  const [templates, setTemplates] = useState<ResearchTemplate[]>([]);
  const [savingTemplates, setSavingTemplates] = useState(false);
  const selectedWatchlistIdRef = useRef(selectedWatchlistId);
  const initialDataLoadedRef = useRef(false);

  useEffect(() => {
    if (initialDataLoadedRef.current) return;
    initialDataLoadedRef.current = true;
    let cancelled = false;
    Promise.all([fetchWatchlist(), fetchTemplateAnalyses(), fetchResearchTemplates()])
      .then(([watchlist, analysisData, templateData]) => {
        if (cancelled) return;
        setItems(watchlist.items);
        setAnalyses(analysisData.analyses);
        setTemplates(templateData.length ? templateData : analysisData.templates);
        setSelectedWatchlistId((current) => current || findWatchlistItemForCompany(watchlist.items, selectedCompany)?.id || watchlist.items[0]?.id || "");
        setPhase("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : "我的研究读取失败。");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCompany]);

  const selectedItem = useMemo(() => items.find((item) => item.id === selectedWatchlistId) ?? items[0] ?? null, [items, selectedWatchlistId]);
  const filteredItems = useMemo(() => filterWatchlistItems(items, watchlistQuery), [items, watchlistQuery]);
  const selectedAnalyses = useMemo(() => analyses.filter((analysis) => analysis.watchlistId === selectedItem?.id), [analyses, selectedItem?.id]);
  const analysisByTemplate = useMemo(() => new Map(selectedAnalyses.map((analysis) => [analysis.templateId, analysis])), [selectedAnalyses]);
  const selectedAnalysisSummary = useMemo(
    () => (selectedItem ? summarizeWatchlistAnalysis(analyses, selectedItem.id) : { total: 0, completed: 0, running: 0, failed: 0 }),
    [analyses, selectedItem],
  );

  useEffect(() => {
    selectedWatchlistIdRef.current = selectedItem?.id || "";
  }, [selectedItem?.id]);

  async function addCompanyToMine(company: CompanyCandidate) {
    setError("");
    setNotice("");
    try {
      const item = await addWatchlistItem({ company });
      setItems((current) => mergeWatchlistItems(current, item));
      setSelectedWatchlistId(item.id);
      setActiveAnalysis(null);
      setActiveNews(false);
      setNotice(`已加入自选：${item.company.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加入自选失败。");
    }
  }

  async function submitCompanySearch(event: React.FormEvent) {
    event.preventDefault();
    const query = companyQuery.trim();
    if (!query) return;
    setError("");
    setNotice("");
    setSearchingCompany(true);
    try {
      const candidates = await searchCompanies(query);
      setCompanyCandidates(candidates);
      if (!candidates.length) setNotice("没有找到候选公司，请换成股票代码或更完整的公司名。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "公司搜索失败。");
    } finally {
      setSearchingCompany(false);
    }
  }

  async function deleteItem(item: WatchlistItem) {
    if (!window.confirm(`确定移除「${item.company.name}」？`)) return;
    setError("");
    setNotice("");
    try {
      await removeWatchlistItem(item.id);
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      setAnalyses((current) => current.filter((analysis) => analysis.watchlistId !== item.id));
      if (selectedWatchlistId === item.id) {
        setSelectedWatchlistId("");
        setActiveAnalysis(null);
        setActiveNews(false);
      }
      setNotice(`已移除：${item.company.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除自选失败。");
    }
  }

  async function generate(templateId: string, forceRefresh = false) {
    const target = selectedItem;
    if (!target) return;
    setPhase("generating");
    setActiveGeneration({ watchlistId: target.id, templateId, label: generationLabel(templateId, templates), companyName: target.company.name });
    setError("");
    setNotice("");
    try {
      const result = await generateTemplateAnalysis({ watchlistId: target.id, templateId, forceRefresh }, (progress) => {
        if (progress.stage !== "heartbeat" && selectedWatchlistIdRef.current === target.id) setNotice(`${progress.label}：${progress.detail}`);
      });
      const nextAnalyses = result.analyses ?? (result.analysis ? [result.analysis] : []);
      setAnalyses((current) => mergeAnalyses(current, nextAnalyses));
      const completed = nextAnalyses.find((analysis) => analysis.status === "completed") ?? nextAnalyses[0];
      if (completed && selectedWatchlistIdRef.current === target.id) setActiveAnalysis(completed);
      if (completed?.status === "running") {
        setNotice(`${target.company.name}：${completed.templateTitle} 已进入后台分析，完成后会自动打开。`);
        await pollTemplateAnalysis(target, templateId);
        setPhase("ready");
        setActiveGeneration(null);
        return;
      }
      setNotice(
        templateId === FULL_ANALYSIS_TEMPLATE_ID
          ? "全面分析任务已更新：启用模板会逐项生成，已完成的模板会直接复用缓存。"
          : completed?.fromCache
            ? `已打开 ${target.company.name} 的缓存报告：${completed.templateTitle}`
            : `已生成 ${target.company.name}：${completed?.templateTitle ?? "模板报告"}`,
      );
      setPhase("ready");
      setActiveGeneration(null);
    } catch (err) {
      setPhase("error");
      setActiveGeneration(null);
      setError(err instanceof Error ? err.message : "模板分析生成失败。");
    }
  }

  async function pollTemplateAnalysis(target: WatchlistItem, templateId: string) {
    const startedAt = Date.now();
    const timeoutMs = 18 * 60 * 1000;
    while (Date.now() - startedAt < timeoutMs) {
      await wait(5000);
      const data = await fetchTemplateAnalyses(target.id);
      setAnalyses((current) => mergeAnalyses(current, data.analyses));
      const analysis = data.analyses.find((item) => item.templateId === templateId);
      if (!analysis || analysis.status === "pending" || analysis.status === "running") {
        if (selectedWatchlistIdRef.current === target.id) setNotice(`${target.company.name} 模板报告仍在后台生成，页面会自动刷新。`);
        continue;
      }
      if (analysis.status === "completed") {
        const hydrated = await fetchTemplateAnalysis(analysis.id);
        setAnalyses((current) => mergeAnalyses(current, [hydrated]));
        if (selectedWatchlistIdRef.current === target.id) setActiveAnalysis(hydrated);
        setNotice(analysis.fromCache ? `已打开 ${target.company.name} 的缓存报告。` : `${target.company.name} 模板报告已生成并写入报告库。`);
        return;
      }
      if (selectedWatchlistIdRef.current === target.id) setActiveAnalysis(analysis);
      throw new Error(analysis.errorMessage || analysis.summary || "模板后台分析失败。");
    }
    throw new Error("模板报告仍在后台生成，请稍后刷新我的研究查看。");
  }

  async function openAnalysis(analysis: TemplateAnalysisResult) {
    setError("");
    try {
      const hydrated = await fetchTemplateAnalysis(analysis.id);
      setActiveAnalysis(hydrated);
      setAnalyses((current) => mergeAnalyses(current, [hydrated]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "模板报告读取失败。");
    }
  }

  async function saveTemplates(nextTemplates: ResearchTemplate[], successMessage = "模板设置已保存。") {
    setError("");
    setNotice("");
    setSavingTemplates(true);
    try {
      const saved = await saveResearchTemplates(nextTemplates);
      setTemplates(saved);
      setNotice(successMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "模板保存失败。");
    } finally {
      setSavingTemplates(false);
    }
  }

  async function saveCurrentTemplatesAsDefault() {
    setError("");
    setNotice("");
    setSavingTemplates(true);
    try {
      const saved = await saveResearchTemplatesAsDefault();
      setTemplates(saved);
      setNotice("已把当前模板集保存为默认设置。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "默认模板保存失败。");
    } finally {
      setSavingTemplates(false);
    }
  }

  async function resetTemplates() {
    setError("");
    setNotice("");
    setSavingTemplates(true);
    try {
      const saved = await resetResearchTemplatesToDefault();
      setTemplates(saved);
      setNotice("已重置为默认模板设置。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "模板重置失败。");
    } finally {
      setSavingTemplates(false);
    }
  }

  async function refreshTemplates() {
    setError("");
    setSavingTemplates(true);
    try {
      setTemplates(await fetchResearchTemplates());
    } catch (err) {
      setError(err instanceof Error ? err.message : "模板读取失败。");
    } finally {
      setSavingTemplates(false);
    }
  }

  return (
    <section className="my-workspace" aria-labelledby="my-title">
      <header className="ranking-header">
        <div>
          <p className="eyebrow">我的研究</p>
          <h2 id="my-title">自选股公司工作台</h2>
          <p className="muted">{user?.displayName || user?.username || "固定账号"} 的自选股、公司级操作台和模板深度分析。</p>
        </div>
        <div className="ranking-summary">
          <Metric label="自选股" value={`${items.length}`} />
          <Metric label="分析任务" value={`${analyses.length}`} />
          <Metric label="当前公司" value={selectedItem?.company.name || selectedCompany?.name || "未选择"} />
          <Metric label="状态" value={phase === "generating" ? "生成中" : "就绪"} />
        </div>
      </header>

      {activeGeneration ? (
        <div className="generation-status" role="status" aria-live="polite">
          <span className="generation-pulse" aria-hidden="true" />
          <div>
            <strong>
              {activeGeneration.companyName}：{activeGeneration.label}正在生成
            </strong>
            <p>已提交到后端任务队列，完成后会自动更新；已生成过的内容会优先复用缓存。切换公司不会打断当前任务。</p>
          </div>
        </div>
      ) : null}
      {notice ? <p className="cache-notice">{notice}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      <section className="mine-search-card" aria-label="搜索并加入自选股">
        <div>
          <h3>添加自选公司</h3>
          <p className="muted">先搜索全市场上市主体，确认代码、市场和交易所后加入自选。</p>
        </div>
        <form onSubmit={submitCompanySearch} className="mine-search-form">
          <input value={companyQuery} onChange={(event) => setCompanyQuery(event.target.value)} placeholder="例如：贵州茅台、000333、AMZN、英伟达" />
          <button type="submit" disabled={searchingCompany || phase === "generating"}>
            {searchingCompany ? "搜索中..." : "搜索公司"}
          </button>
        </form>
        {companyCandidates.length ? (
          <div className="mine-candidate-list">
            {companyCandidates.map((candidate) => (
              <button key={candidate.id} type="button" onClick={() => void addCompanyToMine(candidate)}>
                <strong>{candidate.name}</strong>
                <span>
                  {candidate.code} / {candidate.listingPlace} / {candidate.exchange}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <div className={`my-grid ${activeAnalysis || activeNews ? "reading-mode" : ""}`}>
        {!activeAnalysis && !activeNews ? (
          <section className="my-list">
            <div className="my-list-header">
              <div>
                <h3>我的自选股</h3>
                <p className="muted">筛选已加入的公司，不影响当前选中公司。</p>
              </div>
              <span>{filteredItems.length} / {items.length}</span>
            </div>
            <label className="watchlist-filter">
              <span>搜索自选</span>
              <input
                value={watchlistQuery}
                onChange={(event) => setWatchlistQuery(event.target.value)}
                placeholder="公司名、代码、市场、交易所"
              />
            </label>
            {items.length ? (
              filteredItems.length ? (
                filteredItems.map((item) => {
                  const itemSummary = summarizeWatchlistAnalysis(analyses, item.id);
                  return (
                    <article key={item.id} className={item.id === selectedItem?.id ? "active" : ""}>
                      <button
                        type="button"
                        className="ranking-company"
                        onClick={() => {
                          setSelectedWatchlistId(item.id);
                          setActiveAnalysis(null);
                          setActiveNews(false);
                        }}
                      >
                        <CompanyIdentity company={item.company} size="sm" />
                        <span className="watchlist-meta">
                          {item.company.code} / {item.company.listingPlace} / 已完成 {itemSummary.completed} 个模板
                        </span>
                      </button>
                      <div>
                        <button type="button" className="secondary-button" onClick={() => onOpenCompany(item.company)}>
                          基础报告
                        </button>
                        <button type="button" className="ghost-button" onClick={() => void deleteItem(item)}>
                          移除
                        </button>
                      </div>
                    </article>
                  );
                })
              ) : (
                <p className="muted">没有匹配的自选股，换个公司名、代码或市场试试。</p>
              )
            ) : (
              <p className="muted">先在报告页或排行榜打开一家公司，再加入当前公司。</p>
            )}
          </section>
        ) : null}

        <section className="analysis-panel">
          {selectedItem ? (
            <CompanyWorkbench
              item={selectedItem}
              analysisByTemplate={analysisByTemplate}
              activeAnalysis={activeAnalysis}
              activeNews={activeNews}
              phase={phase}
              templates={templates}
              activeGeneration={activeGeneration}
              analysisSummary={selectedAnalysisSummary}
              onGenerate={(templateId, forceRefresh) => void generate(templateId, forceRefresh)}
              onOpenAnalysis={(analysis) => void openAnalysis(analysis)}
              onOpenBaseReport={() => onOpenCompany(selectedItem.company)}
              onOpenNews={() => setActiveNews(true)}
              onBackToTemplates={() => setActiveAnalysis(null)}
              onBackFromNews={() => setActiveNews(false)}
            />
          ) : (
            <>
              <h3>公司工作台</h3>
              <p className="muted">选择或加入一家公司后，可以在这里生成单模板深度报告。</p>
            </>
          )}
        </section>
      </div>

      <TemplateManager
        templates={templates}
        disabled={phase === "generating" || savingTemplates}
        saving={savingTemplates}
        onSave={(nextTemplates) => void saveTemplates(nextTemplates)}
        onSaveDefault={() => void saveCurrentTemplatesAsDefault()}
        onResetDefault={() => void resetTemplates()}
        onRefresh={() => void refreshTemplates()}
      />
    </section>
  );
}

function TemplateManager({
  templates,
  disabled,
  saving,
  onSave,
  onSaveDefault,
  onResetDefault,
  onRefresh,
}: {
  templates: ResearchTemplate[];
  disabled: boolean;
  saving: boolean;
  onSave: (templates: ResearchTemplate[]) => void;
  onSaveDefault: () => void;
  onResetDefault: () => void;
  onRefresh: () => void;
}) {
  const [view, setView] = useState<TemplateManagerView>("summary");
  const [editingTemplateId, setEditingTemplateId] = useState("");
  const [draftState, setDraftState] = useState(() => ({ source: templates, drafts: templates }));
  const [completionState, setCompletionState] = useState<{ templateId: string; messageTemplateId: string; error: string; notice: string }>({
    templateId: "",
    messageTemplateId: "",
    error: "",
    notice: "",
  });
  const editorPanelRef = useRef<HTMLElement | null>(null);
  const previousEditorNavigationRef = useRef<{ view: TemplateManagerView; editingTemplateId: string }>({ view: "summary", editingTemplateId: "" });

  const drafts = draftState.source === templates ? draftState.drafts : templates;
  const resolvedNavigation = resolveTemplateManagerView(view, editingTemplateId, drafts);
  const currentView = resolvedNavigation.view;
  const currentEditingTemplateId = resolvedNavigation.editingTemplateId;

  const enabledCount = drafts.filter((template) => template.enabled !== false).length;
  const hasInvalidTemplate = drafts.some((template) => !template.title.trim() || !template.prompt.trim() || !template.fullPrompt.trim());
  const hasChanges = JSON.stringify(normalizeTemplateDrafts(drafts)) !== JSON.stringify(normalizeTemplateDrafts(templates));
  const editingTemplate = drafts.find((template) => template.id === currentEditingTemplateId) ?? null;

  useEffect(() => {
    const previous = previousEditorNavigationRef.current;
    if (shouldScrollTemplateEditor(previous.view, previous.editingTemplateId, currentView, currentEditingTemplateId)) {
      editorPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    previousEditorNavigationRef.current = { view: currentView, editingTemplateId: currentEditingTemplateId };
  }, [currentView, currentEditingTemplateId]);

  function updateDrafts(updater: (current: ResearchTemplate[]) => ResearchTemplate[]) {
    setDraftState((current) => {
      const currentDrafts = current.source === templates ? current.drafts : templates;
      return { source: templates, drafts: updater(currentDrafts) };
    });
  }

  function updateTemplate(id: string, patch: Partial<ResearchTemplate>) {
    updateDrafts((current) => current.map((template) => (template.id === id ? { ...template, ...patch } : template)));
  }

  async function completeTemplateWithAi(template: ResearchTemplate) {
    const source = template.fullPrompt.trim();
    if (!source) {
      setCompletionState({ templateId: "", messageTemplateId: template.id, error: "请先把草稿粘贴到完整模板正文，再点击 AI 补全。", notice: "" });
      return;
    }
    setCompletionState({ templateId: template.id, messageTemplateId: template.id, error: "", notice: "" });
    try {
      const completion = await completeResearchTemplateDraft({
        title: template.title,
        shortTitle: template.shortTitle,
        focus: template.focus,
        prompt: template.prompt,
        fullPrompt: template.fullPrompt,
        sectionRequirements: template.sectionRequirements,
      });
      updateTemplate(template.id, completion);
      setCompletionState({ templateId: "", messageTemplateId: template.id, error: "", notice: "AI 已补齐并优化当前模板，确认后请保存模板。" });
    } catch (err) {
      setCompletionState({ templateId: "", messageTemplateId: template.id, error: err instanceof Error ? err.message : "模板 AI 补全失败。", notice: "" });
    }
  }

  function addTemplate() {
    const id = `custom-template-${Date.now()}`;
    updateDrafts((current) => {
      const nextNumber = current.length + 1;
      return [
        ...current,
        {
          id,
          title: `自定义模板${nextNumber}`,
          shortTitle: "自定义",
          focus: "按用户自定义框架分析公司的核心问题、证据、风险与结论。",
          prompt: "请基于公开证据，按这个自定义模板完整分析公司。",
          fullPrompt: "# 自定义公司分析模板\n\n请围绕（      ）公司，按以下维度完成分析：\n\n1. 核心问题\n2. 证据链\n3. 关键风险\n4. 投资结论\n5. 后续跟踪指标",
          enabled: true,
          sortOrder: nextNumber,
          isSystem: false,
        },
      ];
    });
    setEditingTemplateId(id);
    setView("edit");
  }

  function removeTemplate(id: string) {
    updateDrafts((current) => current.filter((template) => template.id !== id));
    if (currentEditingTemplateId === id) {
      setEditingTemplateId("");
      setView("list");
    }
  }

  function moveTemplate(id: string, delta: -1 | 1) {
    updateDrafts((current) => {
      const index = current.findIndex((template) => template.id === id);
      const targetIndex = index + delta;
      if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(targetIndex, 0, item);
      return next.map((template, sortIndex) => ({ ...template, sortOrder: sortIndex + 1 }));
    });
  }

  function renderToolbar() {
    return (
      <>
        <div className="template-manager-toolbar">
          <button type="button" disabled={disabled || hasInvalidTemplate || !hasChanges} onClick={() => onSave(normalizeTemplateDrafts(drafts))}>
            {saving ? "保存中..." : "保存模板"}
          </button>
          <button type="button" className="secondary-button" disabled={disabled || hasChanges} onClick={onSaveDefault}>
            保存当前为默认
          </button>
          <button type="button" className="secondary-button" disabled={disabled} onClick={onResetDefault}>
            重置为默认
          </button>
          <button type="button" className="ghost-button" disabled={disabled} onClick={onRefresh}>
            刷新
          </button>
        </div>
        {hasInvalidTemplate ? <p className="error-text">模板标题、模型提示词和完整模板正文不能为空。</p> : null}
        {!enabledCount ? <p className="cache-notice">当前没有启用模板；公司工作台需要至少启用一个模板。</p> : null}
      </>
    );
  }

  function renderTemplateList() {
    return (
      <div className="template-list" aria-label="模板列表">
        {drafts.map((template, index) => (
          <article key={template.id} className={template.enabled === false ? "template-list-row is-disabled" : "template-list-row"}>
            <label className="template-toggle template-list-toggle">
              <input
                type="checkbox"
                aria-label={`${template.title || "未命名模板"}：${template.enabled === false ? "启用模板" : "停用模板"}`}
                checked={template.enabled !== false}
                disabled={disabled}
                onChange={(event) => updateTemplate(template.id, { enabled: event.target.checked })}
              />
              <span>{template.enabled === false ? "停用" : "启用"}</span>
            </label>
            <div className="template-list-main">
              <strong>{template.title}</strong>
              <span>
                {template.shortTitle || "模板"} / {template.isSystem ? "默认模板" : "自定义模板"}
              </span>
              <p>{template.focus}</p>
            </div>
            <div className="template-list-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={disabled}
                onClick={() => {
                  setEditingTemplateId(template.id);
                  setView("edit");
                }}
              >
                编辑
              </button>
              <button type="button" className="ghost-button" disabled={disabled || index === 0} onClick={() => moveTemplate(template.id, -1)}>
                上移
              </button>
              <button type="button" className="ghost-button" disabled={disabled || index === drafts.length - 1} onClick={() => moveTemplate(template.id, 1)}>
                下移
              </button>
              <button type="button" className="ghost-button" disabled={disabled} onClick={() => removeTemplate(template.id)}>
                移除
              </button>
            </div>
          </article>
        ))}
      </div>
    );
  }

  return (
    <section className="template-manager" aria-label="模板管理">
      <header>
        <div>
          <p className="eyebrow">模板管理</p>
          <h3>{currentView === "summary" ? "全局模板设置" : currentView === "list" ? "模板列表" : "编辑单个模板"}</h3>
          <p className="muted">
            当前启用 {enabledCount} / {drafts.length || templates.length} 个模板；保存后会同步用于所有公司分析，新闻雷达不受影响。
          </p>
        </div>
        <div className="template-manager-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setEditingTemplateId("");
              setView(currentView === "summary" ? "list" : "summary");
            }}
          >
            {currentView === "summary" ? "管理模板" : "返回概览"}
          </button>
          <button type="button" className="secondary-button" disabled={disabled} onClick={addTemplate}>
            新增模板
          </button>
        </div>
      </header>
      {currentView === "summary" && hasChanges ? <p className="cache-notice">模板有未保存更改，进入“管理模板”后可以保存或刷新。</p> : null}
      {currentView === "list" ? (
        <div className="template-manager-view">
          {renderToolbar()}
          {renderTemplateList()}
        </div>
      ) : null}
      {currentView === "edit" && editingTemplate ? (
        <div className="template-manager-view">
          {renderToolbar()}
          <article ref={editorPanelRef} className={editingTemplate.enabled === false ? "template-editor template-edit-panel is-disabled" : "template-editor template-edit-panel"}>
            <div className="template-edit-header">
              <div>
                <p className="eyebrow">{editingTemplate.isSystem ? "默认模板" : "自定义模板"}</p>
                <h4>{editingTemplate.title || "未命名模板"}</h4>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setEditingTemplateId("");
                  setView("list");
                }}
              >
                返回模板列表
              </button>
            </div>
            <label className="template-toggle">
              <input
                type="checkbox"
                aria-label={`${editingTemplate.title || "未命名模板"}：${editingTemplate.enabled === false ? "启用模板" : "停用模板"}`}
                checked={editingTemplate.enabled !== false}
                disabled={disabled}
                onChange={(event) => updateTemplate(editingTemplate.id, { enabled: event.target.checked })}
              />
              <span>{editingTemplate.enabled === false ? "停用" : "启用"}</span>
            </label>
            <div className="template-editor-grid">
              <label>
                <span>模板标题</span>
                <input value={editingTemplate.title} disabled={disabled} onChange={(event) => updateTemplate(editingTemplate.id, { title: event.target.value })} />
              </label>
              <label>
                <span>短标题</span>
                <input
                  value={editingTemplate.shortTitle}
                  disabled={disabled}
                  onChange={(event) => updateTemplate(editingTemplate.id, { shortTitle: event.target.value })}
                />
              </label>
            </div>
            <label>
              <span>卡片说明</span>
              <textarea value={editingTemplate.focus} rows={2} disabled={disabled} onChange={(event) => updateTemplate(editingTemplate.id, { focus: event.target.value })} />
            </label>
            <label>
              <span>模型提示词</span>
              <textarea value={editingTemplate.prompt} rows={3} disabled={disabled} onChange={(event) => updateTemplate(editingTemplate.id, { prompt: event.target.value })} />
            </label>
            <label>
              <span>完整模板正文</span>
              <textarea
                value={editingTemplate.fullPrompt}
                rows={12}
                disabled={disabled}
                onChange={(event) => updateTemplate(editingTemplate.id, { fullPrompt: event.target.value })}
              />
            </label>
            <div className="template-completion-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={disabled || completionState.templateId === editingTemplate.id || !editingTemplate.fullPrompt.trim()}
                onClick={() => void completeTemplateWithAi(editingTemplate)}
              >
                {completionState.templateId === editingTemplate.id ? (
                  <>
                    <Spinner /> AI 补全中
                  </>
                ) : (
                  "AI 一键补全"
                )}
              </button>
              {completionState.messageTemplateId === editingTemplate.id && completionState.notice ? <span>{completionState.notice}</span> : null}
            </div>
            {completionState.messageTemplateId === editingTemplate.id && completionState.error ? <p className="error-text">{completionState.error}</p> : null}
          </article>
        </div>
      ) : null}
    </section>
  );
}

function CompanyWorkbench({
  item,
  analysisByTemplate,
  activeAnalysis,
  activeNews,
  phase,
  templates,
  activeGeneration,
  analysisSummary,
  onGenerate,
  onOpenAnalysis,
  onOpenBaseReport,
  onOpenNews,
  onBackToTemplates,
  onBackFromNews,
}: {
  item: WatchlistItem;
  analysisByTemplate: Map<string, TemplateAnalysisResult>;
  activeAnalysis: TemplateAnalysisResult | null;
  activeNews: boolean;
  phase: TemplateGenerationPhase;
  templates: ResearchTemplate[];
  activeGeneration: ActiveGeneration | null;
  analysisSummary: ReturnType<typeof summarizeWatchlistAnalysis>;
  onGenerate: (templateId: string, forceRefresh?: boolean) => void;
  onOpenAnalysis: (analysis: TemplateAnalysisResult) => void;
  onOpenBaseReport: () => void;
  onOpenNews: () => void;
  onBackToTemplates: () => void;
  onBackFromNews: () => void;
}) {
  const activeTemplates = templates.filter((template) => template.enabled !== false);
  const fullAnalysis = analysisByTemplate.get(FULL_ANALYSIS_TEMPLATE_ID);
  const generatingTemplateId = activeGeneration?.watchlistId === item.id ? activeGeneration.templateId : "";
  const fullAnalysisCard = buildFullAnalysisTemplateCardState(activeTemplates.length, phase);
  if (activeAnalysis) {
    return <TemplateReportReader analysis={activeAnalysis} onBack={onBackToTemplates} />;
  }
  if (activeNews) {
    return <NewsReportReader item={item} onBack={onBackFromNews} />;
  }
  return (
    <>
      <div className="company-workbench-header">
        <div>
          <p className="eyebrow">公司工作台</p>
          <CompanyIdentity company={item.company} size="lg" />
          <p className="muted">
            {item.company.code} / {item.company.listingPlace} / {item.company.exchange}
          </p>
          <p className="muted">
            已启用 {activeTemplates.length} 个模板；单模板会独立读取公开公司证据并按完整模板生成，全面分析会先跑完启用模板，再做最终交叉整合。
          </p>
        </div>
        <div className="workbench-side">
          <div className="workbench-kpis" aria-label="当前公司分析状态">
            <span>
              <strong>{analysisSummary.completed}</strong>
              已完成
            </span>
            <span>
              <strong>{analysisSummary.running}</strong>
              生成中
            </span>
            <span>
              <strong>{analysisSummary.failed}</strong>
              需复核
            </span>
          </div>
          <div className="workbench-actions">
            <button type="button" className="secondary-button" onClick={onOpenBaseReport}>
              基础报告
            </button>
            <button type="button" className="secondary-button" onClick={onOpenNews}>
              新闻雷达
            </button>
            <button type="button" disabled={fullAnalysisCard.disabled} onClick={() => onGenerate(FULL_ANALYSIS_TEMPLATE_ID)}>
              全面分析
            </button>
          </div>
        </div>
      </div>

      <NewsEntryCard item={item} onOpen={onOpenNews} />

      <section className="template-grid" aria-label="全部模板深度分析">
        <TemplateCard
          title={fullAnalysisCard.title}
          focus={fullAnalysisCard.focus}
          analysis={fullAnalysis}
          isGenerating={generatingTemplateId === FULL_ANALYSIS_TEMPLATE_ID}
          disabled={fullAnalysisCard.disabled}
          onGenerate={() => onGenerate(FULL_ANALYSIS_TEMPLATE_ID)}
          onRegenerate={() => onGenerate(FULL_ANALYSIS_TEMPLATE_ID, true)}
          onOpen={onOpenAnalysis}
        />
        {activeTemplates.map((template) => (
          <TemplateCard
            key={template.id}
            title={template.title}
            focus={template.focus}
            analysis={analysisByTemplate.get(template.id)}
            isGenerating={generatingTemplateId === template.id}
            disabled={phase === "generating"}
            onGenerate={() => onGenerate(template.id)}
            onRegenerate={() => onGenerate(template.id, true)}
            onOpen={onOpenAnalysis}
          />
        ))}
      </section>

      {fullAnalysis ? (
        <section className="analysis-result compact-analysis-result">
          <h3>全面分析摘要</h3>
          <p>{fullAnalysis.summary}</p>
          <button type="button" className="secondary-button" onClick={() => onOpenAnalysis(fullAnalysis)}>
            查看全面分析
          </button>
        </section>
      ) : null}
    </>
  );
}

function TemplateCard({
  title,
  focus,
  analysis,
  isGenerating,
  disabled,
  onGenerate,
  onRegenerate,
  onOpen,
}: {
  title: string;
  focus: string;
  analysis?: TemplateAnalysisResult;
  isGenerating: boolean;
  disabled: boolean;
  onGenerate: () => void;
  onRegenerate: () => void;
  onOpen: (analysis: TemplateAnalysisResult) => void;
}) {
  const status = analysis?.status ?? "pending";
  const displayStatus = isGenerating ? "running" : status;
  return (
    <article className={`template-card status-${displayStatus} ${isGenerating ? "is-generating" : ""}`}>
      <div>
        <strong>{title}</strong>
        <span>{isGenerating ? "生成中" : statusLabel(status)}</span>
      </div>
      <p>{isGenerating ? "正在基于公司证据包生成深度内容，完成后会自动更新到报告库。" : analysis?.summary || focus}</p>
      {analysis?.fromCache ? <small>证据未发生实质变化，已复用缓存</small> : analysis?.evidenceHash ? <small>已绑定公司证据包</small> : null}
      <footer>
        {analysis?.status === "completed" && !isGenerating ? (
          <button type="button" className="secondary-button" onClick={() => onOpen(analysis)}>
            查看
          </button>
        ) : null}
        <button type="button" disabled={disabled} onClick={analysis ? onRegenerate : onGenerate}>
          {isGenerating ? (
            <>
              <Spinner /> 生成中
            </>
          ) : analysis && (analysis.status === "completed" || isRetryableTemplateStatus(analysis.status)) ? (
            "重新生成"
          ) : (
            "生成"
          )}
        </button>
      </footer>
    </article>
  );
}

function TemplateReportReader({ analysis, onBack }: { analysis: TemplateAnalysisResult; onBack: () => void }) {
  return (
    <section className="analysis-reader" aria-label="模板报告阅读页">
      <header className="analysis-reader-header">
        <div>
          <p className="eyebrow">模板报告阅读页</p>
          <h3>{analysis.title || analysis.templateTitle}</h3>
          <p className="muted">
            {analysis.companyName} / {analysis.ticker} / {analysis.market}
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={onBack}>
          返回模板
        </button>
      </header>
      <div className="dashboard-grid">
        <Info label="模板" value={analysis.templateTitle} />
        <Info label="状态" value={statusLabel(analysis.status)} />
        <Info label="评分" value={analysis.score === undefined ? "待验证" : analysis.score.toFixed(1)} />
        <Info label="结论" value={analysis.verdict} />
      </div>
      {analysis.errorMessage ? <p className="error-text">{analysis.errorMessage}</p> : null}
      <section className="analysis-summary">
        <h4>摘要</h4>
        <p>{analysis.summary}</p>
      </section>
      <div className="analysis-meta">
        {analysis.completedAt ? <span>完成时间：{formatDateTime(analysis.completedAt)}</span> : null}
        {analysis.markdown ? <span>正文长度：{analysis.markdown.length.toLocaleString("zh-CN")} 字符</span> : null}
        {analysis.objectKey ? <span>R2 已保存</span> : null}
      </div>
      <div className="analysis-lists">
        <section>
          <h4>主要得分点</h4>
          <ul>{listItems(analysis.keyPoints)}</ul>
        </section>
        <section>
          <h4>风险与反证</h4>
          <ul>{listItems(analysis.riskFlags)}</ul>
        </section>
        <section>
          <h4>跟踪指标</h4>
          <ul>{listItems(analysis.followUps)}</ul>
        </section>
      </div>
      {analysis.markdown ? <MarkdownReport markdown={analysis.markdown} /> : null}
    </section>
  );
}

function NewsEntryCard({ item, onOpen }: { item: WatchlistItem; onOpen: () => void }) {
  const cached = loadCachedNewsBundle(item);
  const companyTotal = cached?.companySummary.total ?? 0;
  const industryTotal = cached?.industrySummary.total ?? 0;
  const sourceCount = (cached?.companySummary.sourceCount ?? 0) + (cached?.industrySummary.sourceCount ?? 0);
  return (
    <article className="news-entry-card">
      <div>
        <p className="eyebrow">新闻雷达</p>
        <h4>公司与行业新闻</h4>
        <p className="muted">
          {cached
            ? `已缓存 ${formatDateTime(cached.fetchedAt)} 的新闻。公司 ${companyTotal} 条，行业 ${industryTotal} 条，覆盖约 ${sourceCount} 个来源。`
            : "单独进入新闻页后再刷新公开新闻源；切换自选股不会自动请求，避免浪费和误触发新闻源限制。"}
        </p>
      </div>
      <button type="button" className="secondary-button" onClick={onOpen}>
        查看新闻雷达
      </button>
    </article>
  );
}

function NewsReportReader({ item, onBack }: { item: WatchlistItem; onBack: () => void }) {
  return (
    <section className="analysis-reader news-reader" aria-label="新闻雷达阅读页">
      <header className="analysis-reader-header">
        <div>
          <p className="eyebrow">新闻雷达阅读页</p>
          <CompanyIdentity company={item.company} size="lg" />
          <p className="muted">公司新闻按近六个月事件跟踪；行业与细分产业按近三年周期、政策和供需趋势跟踪。</p>
        </div>
        <button type="button" className="secondary-button" onClick={onBack}>
          返回公司工作台
        </button>
      </header>
      <NewsRadar key={item.id} item={item} />
    </section>
  );
}

function NewsRadar({ item }: { item: WatchlistItem }) {
  const [bundle, setBundle] = useState<CompanyNewsBundle | null>(() => loadCachedNewsBundle(item));
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">(() => (loadCachedNewsBundle(item) ? "ready" : "idle"));
  const [error, setError] = useState("");

  async function refreshNews() {
    setPhase("loading");
    setError("");
    await fetchCompanyNews(item.id)
      .then((data) => {
        saveCachedNewsBundle(item, data);
        setBundle(data);
        setPhase("ready");
      })
      .catch((err) => {
        setPhase(bundle ? "ready" : "error");
        setError(err instanceof Error ? err.message : "新闻读取失败。");
      });
  }

  return (
    <section className="news-radar" aria-label="公司与行业新闻">
      <header>
        <div>
          <p className="eyebrow">实时新闻雷达</p>
          <h4>公司新闻与行业新闻</h4>
          <p className="muted">
            {phase === "loading"
              ? "正在读取公开新闻源。"
              : bundle
                ? `已缓存 ${formatDateTime(bundle.fetchedAt)} 的新闻；公司关键词：${bundle.companyQuery}；行业关键词：${bundle.industryQuery}`
                : "尚未读取新闻。公司新闻按近六个月事件跟踪；行业与细分产业按近三年周期、政策和供需趋势跟踪。点击“刷新新闻”后再请求公开新闻源。"}
          </p>
        </div>
        <button type="button" className="secondary-button" disabled={phase === "loading"} onClick={() => void refreshNews()}>
          刷新新闻
        </button>
      </header>
      {phase === "error" ? <p className="error-text">{error}</p> : null}
      {phase !== "error" && error ? <p className="error-text">{error}</p> : null}
      {bundle?.companyNewsError || bundle?.industryNewsError ? (
        <p className="cache-notice">
          {[
            bundle.companyNewsError ? `公司新闻源：${bundle.companyNewsError}` : "",
            bundle.industryNewsError ? `行业新闻源：${bundle.industryNewsError}` : "",
          ]
            .filter(Boolean)
            .join("；")}
        </p>
      ) : null}
      {bundle ? (
        <div className="news-sentiment-grid">
          <SentimentMeter title="公司新闻情绪" summary={bundle.companySummary} />
          <SentimentMeter title="行业新闻情绪" summary={bundle.industrySummary} />
        </div>
      ) : null}
      <div className="news-columns">
        <NewsColumn title={`${item.company.name} 相关新闻`} items={bundle?.companyNews ?? []} loading={phase === "loading" && !bundle} idle={phase === "idle"} />
        <NewsColumn
          title={`${bundle?.industryLabel || "所属行业"} 行业新闻`}
          items={bundle?.industryNews ?? []}
          loading={phase === "loading" && !bundle}
          idle={phase === "idle"}
        />
      </div>
    </section>
  );
}

function CompanyIdentity({ company, size = "md" }: { company: CompanyCandidate; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`company-identity company-identity-${size}`}>
      <span className="company-logo-mark" aria-hidden="true" style={{ "--logo-accent": companyLogoColor(company) } as CSSProperties}>
        {companyLogoText(company)}
      </span>
      <span>
        <strong>{company.name}</strong>
        {size !== "lg" ? (
          <small>
            {company.code} / {company.listingPlace}
          </small>
        ) : null}
      </span>
    </span>
  );
}

function SentimentMeter({ title, summary }: { title: string; summary: CompanyNewsBundle["companySummary"] }) {
  return (
    <section className={`sentiment-meter sentiment-meter-${summary.overall}`}>
      <div>
        <span>{title}</span>
        <strong>{summary.overallLabel}</strong>
      </div>
      <div className="sentiment-track" aria-label={`${title} 利好 ${summary.positivePct}% 利空 ${summary.negativePct}% 中性 ${summary.neutralPct}%`}>
        <i className="meter-positive" style={{ width: `${summary.positivePct}%` }} />
        <i className="meter-neutral" style={{ width: `${summary.neutralPct}%` }} />
        <i className="meter-negative" style={{ width: `${summary.negativePct}%` }} />
      </div>
      <footer>
        <span>利好 {summary.positivePct}%</span>
        <span>中性 {summary.neutralPct}%</span>
        <span>利空 {summary.negativePct}%</span>
      </footer>
      <small>
        {summary.qualityLabel}；样本 {summary.total} 条，覆盖 {summary.sourceCount || 0} 个来源
        {summary.sources?.length ? `：${summary.sources.slice(0, 4).join("、")}` : ""}。
      </small>
      {summary.qualityWarning ? <small className="sentiment-warning">{summary.qualityWarning}</small> : null}
    </section>
  );
}

function NewsColumn({ title, items, loading, idle }: { title: string; items: NewsItem[]; loading: boolean; idle: boolean }) {
  return (
    <section>
      <h5>{title}</h5>
      {loading ? <p className="muted">读取中...</p> : null}
      {idle ? <p className="muted">点击刷新新闻后读取。</p> : null}
      {!loading && !idle && !items.length ? <p className="muted">暂无可展示新闻。</p> : null}
      <div className="news-list">
        {items.map((item) => (
          <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className={`news-card sentiment-${item.sentiment}`}>
            <span className="sentiment-badge">{item.sentimentLabel}</span>
            <strong>{item.title}</strong>
            <small>
              {item.source}
              {item.publishedAt ? ` / ${formatDateTime(item.publishedAt)}` : ""}
            </small>
            <em>{item.sentimentReason}</em>
          </a>
        ))}
      </div>
    </section>
  );
}

function loadCachedNewsBundle(item: WatchlistItem) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(newsCacheKey(item));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CompanyNewsBundle;
    if (!parsed?.fetchedAt || !Array.isArray(parsed.companyNews) || !Array.isArray(parsed.industryNews)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCachedNewsBundle(item: WatchlistItem, bundle: CompanyNewsBundle) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(newsCacheKey(item), JSON.stringify(bundle));
  } catch {
    // News cache is an optimization; ignore storage quota or privacy-mode failures.
  }
}

function newsCacheKey(item: WatchlistItem) {
  const company = item.company;
  return `cstd-news-cache:v5:${company.marketType || ""}:${company.listingPlace || ""}:${company.code || company.name}`;
}

function MarkdownReport({ markdown }: { markdown: string }) {
  const blocks = normalizeMarkdownForReading(markdown)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block && !/^#{1,6}\s*$/.test(block));
  return (
    <div className="markdown-report">
      {blocks.map((block, index) => {
        if (/^###\s+/.test(block)) return <h5 key={index}>{renderInline(block.replace(/^###\s+/, ""))}</h5>;
        if (/^##\s+/.test(block)) return <h4 key={index}>{renderInline(block.replace(/^##\s+/, ""))}</h4>;
        if (/^#\s+/.test(block)) return <h3 key={index}>{renderInline(block.replace(/^#\s+/, ""))}</h3>;
        const numbered = block.match(/^(\d{1,2})\.\s+([\s\S]+)$/);
        if (numbered) {
          const body = numbered[2].trim();
          const [heading, rest] = splitNumberedSection(body);
          return (
            <section key={index} className="markdown-numbered-section">
              <h4>
                <span className="markdown-section-index">{numbered[1]}</span>
                <span className="markdown-section-title">{renderInline(heading)}</span>
              </h4>
              {rest ? <p>{renderInline(rest)}</p> : null}
            </section>
          );
        }
        if (/^[-*]\s+/m.test(block)) {
          return (
            <ul key={index}>
              {block
                .split(/\n/)
                .map((line) => line.replace(/^[-*]\s+/, "").trim())
                .filter(Boolean)
                .map((line, lineIndex) => (
                  <li key={`${lineIndex}:${line}`}>{line}</li>
              ))}
            </ul>
          );
        }
        if (isMarkdownTable(block)) return <MarkdownTable key={index} block={block} />;
        return <p key={index}>{renderInline(block)}</p>;
      })}
    </div>
  );
}

function MarkdownTable({ block }: { block: string }) {
  const rows = parseMarkdownTable(block);
  if (rows.length < 2) return <p>{renderInline(block)}</p>;
  const [head, ...body] = rows;
  return (
    <div className="markdown-table-wrap">
      <table>
        <thead>
          <tr>{head.map((cell, index) => <th key={`${cell}-${index}`}>{renderInline(cell)}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={row.join("|") || rowIndex}>
              {row.map((cell, cellIndex) => <td key={`${cell}-${cellIndex}`}>{renderInline(cell)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isMarkdownTable(block: string) {
  const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length >= 2 && lines[0].startsWith("|") && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[1]);
}

function parseMarkdownTable(block: string) {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index) => line && index !== 1)
    .map((line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
}

function splitNumberedSection(body: string) {
  const scoreIndex = body.search(/\s+\*\*评分：/);
  const analysisIndex = body.search(/\s+\*\*分析：/);
  const cut = [scoreIndex, analysisIndex].filter((index) => index > 0).sort((left, right) => left - right)[0];
  if (!cut) return [body, ""] as const;
  return [body.slice(0, cut).trim(), body.slice(cut).trim()] as const;
}

function renderInline(value: string): ReactNode[] {
  return value.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="ranking-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Spinner() {
  return <span className="button-spinner" aria-hidden="true" />;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function statusLabel(status: TemplateAnalysisStatus) {
  const labels: Record<TemplateAnalysisStatus, string> = {
    pending: "未生成",
    running: "生成中",
    completed: "已完成",
    failed_retryable: "可重试失败",
    failed: "失败",
  };
  return labels[status];
}

function generationLabel(templateId: string, templates: ResearchTemplate[]) {
  if (templateId === FULL_ANALYSIS_TEMPLATE_ID) return "全部模板全面分析";
  return templates.find((template) => template.id === templateId)?.shortTitle || "模板报告";
}

function normalizeTemplateDrafts(templates: ResearchTemplate[]) {
  return templates.map((template, index) => ({
    ...template,
    title: template.title.trim(),
    shortTitle: template.shortTitle.trim() || template.title.trim().slice(0, 12) || "模板",
    focus: template.focus.trim(),
    prompt: template.prompt.trim(),
    fullPrompt: template.fullPrompt.trim(),
    sectionRequirements: template.sectionRequirements,
    enabled: template.enabled !== false,
    sortOrder: index + 1,
  }));
}

function companyLogoText(company: CompanyCandidate) {
  const trimmed = company.name.trim();
  if (/^[A-Za-z0-9 .-]+$/.test(trimmed)) {
    return trimmed
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }
  return trimmed.replace(/[A-Za-z0-9（）() ]/g, "").slice(0, 1) || company.code.slice(0, 2);
}

function companyLogoColor(company: CompanyCandidate) {
  const palette = ["#0f766e", "#2563eb", "#7c3aed", "#b45309", "#be123c", "#15803d", "#4338ca", "#0f766e"];
  const key = `${company.name}${company.code}${company.listingPlace}`;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return palette[hash % palette.length];
}

function listItems(items: string[]) {
  return (items.length ? items : ["模型未提供，需要复核。"]).map((item, index) => <li key={`${index}:${item}`}>{item}</li>);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function mergeWatchlistItems(current: WatchlistItem[], incoming: WatchlistItem) {
  const next = current.filter((item) => item.id !== incoming.id);
  return [incoming, ...next];
}

function mergeAnalyses(current: TemplateAnalysisResult[], incoming: TemplateAnalysisResult[]) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return Array.from(byId.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
