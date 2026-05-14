import { useEffect, useMemo, useState } from "react";
import { addWatchlistItem, fetchTemplateAnalyses, fetchWatchlist, generateTemplateAnalysis, removeWatchlistItem } from "./api";
import type { CompanyCandidate } from "./shared/report";
import { FULL_ANALYSIS_TEMPLATE_ID, RESEARCH_TEMPLATES, type TemplateAnalysisResult, type UserSession, type WatchlistItem } from "./shared/user-research";

type MyResearchViewProps = {
  user: UserSession | null;
  selectedCompany: CompanyCandidate | null;
  onOpenCompany: (company: CompanyCandidate) => void;
};

export function MyResearchView({ user, selectedCompany, onOpenCompany }: MyResearchViewProps) {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [analyses, setAnalyses] = useState<TemplateAnalysisResult[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState(FULL_ANALYSIS_TEMPLATE_ID);
  const [phase, setPhase] = useState<"loading" | "ready" | "generating" | "error">("loading");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchWatchlist(), fetchTemplateAnalyses()])
      .then(([watchlist, analysisData]) => {
        if (cancelled) return;
        setItems(watchlist.items);
        setAnalyses(analysisData.analyses);
        setSelectedWatchlistId((current) => current || watchlist.items[0]?.id || "");
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
  }, []);

  const selectedItem = useMemo(() => items.find((item) => item.id === selectedWatchlistId) ?? items[0], [items, selectedWatchlistId]);
  const selectedAnalyses = useMemo(() => analyses.filter((analysis) => analysis.watchlistId === selectedItem?.id), [analyses, selectedItem?.id]);
  const latestAnalysis = selectedAnalyses[0];

  async function addCurrentCompany() {
    if (!selectedCompany) return;
    setError("");
    setNotice("");
    try {
      const item = await addWatchlistItem({ company: selectedCompany });
      setItems((current) => mergeWatchlistItems(current, item));
      setSelectedWatchlistId(item.id);
      setNotice(`已加入自选：${item.company.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加入自选失败。");
    }
  }

  async function deleteItem(item: WatchlistItem) {
    setError("");
    setNotice("");
    try {
      await removeWatchlistItem(item.id);
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      setAnalyses((current) => current.filter((analysis) => analysis.watchlistId !== item.id));
      if (selectedWatchlistId === item.id) setSelectedWatchlistId("");
      setNotice(`已移除：${item.company.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除自选失败。");
    }
  }

  async function generate() {
    const target = selectedItem;
    if (!target) return;
    setPhase("generating");
    setError("");
    setNotice("");
    try {
      const analysis = await generateTemplateAnalysis({ watchlistId: target.id, templateId: selectedTemplateId });
      setAnalyses((current) => [analysis, ...current.filter((item) => item.id !== analysis.id)]);
      setNotice(`已生成：${analysis.templateTitle}`);
      setPhase("ready");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "模板分析生成失败。");
    }
  }

  return (
    <section className="my-workspace" aria-labelledby="my-title">
      <header className="ranking-header">
        <div>
          <p className="eyebrow">我的研究</p>
          <h2 id="my-title">自选股与多模板分析</h2>
          <p className="muted">{user?.username || "默认用户"} 的自选股、专项模板分析和十模板全面分析。</p>
        </div>
        <div className="ranking-summary">
          <Metric label="自选股" value={`${items.length}`} />
          <Metric label="分析数" value={`${analyses.length}`} />
          <Metric label="当前公司" value={selectedCompany?.name || "未选择"} />
          <Metric label="状态" value={phase === "generating" ? "生成中" : "就绪"} />
        </div>
      </header>

      <div className="my-actions">
        <button type="button" disabled={!selectedCompany || phase === "generating"} onClick={() => void addCurrentCompany()}>
          加入当前公司
        </button>
        <select value={selectedWatchlistId} onChange={(event) => setSelectedWatchlistId(event.target.value)} aria-label="选择自选股">
          {items.length ? (
            items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.company.name} / {item.company.code}
              </option>
            ))
          ) : (
            <option value="">暂无自选股</option>
          )}
        </select>
        <select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)} aria-label="选择模板">
          <option value={FULL_ANALYSIS_TEMPLATE_ID}>十模板全面分析</option>
          {RESEARCH_TEMPLATES.map((template) => (
            <option key={template.id} value={template.id}>
              {template.shortTitle}
            </option>
          ))}
        </select>
        <button type="button" disabled={!selectedItem || phase === "generating"} onClick={() => void generate()}>
          {phase === "generating" ? "正在分析..." : "生成模板分析"}
        </button>
      </div>
      {notice ? <p className="cache-notice">{notice}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      <div className="my-grid">
        <section className="my-list">
          <h3>我的自选股</h3>
          {items.length ? (
            items.map((item) => (
              <article key={item.id} className={item.id === selectedItem?.id ? "active" : ""}>
                <button type="button" className="ranking-company" onClick={() => setSelectedWatchlistId(item.id)}>
                  <strong>{item.company.name}</strong>
                  <small>
                    {item.company.code} / {item.company.listingPlace}
                  </small>
                </button>
                <div>
                  <button type="button" className="secondary-button" onClick={() => onOpenCompany(item.company)}>
                    打开
                  </button>
                  <button type="button" className="ghost-button" onClick={() => void deleteItem(item)}>
                    移除
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p className="muted">先在报告页或排行榜打开一家公司，再加入当前公司。</p>
          )}
        </section>

        <section className="analysis-panel">
          <h3>{latestAnalysis ? latestAnalysis.title : "模板分析"}</h3>
          {latestAnalysis ? (
            <AnalysisResultView analysis={latestAnalysis} />
          ) : (
            <p className="muted">选择自选股和模板后生成分析。单模板用于专项判断，十模板全面分析会把十个框架合并为一份更完整的报告。</p>
          )}
        </section>
      </div>
    </section>
  );
}

function AnalysisResultView({ analysis }: { analysis: TemplateAnalysisResult }) {
  return (
    <div className="analysis-result">
      <div className="dashboard-grid">
        <Info label="模板" value={analysis.templateTitle} />
        <Info label="模型" value={analysis.model} />
        <Info label="评分" value={analysis.score === undefined ? "待验证" : analysis.score.toFixed(1)} />
        <Info label="结论" value={analysis.verdict} />
      </div>
      <p>{analysis.summary}</p>
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
      {analysis.sections.map((section) => (
        <section key={section.heading} className="report-section">
          <h3>{section.heading}</h3>
          <p>{section.body}</p>
        </section>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="ranking-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function listItems(items: string[]) {
  return (items.length ? items : ["模型未提供，需要复核。"]).map((item) => <li key={item}>{item}</li>);
}

function mergeWatchlistItems(current: WatchlistItem[], incoming: WatchlistItem) {
  const next = current.filter((item) => item.id !== incoming.id);
  return [incoming, ...next];
}
