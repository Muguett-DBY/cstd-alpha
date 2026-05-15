import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  addWatchlistItem,
  fetchCompanyNews,
  fetchTemplateAnalyses,
  fetchTemplateAnalysis,
  fetchWatchlist,
  generateTemplateAnalysis,
  removeWatchlistItem,
  searchCompanies,
} from "./api";
import type { CompanyNewsBundle, NewsItem } from "./shared/news";
import type { CompanyCandidate } from "./shared/report";
import {
  FULL_ANALYSIS_TEMPLATE_ID,
  RESEARCH_TEMPLATES,
  isRetryableTemplateStatus,
  type TemplateAnalysisResult,
  type TemplateAnalysisStatus,
  type UserSession,
  type WatchlistItem,
} from "./shared/user-research";

type MyResearchViewProps = {
  user: UserSession | null;
  selectedCompany: CompanyCandidate | null;
  onOpenCompany: (company: CompanyCandidate) => void;
};

export function MyResearchView({ user, selectedCompany, onOpenCompany }: MyResearchViewProps) {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [analyses, setAnalyses] = useState<TemplateAnalysisResult[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState("");
  const [activeAnalysis, setActiveAnalysis] = useState<TemplateAnalysisResult | null>(null);
  const [companyQuery, setCompanyQuery] = useState("");
  const [companyCandidates, setCompanyCandidates] = useState<CompanyCandidate[]>([]);
  const [searchingCompany, setSearchingCompany] = useState(false);
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

  const selectedItem = useMemo(() => items.find((item) => item.id === selectedWatchlistId) ?? items[0] ?? null, [items, selectedWatchlistId]);
  const selectedAnalyses = useMemo(() => analyses.filter((analysis) => analysis.watchlistId === selectedItem?.id), [analyses, selectedItem?.id]);
  const analysisByTemplate = useMemo(() => new Map(selectedAnalyses.map((analysis) => [analysis.templateId, analysis])), [selectedAnalyses]);

  async function addCurrentCompany() {
    if (!selectedCompany) return;
    await addCompanyToMine(selectedCompany);
  }

  async function addCompanyToMine(company: CompanyCandidate) {
    setError("");
    setNotice("");
    try {
      const item = await addWatchlistItem({ company });
      setItems((current) => mergeWatchlistItems(current, item));
      setSelectedWatchlistId(item.id);
      setActiveAnalysis(null);
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
    setError("");
    setNotice("");
    try {
      await removeWatchlistItem(item.id);
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      setAnalyses((current) => current.filter((analysis) => analysis.watchlistId !== item.id));
      if (selectedWatchlistId === item.id) {
        setSelectedWatchlistId("");
        setActiveAnalysis(null);
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
    setError("");
    setNotice("");
    try {
      if (templateId === FULL_ANALYSIS_TEMPLATE_ID) {
        await generateFullAnalysisFromClient(target, forceRefresh);
        setPhase("ready");
        return;
      }
      const result = await generateTemplateAnalysis({ watchlistId: target.id, templateId, forceRefresh }, (progress) => {
        if (progress.stage !== "heartbeat") setNotice(`${progress.label}：${progress.detail}`);
      });
      const nextAnalyses = result.analyses ?? (result.analysis ? [result.analysis] : []);
      setAnalyses((current) => mergeAnalyses(current, nextAnalyses));
      const completed = nextAnalyses.find((analysis) => analysis.status === "completed") ?? nextAnalyses[0];
      if (completed) setActiveAnalysis(completed);
      setNotice(
        templateId === FULL_ANALYSIS_TEMPLATE_ID
          ? "全面分析任务已更新：十个模板会逐项生成，已完成的模板会直接复用缓存。"
          : completed?.fromCache
            ? `已打开缓存报告：${completed.templateTitle}`
            : `已生成：${completed?.templateTitle ?? "模板报告"}`,
      );
      setPhase("ready");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "模板分析生成失败。");
    }
  }

  async function generateFullAnalysisFromClient(target: WatchlistItem, forceRefresh: boolean) {
    for (const template of RESEARCH_TEMPLATES) {
      setNotice(`全面分析进行中：正在生成 ${template.shortTitle}。已完成的模板会自动复用缓存。`);
      const partial = await generateTemplateAnalysis({ watchlistId: target.id, templateId: template.id, forceRefresh }, (progress) => {
        if (progress.stage !== "heartbeat") setNotice(`${progress.label}：${progress.detail}`);
      });
      const partialAnalyses = partial.analyses ?? (partial.analysis ? [partial.analysis] : []);
      setAnalyses((current) => mergeAnalyses(current, partialAnalyses));
      const failed = partialAnalyses.find((analysis) => analysis.status === "failed" || analysis.status === "failed_retryable");
      if (failed) {
        setActiveAnalysis(failed);
        setNotice(`全面分析暂停：${failed.templateTitle} 未完成，可稍后重试。`);
        return;
      }
    }
    setNotice("十个模板已完成，正在生成最终综合汇总。");
    const finalResult = await generateTemplateAnalysis({ watchlistId: target.id, templateId: FULL_ANALYSIS_TEMPLATE_ID, forceRefresh }, (progress) => {
      if (progress.stage !== "heartbeat") setNotice(`${progress.label}：${progress.detail}`);
    });
    const finalAnalyses = finalResult.analyses ?? (finalResult.analysis ? [finalResult.analysis] : []);
    setAnalyses((current) => mergeAnalyses(current, finalAnalyses));
    const finalAnalysis = finalAnalyses.find((analysis) => analysis.templateId === FULL_ANALYSIS_TEMPLATE_ID) ?? finalAnalyses[0];
    if (finalAnalysis) setActiveAnalysis(finalAnalysis);
    setNotice("全面分析已更新：十个专项模板和综合汇总已写入报告库。");
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

  return (
    <section className="my-workspace" aria-labelledby="my-title">
      <header className="ranking-header">
        <div>
          <p className="eyebrow">我的研究</p>
          <h2 id="my-title">自选股公司工作台</h2>
          <p className="muted">{user?.displayName || user?.username || "固定账号"} 的自选股、公司级操作台和十模板深度分析。</p>
        </div>
        <div className="ranking-summary">
          <Metric label="自选股" value={`${items.length}`} />
          <Metric label="分析任务" value={`${analyses.length}`} />
          <Metric label="当前公司" value={selectedItem?.company.name || selectedCompany?.name || "未选择"} />
          <Metric label="状态" value={phase === "generating" ? "生成中" : "就绪"} />
        </div>
      </header>

      <div className="my-actions">
        <button type="button" disabled={!selectedCompany || phase === "generating"} onClick={() => void addCurrentCompany()}>
          加入当前公司
        </button>
        <button type="button" disabled={!selectedItem || phase === "generating"} onClick={() => void generate(FULL_ANALYSIS_TEMPLATE_ID)}>
          十模板全面分析
        </button>
      </div>
      <section className="mine-search-card" aria-label="搜索并加入自选股">
        <div>
          <h3>添加自选公司</h3>
          <p className="muted">在这里直接搜索公司名或股票代码，确认上市主体后加入“我的”，不必先回到生成报告页。</p>
        </div>
        <form onSubmit={submitCompanySearch} className="mine-search-form">
          <input value={companyQuery} onChange={(event) => setCompanyQuery(event.target.value)} placeholder="例如：贵州茅台、000333、AMZN" />
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
      {notice ? <p className="cache-notice">{notice}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      <div className={`my-grid ${activeAnalysis ? "reading-mode" : ""}`}>
        {!activeAnalysis ? (
          <section className="my-list">
            <h3>我的自选股</h3>
            {items.length ? (
              items.map((item) => (
                <article key={item.id} className={item.id === selectedItem?.id ? "active" : ""}>
                  <button
                    type="button"
                    className="ranking-company"
                    onClick={() => {
                      setSelectedWatchlistId(item.id);
                      setActiveAnalysis(null);
                    }}
                  >
                    <strong>{item.company.name}</strong>
                    <small>
                      {item.company.code} / {item.company.listingPlace}
                    </small>
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
              ))
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
              phase={phase}
              onGenerate={(templateId, forceRefresh) => void generate(templateId, forceRefresh)}
              onOpenAnalysis={(analysis) => void openAnalysis(analysis)}
              onOpenBaseReport={() => onOpenCompany(selectedItem.company)}
              onBackToTemplates={() => setActiveAnalysis(null)}
            />
          ) : (
            <>
              <h3>公司工作台</h3>
              <p className="muted">选择或加入一家公司后，可以在这里生成单模板深度报告或十模板全面分析。</p>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

function CompanyWorkbench({
  item,
  analysisByTemplate,
  activeAnalysis,
  phase,
  onGenerate,
  onOpenAnalysis,
  onOpenBaseReport,
  onBackToTemplates,
}: {
  item: WatchlistItem;
  analysisByTemplate: Map<string, TemplateAnalysisResult>;
  activeAnalysis: TemplateAnalysisResult | null;
  phase: "loading" | "ready" | "generating" | "error";
  onGenerate: (templateId: string, forceRefresh?: boolean) => void;
  onOpenAnalysis: (analysis: TemplateAnalysisResult) => void;
  onOpenBaseReport: () => void;
  onBackToTemplates: () => void;
}) {
  const fullAnalysis = analysisByTemplate.get(FULL_ANALYSIS_TEMPLATE_ID);
  if (activeAnalysis) {
    return <TemplateReportReader analysis={activeAnalysis} onBack={onBackToTemplates} />;
  }
  return (
    <>
      <div className="company-workbench-header">
        <div>
          <p className="eyebrow">公司工作台</p>
          <h3>{item.company.name}</h3>
          <p className="muted">
            {item.company.code} / {item.company.listingPlace} / {item.company.exchange}
          </p>
          <p className="muted">十模板分析会独立读取公开公司证据并按完整模板生成；全面分析会先跑完十个专项模板，再做交叉整合。</p>
        </div>
        <button type="button" className="secondary-button" onClick={onOpenBaseReport}>
          打开基础深度报告
        </button>
      </div>

      <NewsRadar key={item.id} item={item} />

      <section className="template-grid" aria-label="十模板深度分析">
        <TemplateCard
          title="十模板全面分析"
          focus="先生成十个专项深度报告，再汇总成最终全面分析。"
          analysis={fullAnalysis}
          disabled={phase === "generating"}
          onGenerate={() => onGenerate(FULL_ANALYSIS_TEMPLATE_ID)}
          onRegenerate={() => onGenerate(FULL_ANALYSIS_TEMPLATE_ID, true)}
          onOpen={onOpenAnalysis}
        />
        {RESEARCH_TEMPLATES.map((template) => (
          <TemplateCard
            key={template.id}
            title={template.title}
            focus={template.focus}
            analysis={analysisByTemplate.get(template.id)}
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
  disabled,
  onGenerate,
  onRegenerate,
  onOpen,
}: {
  title: string;
  focus: string;
  analysis?: TemplateAnalysisResult;
  disabled: boolean;
  onGenerate: () => void;
  onRegenerate: () => void;
  onOpen: (analysis: TemplateAnalysisResult) => void;
}) {
  const status = analysis?.status ?? "pending";
  return (
    <article className={`template-card status-${status}`}>
      <div>
        <strong>{title}</strong>
        <span>{statusLabel(status)}</span>
      </div>
      <p>{analysis?.summary || focus}</p>
      {analysis?.fromCache ? <small>来自已生成缓存</small> : null}
      <footer>
        {analysis?.status === "completed" ? (
          <button type="button" className="secondary-button" onClick={() => onOpen(analysis)}>
            查看
          </button>
        ) : null}
        <button type="button" disabled={disabled} onClick={analysis ? onRegenerate : onGenerate}>
          {analysis && (analysis.status === "completed" || isRetryableTemplateStatus(analysis.status)) ? "重新生成" : "生成"}
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
          返回十模板
        </button>
      </header>
      <div className="dashboard-grid">
        <Info label="模板" value={analysis.templateTitle} />
        <Info label="模型" value={analysis.model} />
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
                : "尚未读取新闻，点击“刷新新闻”后再请求公开新闻源。"}
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
      <small>样本 {summary.total} 条，按标题与摘要关键词自动归类。</small>
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
  return `cstd-news-cache:v2:${company.marketType || ""}:${company.listingPlace || ""}:${company.code || company.name}`;
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
                .map((line) => (
                  <li key={line}>{line}</li>
                ))}
            </ul>
          );
        }
        return <p key={index}>{renderInline(block)}</p>;
      })}
    </div>
  );
}

function normalizeMarkdownForReading(markdown: string) {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/\s+(?=\d{1,2}\.\s+)/g, "\n\n")
    .replace(/\s+(估值与仓位规则|待复核清单|总结)\b/g, "\n\n## $1")
    .replace(/\s+(?=\*\*反证条件：\*\*)/g, "\n")
    .replace(/\s+(?=\*\*待复核：\*\*)/g, "\n")
    .trim();
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

function listItems(items: string[]) {
  return (items.length ? items : ["模型未提供，需要复核。"]).map((item) => <li key={item}>{item}</li>);
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
