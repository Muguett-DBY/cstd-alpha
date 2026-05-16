import { useEffect, useRef, useState } from "react";
import { checkSession, fetchChartData, fetchReportLibraryRecord, generateReport, login, logout, searchCompanies, type ReportProgress } from "./api";
import "./App.css";
import { RankingView, type RankingMarket } from "./RankingView";
import { MyResearchView } from "./MyResearchView";
import { clearLocalReportStorage, loadCachedChart, loadCachedReport, loadLastReportEntry, saveCachedChart, saveCachedReport, saveLastReport } from "./storage";
import { clearImportedRankingReports } from "./ranking-storage";
import { extractFinancialChartSeries, extractModuleScoreSeries, type ChartBundle, type ChartSeries, type PriceMode } from "./shared/chart";
import { companyCandidateFromRanking, type RankingEntry } from "./shared/ranking";
import type { CompanyCandidate, InvestmentReport, ModuleScore, ReportGenerationMetrics, ScoreItem } from "./shared/report";
import type { UserSession } from "./shared/user-research";

type Phase = "idle" | "searching" | "selecting" | "generating" | "ready" | "error";
type ChartPhase = "idle" | "loading" | "ready" | "error";
type AppView = "report" | "ranking" | "mine";

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<UserSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<CompanyCandidate[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<CompanyCandidate | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ReportProgress[]>([]);
  const [evidenceCount, setEvidenceCount] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const [initialReportEntry] = useState(() => loadLastReportEntry());
  const [report, setReport] = useState<InvestmentReport | null>(() => initialReportEntry?.report ?? null);
  const [reportMetrics, setReportMetrics] = useState<ReportGenerationMetrics | null>(() => initialReportEntry?.metrics ?? null);
  const [chartBundle, setChartBundle] = useState<ChartBundle | null>(null);
  const [chartPhase, setChartPhase] = useState<ChartPhase>("idle");
  const [chartError, setChartError] = useState("");
  const [priceMode, setPriceMode] = useState<PriceMode>("adjusted");
  const [cacheNotice, setCacheNotice] = useState("");
  const [reportAbortController, setReportAbortController] = useState<AbortController | null>(null);
  const [activeView, setActiveView] = useState<AppView>("report");
  const [rankingMarket, setRankingMarket] = useState<RankingMarket>("a-share");
  const selectedCompanyRef = useRef<CompanyCandidate | null>(selectedCompany);

  useEffect(() => {
    void checkSession()
      .then((session) => {
        setUser(session);
        setAuthenticated(Boolean(session));
      })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  useEffect(() => {
    selectedCompanyRef.current = selectedCompany;
  }, [selectedCompany]);

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const session = await login(password, username);
      setUser(session);
      setAuthenticated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败。");
    }
  }

  async function submitLogout() {
    await logout();
    setAuthenticated(false);
    setUser(null);
    setPassword("");
    setSelectedCompany(null);
    setReport(null);
    setReportMetrics(null);
    setChartBundle(null);
    setProgress([]);
    setCacheNotice("");
    clearLocalReportStorage();
    clearImportedRankingReports();
  }

  async function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setError("");
    setCacheNotice("");
    setChartError("");
    setPhase("searching");
    setSelectedCompany(null);
    setChartBundle(null);
    try {
      const nextCandidates = await searchCompanies(query.trim());
      setCandidates(nextCandidates);
      setPhase("selecting");
      if (nextCandidates.length === 0) setError("没有找到候选公司，请尝试输入股票代码或更完整的公司名。");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "公司搜索失败。");
    }
  }

  async function submitReport(forceRefresh = false) {
    if (!selectedCompany) {
      setError("请先从候选列表中选择具体公司。");
      setPhase("selecting");
      return;
    }
    const requestCompany = selectedCompany;

    setError("");
    setCacheNotice("");
    setProgress([]);
    setEvidenceCount(0);
    setReport(null);
    setReportMetrics(null);

    if (!forceRefresh) {
      const cached = loadCachedReport(selectedCompany);
      if (cached) {
        setReport(cached.report);
        setReportMetrics(cached.metrics ?? null);
        saveLastReport(cached.report, cached.metrics);
        setEvidenceCount(cached.report.evidence.length);
        setProgress([
          {
            type: "progress",
            stage: "cache_hit",
            label: "使用本地缓存",
            detail: `已复用 ${formatCacheTime(cached.cachedAt)} 生成的报告，可点击“刷新最新数据”重新生成。`,
            percent: 100,
            at: new Date().toISOString(),
            evidenceCount: cached.report.evidence.length,
          },
        ]);
        setPhase("ready");
        setCacheNotice(`正在显示 ${formatCacheTime(cached.cachedAt)} 的缓存报告。`);
        return;
      }
    }

    setStartedAt(Date.now());
    setPhase("generating");
    const controller = new AbortController();
    setReportAbortController(controller);

    try {
      const result = await generateReport({ company: requestCompany, forceRefresh, cacheMode: forceRefresh ? "refresh" : "prefer-cache", signal: controller.signal }, (item) => {
        if (!isSameCompany(selectedCompanyRef.current, requestCompany)) return;
        if (typeof item.evidenceCount === "number") setEvidenceCount(item.evidenceCount);
        setProgress((current) => [...current.slice(-12), item]);
      });
      if (!isSameCompany(selectedCompanyRef.current, requestCompany)) {
        setPhase("idle");
        return;
      }
      const nextReport = result.report;
      setReport(nextReport);
      setReportMetrics(result.metrics ?? null);
      const savedLastReport = saveLastReport(nextReport, result.metrics);
      const savedReportCache = saveCachedReport(requestCompany, nextReport, Date.now(), result.metrics);
      if (!savedLastReport || !savedReportCache) setCacheNotice("报告已生成；浏览器本地缓存写入失败，不影响服务端报告。");
      setPhase("ready");
    } catch (err) {
      if (isReportCancelled(err)) {
        setPhase("idle");
        setError("已停止等待，后台仍会继续生成；稍后再次点击生成会自动复用共享缓存。");
      } else {
        setPhase("error");
        setError(err instanceof Error ? err.message : "报告生成失败。");
      }
    } finally {
      setStartedAt(null);
      setReportAbortController(null);
    }
  }

  async function submitChart(nextPriceMode = priceMode, forceRefresh = false) {
    if (!selectedCompany) {
      setChartError("请先从候选列表中选择具体公司。");
      setPhase("selecting");
      return;
    }
    const requestCompany = selectedCompany;

    setChartError("");
    setPriceMode(nextPriceMode);
    if (!forceRefresh) {
      const cached = loadCachedChart(requestCompany, nextPriceMode);
      if (cached) {
        if (!isSameCompany(selectedCompanyRef.current, requestCompany)) {
          setChartPhase("idle");
          return;
        }
        setChartBundle(cached.chart);
        setChartPhase("ready");
        return;
      }
    }
    setChartPhase("loading");
    try {
      const bundle = await fetchChartData({ company: requestCompany, priceMode: nextPriceMode });
      if (!isSameCompany(selectedCompanyRef.current, requestCompany)) {
        setChartPhase("idle");
        return;
      }
      setChartBundle(bundle);
      if (!saveCachedChart(requestCompany, nextPriceMode, bundle)) setChartError("图表已生成；浏览器本地缓存写入失败。");
      setChartPhase("ready");
    } catch (err) {
      setChartPhase("error");
      setChartError(err instanceof Error ? err.message : "图表数据生成失败。");
    }
  }

  async function openRankingEntry(entry: RankingEntry) {
    const company = companyCandidateFromRanking(entry);
    setSelectedCompany(company);
    setQuery(entry.name);
    setChartBundle(null);
    setChartError("");
    setActiveView("report");
    if (entry.report) {
      setReport(entry.report);
      setReportMetrics(null);
      saveLastReport(entry.report);
      setEvidenceCount(entry.report.evidence.length);
      setProgress([
        {
          type: "progress",
          stage: "imported_report",
          label: "导入报告",
          detail: "已打开排行榜中的深度报告。",
          percent: 100,
          at: new Date().toISOString(),
          evidenceCount: entry.report.evidence.length,
        },
      ]);
      setPhase("ready");
      setCacheNotice("正在显示排行榜导入报告。");
      return;
    }
    if (entry.libraryId) {
      setPhase("generating");
      setProgress([
        {
          type: "progress",
          stage: "report_library",
          label: "读取报告库",
          detail: "正在从服务端报告库读取完整深度报告。",
          percent: 70,
          at: new Date().toISOString(),
        },
      ]);
      try {
        const record = await fetchReportLibraryRecord(entry.libraryId);
        setReport(record.report);
        setReportMetrics(null);
        saveLastReport(record.report);
        setEvidenceCount(record.report.evidence.length);
        setProgress([
          {
            type: "progress",
            stage: "report_library_hit",
            label: "命中报告库",
            detail: "已从服务端报告库打开完整深度报告。",
            percent: 100,
            at: new Date().toISOString(),
            evidenceCount: record.report.evidence.length,
          },
        ]);
        setPhase("ready");
        setCacheNotice("正在显示服务端报告库中的深度报告。");
      } catch (err) {
        setReport(null);
        setReportMetrics(null);
        setPhase("error");
        setError(err instanceof Error ? err.message : "报告库读取失败。");
      }
      return;
    }
    setReport(null);
    setReportMetrics(null);
    setProgress([]);
    setEvidenceCount(0);
    setPhase("idle");
    setCacheNotice("已从排行榜选择公司，可生成完整评分报告或导入深度报告 JSON。");
  }

  function openCompanyFromMine(company: CompanyCandidate) {
    setSelectedCompany(company);
    setQuery(company.name);
    setChartBundle(null);
    setChartError("");
    setReport(null);
    setReportMetrics(null);
    setProgress([]);
    setEvidenceCount(0);
    setPhase("idle");
    setActiveView("report");
    setCacheNotice("已从我的自选股打开公司，可生成或查看完整评分报告。");
  }

  if (checking) return <div className="loading-screen">CSTD Alpha</div>;

  if (!authenticated) {
    return (
      <main className="auth-page">
        <section className="auth-panel" aria-labelledby="auth-title">
          <p className="brand">CSTD Alpha</p>
          <h1 id="auth-title">私人公司深度研究工具</h1>
          <form onSubmit={submitLogin} className="auth-form">
            <label htmlFor="username">账号</label>
            <input
              id="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="请输入预设账号"
              required
            />
            <label htmlFor="password">访问密码</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
            <button type="submit">进入</button>
          </form>
          {error ? <p className="error-text">{error}</p> : null}
        </section>
      </main>
    );
  }

  const elapsedSeconds = startedAt ? Math.floor((now - startedAt) / 1000) : 0;

  return (
    <main className="app-shell">
      <aside className="input-rail">
        <div>
          <p className="brand">CSTD Alpha</p>
          <h1>中文深度评分报告</h1>
          <p className="rail-copy">先确认上市主体，再生成完整模板报告，避免同名公司或错误代码。</p>
          <p className="muted">当前账号：{user?.displayName || user?.username}</p>
          <button type="button" className="ghost-button" onClick={() => void submitLogout()}>
            退出登录
          </button>
        </div>

        <nav className="view-tabs" aria-label="工作区">
          <button type="button" className={activeView === "report" ? "active" : ""} aria-current={activeView === "report" ? "page" : undefined} onClick={() => setActiveView("report")}>
            生成报告
          </button>
          <button
            type="button"
            className={activeView === "ranking" && rankingMarket === "a-share" ? "active" : ""}
            aria-current={activeView === "ranking" && rankingMarket === "a-share" ? "page" : undefined}
            onClick={() => {
              setRankingMarket("a-share");
              setActiveView("ranking");
            }}
          >
            A 股排行
          </button>
          <button
            type="button"
            className={activeView === "ranking" && rankingMarket === "us" ? "active" : ""}
            aria-current={activeView === "ranking" && rankingMarket === "us" ? "page" : undefined}
            onClick={() => {
              setRankingMarket("us");
              setActiveView("ranking");
            }}
          >
            美股排行
          </button>
          <button
            type="button"
            className={activeView === "ranking" && rankingMarket === "hk" ? "active" : ""}
            aria-current={activeView === "ranking" && rankingMarket === "hk" ? "page" : undefined}
            onClick={() => {
              setRankingMarket("hk");
              setActiveView("ranking");
            }}
          >
            港股排行
          </button>
          <button type="button" className={activeView === "mine" ? "active" : ""} aria-current={activeView === "mine" ? "page" : undefined} onClick={() => setActiveView("mine")}>
            我的
          </button>
        </nav>

        <form onSubmit={submitSearch} className="report-form">
          <label htmlFor="companyQuery">公司名或股票代码</label>
          <input
            id="companyQuery"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedCompany(null);
            }}
            placeholder="例如：万科A、苹果、腾讯、贵州茅台"
            required
          />
          <button type="submit" disabled={phase === "searching" || phase === "generating"}>
            {phase === "searching" ? "正在搜索..." : "搜索并选择公司"}
          </button>
        </form>

        {selectedCompany ? (
          <section className="selected-company">
            <span>已选择</span>
            <strong>{selectedCompany.name}</strong>
            <p>
              {selectedCompany.code} / {selectedCompany.listingPlace} / {displayExchange(selectedCompany)}
            </p>
            <button type="button" onClick={() => setPhase("selecting")}>
              重新选择
            </button>
          </section>
        ) : null}

        <button className="generate-button" type="button" disabled={!selectedCompany || phase === "generating"} onClick={() => void submitReport(false)}>
          {phase === "generating" ? "正在生成深度报告..." : "生成完整评分报告"}
        </button>
        <button className="secondary-button refresh-button" type="button" disabled={!selectedCompany || phase === "generating"} onClick={() => void submitReport(true)}>
          刷新最新数据
        </button>
        {phase === "generating" ? (
          <button className="secondary-button cancel-button" type="button" onClick={() => reportAbortController?.abort()}>
            停止等待
          </button>
        ) : null}
        {cacheNotice ? <p className="cache-notice">{cacheNotice}</p> : null}

        <section className="chart-controls">
          <span>股价口径</span>
          <div className="segmented-control" role="group" aria-label="股价口径">
            <button type="button" className={priceMode === "adjusted" ? "active" : ""} disabled={chartPhase === "loading"} onClick={() => void submitChart("adjusted")}>
              前复权
            </button>
            <button type="button" className={priceMode === "raw" ? "active" : ""} disabled={chartPhase === "loading"} onClick={() => void submitChart("raw")}>
              原始价
            </button>
          </div>
          <button className="secondary-button" type="button" disabled={!selectedCompany || chartPhase === "loading"} onClick={() => void submitChart()}>
            {chartPhase === "loading" ? "正在生成图表..." : "生成图表"}
          </button>
          <button className="secondary-button" type="button" disabled={!selectedCompany || chartPhase === "loading"} onClick={() => void submitChart(priceMode, true)}>
            刷新图表数据
          </button>
          {chartError ? <p className="error-text">{chartError}</p> : null}
        </section>

        <ProgressPanel
          progress={progress}
          phase={phase}
          elapsedSeconds={elapsedSeconds}
          completedElapsedMs={reportMetrics?.elapsedMs}
          evidenceCount={evidenceCount || report?.evidence.length || 0}
        />
        {error ? <p className="error-text">{error}</p> : null}
      </aside>

      <section className="workspace">
        {activeView === "ranking" ? (
          <RankingView market={rankingMarket} onOpenEntry={openRankingEntry} />
        ) : activeView === "mine" ? (
          <MyResearchView user={user} selectedCompany={selectedCompany} onOpenCompany={openCompanyFromMine} />
        ) : (
          <>
            {chartBundle || chartPhase === "loading" || chartPhase === "error" ? (
              <ChartDashboard chartBundle={chartBundle} chartPhase={chartPhase} report={report} priceMode={priceMode} />
            ) : null}
            {report ? <ReportView report={report} metrics={reportMetrics ?? undefined} /> : <EmptyState />}
          </>
        )}
      </section>

      {phase === "selecting" && candidates.length > 0 ? (
        <CandidateModal
          candidates={candidates}
          onClose={() => setPhase("idle")}
          onSelect={(candidate) => {
            setSelectedCompany(candidate);
            setPhase("idle");
          }}
        />
      ) : null}
    </main>
  );
}

function CandidateModal({
  candidates,
  onSelect,
  onClose,
}: {
  candidates: CompanyCandidate[];
  onSelect: (candidate: CompanyCandidate) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="candidate-modal" role="dialog" aria-modal="true" aria-labelledby="candidate-title">
        <header>
          <div>
            <p className="brand">确认上市主体</p>
            <h2 id="candidate-title">请选择你要分析的公司</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="candidate-list">
          {candidates.map((candidate) => (
            <button key={candidate.id} type="button" className="candidate-row" onClick={() => onSelect(candidate)}>
              <strong>{candidate.name}</strong>
              <span>{candidate.code}</span>
              <span>{candidate.listingPlace}</span>
              <small>{displayExchange(candidate)}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function displayExchange(candidate: CompanyCandidate) {
  if (!candidate.exchange || /^\d+$/.test(candidate.exchange)) return candidate.source === "eastmoney" ? "东方财富" : "Yahoo";
  return candidate.exchange;
}

function isReportCancelled(error: unknown) {
  return error instanceof Error && error.message === "已停止等待，后台仍会继续生成。";
}

function ProgressPanel({
  progress,
  phase,
  elapsedSeconds,
  completedElapsedMs,
  evidenceCount,
}: {
  progress: ReportProgress[];
  phase: Phase;
  elapsedSeconds: number;
  completedElapsedMs?: number;
  evidenceCount: number;
}) {
  const latest = progress.at(-1);
  const statusText =
    phase === "generating"
      ? formatDuration(elapsedSeconds * 1000)
      : phase === "ready"
        ? completedElapsedMs !== undefined
          ? `完成 / ${formatDuration(completedElapsedMs)}`
          : "完成"
        : phase === "error"
          ? "失败"
          : "待开始";
  return (
    <section className="progress-panel">
      <div className="progress-head">
        <span>生成状态</span>
        <strong>{statusText}</strong>
      </div>
      <meter min="0" max="100" value={latest?.percent ?? (phase === "ready" ? 100 : 0)} />
      <p>{latest ? `${latest.label}：${latest.detail}` : "选择公司后开始读取公开数据并生成报告。"}</p>
      {completedElapsedMs !== undefined ? <small>生成耗时：{formatDuration(completedElapsedMs)}</small> : null}
      <small>当前证据数量：{evidenceCount}</small>
      <ol>
        {progress.map((item, index) => (
          <li key={`${item.stage}-${item.at}-${index}`}>
            <span>{item.percent}%</span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChartDashboard({
  chartBundle,
  chartPhase,
  report,
  priceMode,
}: {
  chartBundle: ChartBundle | null;
  chartPhase: ChartPhase;
  report: InvestmentReport | null;
  priceMode: PriceMode;
}) {
  const priceSeries = chartBundle?.priceSeries.map((point) => ({ label: point.date, value: point.close })) ?? [];
  const drawdownSeries = chartBundle?.drawdownSeries.map((point) => ({ label: point.date, value: point.drawdown })) ?? [];
  const financialSeries = report ? extractFinancialChartSeries(report) : [];
  const moduleScores = report ? extractModuleScoreSeries(report) : [];
  const hasPriceData = priceSeries.length > 0;

  return (
    <section className="chart-dashboard">
      <header>
        <div>
          <p className="eyebrow">图表驾驶舱</p>
          <h2>{chartBundle?.company.name ?? "正在准备图表"}</h2>
          <p className="muted">
            {priceMode === "adjusted" ? "前复权/调整价" : "原始收盘价"}口径
            {chartBundle?.marketSnapshot.latestDate ? ` / 最新数据 ${chartBundle.marketSnapshot.latestDate}` : ""}
          </p>
        </div>
        <div className="chart-metrics">
          <InfoTile title="最新价格" value={formatMetric(chartBundle?.marketSnapshot.currentPrice)} />
          <InfoTile title="最大回撤" value={formatPercent(chartBundle?.marketSnapshot.maxDrawdown)} />
          <InfoTile title="数据点" value={chartBundle ? `${chartBundle.priceSeries.length} 个` : chartPhase === "loading" ? "读取中" : "待生成"} />
        </div>
      </header>

      {chartPhase === "loading" ? <p className="chart-placeholder">正在读取公开历史行情并计算回撤...</p> : null}
      {chartPhase === "error" && !chartBundle ? <p className="chart-placeholder">图表数据生成失败，请稍后重试。</p> : null}

      <div className="chart-grid">
        <ChartCard title="十年股价走势" empty={!hasPriceData} emptyText="公开历史价格数据不足，无法绘制股价图。">
          <LineChart series={priceSeries} stroke="#255f54" />
        </ChartCard>
        <ChartCard title="最大回撤曲线" empty={!drawdownSeries.length} emptyText="价格序列不足，无法计算回撤。">
          <LineChart series={drawdownSeries} stroke="#b3432f" suffix="%" />
        </ChartCard>
        <ChartCard title="财务趋势" empty={!financialSeries.length} emptyText="生成完整评分报告后，会从十年财务表提取收入、利润、现金流和负债率。">
          <FinancialMiniCharts series={financialSeries} />
        </ChartCard>
        <ChartCard title="估值安全边际" empty={!report} emptyText="生成完整评分报告后，会显示当前价格与合理价值、买入区间、减仓区间的关系。">
          {report ? <ValuationRange report={report} currentPrice={chartBundle?.marketSnapshot.currentPrice} /> : null}
        </ChartCard>
        <ChartCard title="10 大模块评分" empty={!moduleScores.length} emptyText="生成完整评分报告后，会显示 10 大模块评分。">
          <ScoreBarChart series={moduleScores} />
        </ChartCard>
      </div>

      {chartBundle?.evidence.length ? (
        <div className="chart-evidence">
          {chartBundle.evidence.map((item) => (
            <a key={`${item.title}-${item.url}`} href={item.url || undefined} target="_blank" rel="noreferrer">
              {item.title} / {item.freshness}
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ChartCard({ title, empty, emptyText, children }: { title: string; empty: boolean; emptyText: string; children: React.ReactNode }) {
  return (
    <section className="chart-card">
      <h3>{title}</h3>
      {empty ? <p className="chart-placeholder">{emptyText}</p> : children}
    </section>
  );
}

function LineChart({ series, stroke, suffix = "" }: { series: Array<{ label: string; value: number }>; stroke: string; suffix?: string }) {
  const width = 640;
  const height = 220;
  const padding = { top: 18, right: 18, bottom: 32, left: 48 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = series.map((point) => point.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const range = max - min || 1;
  const points = series.map((point, index) => {
    const x = padding.left + (series.length === 1 ? plotWidth : (index / (series.length - 1)) * plotWidth);
    const y = padding.top + plotHeight - ((point.value - min) / range) * plotHeight;
    return `${x},${y}`;
  });
  const first = series[0];
  const last = series.at(-1);

  return (
    <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img">
      <line x1={padding.left} y1={padding.top + plotHeight} x2={width - padding.right} y2={padding.top + plotHeight} />
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + plotHeight} />
      <polyline points={points.join(" ")} fill="none" stroke={stroke} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <text x={padding.left} y={padding.top - 6}>{formatMetric(max, suffix)}</text>
      <text x={padding.left} y={padding.top + plotHeight + 18}>{formatMetric(min, suffix)}</text>
      {first ? <text x={padding.left} y={height - 8}>{first.label}</text> : null}
      {last ? <text x={width - padding.right - 90} y={height - 8}>{last.label}</text> : null}
    </svg>
  );
}

function FinancialMiniCharts({ series }: { series: ChartSeries[] }) {
  return (
    <div className="financial-mini-grid">
      {series.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <LineChart series={item.points} stroke={item.label.includes("负债") ? "#b3432f" : "#255f54"} />
        </div>
      ))}
    </div>
  );
}

function ScoreBarChart({ series }: { series: Array<{ label: string; value: number }> }) {
  return (
    <div className="score-bars">
      {series.map((item) => (
        <div key={item.label} className="score-bar-row">
          <span>{item.label}</span>
          <div>
            <i style={{ width: `${Math.max(2, Math.min(100, item.value))}%` }} />
          </div>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function ValuationRange({ report, currentPrice }: { report: InvestmentReport; currentPrice?: number }) {
  const current = currentPrice ?? parseNumbers(report.valuationAnalysis.currentPrice)[0];
  const fair = parseNumbers(report.valuationAnalysis.fairValueRange);
  const buy = parseNumbers(report.valuationAnalysis.buyRange);
  const sell = parseNumbers(report.valuationAnalysis.sellReduceRange);
  const values = [current, ...fair, ...buy, ...sell].filter((value): value is number => value !== undefined);
  if (!values.length) return <p className="chart-placeholder">估值区间无法解析为图形，保留文字判断：{report.valuationAnalysis.conclusion}</p>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const position = (value: number) => ((value - min) / span) * 100;
  const buyLow = buy.length >= 2 ? Math.min(...buy) : min;
  const buyHigh = buy.length >= 2 ? Math.max(...buy) : buy[0];
  const fairLow = fair.length >= 2 ? Math.min(...fair) : undefined;
  const fairHigh = fair.length >= 2 ? Math.max(...fair) : undefined;
  return (
    <div className="valuation-range">
      <div className="range-track">
        {buyHigh !== undefined ? <span className="buy-range" style={{ left: `${position(buyLow)}%`, width: `${Math.max(2, position(buyHigh) - position(buyLow))}%` }} /> : null}
        {fairLow !== undefined && fairHigh !== undefined ? <span className="fair-range" style={{ left: `${position(fairLow)}%`, width: `${Math.max(2, position(fairHigh) - position(fairLow))}%` }} /> : null}
        {sell[0] !== undefined ? <span className="sell-marker" style={{ left: `${position(sell[0])}%` }} /> : null}
        {current !== undefined ? <span className="current-marker" style={{ left: `${position(current)}%` }} /> : null}
      </div>
      <div className="range-labels">
        <span>低估/买入：{report.valuationAnalysis.buyRange}</span>
        <span>合理：{report.valuationAnalysis.fairValueRange}</span>
        <span>当前：{formatMetric(current)}</span>
      </div>
      <p>{report.valuationAnalysis.conclusion}</p>
    </div>
  );
}

function ReportView({ report, metrics }: { report: InvestmentReport; metrics?: ReportGenerationMetrics }) {
  const tokenSummary = summarizeTokenUsage(metrics?.tokenUsage);

  return (
    <article className="report">
      <header className="report-header">
        <div>
          <p className="eyebrow">
            {report.company.ticker || "未识别代码"} / {report.company.market || "未识别市场"} / {report.company.industry || "行业待验证"}
          </p>
          <h2>{report.company.name}</h2>
          <p className="muted">{report.oneSentence}</p>
          {metrics ? (
            <p className="muted">
              {metrics.cacheHit
                ? `共享缓存命中：本次响应 ${formatDuration(metrics.elapsedMs)} / 原生成耗时 ${metrics.sourceElapsedMs ? formatDuration(metrics.sourceElapsedMs) : "待验证"}`
                : `生成耗时：${formatDuration(metrics.elapsedMs)} / 模型调用 ${metrics.modelCalls} 次 / ${metrics.cacheMode === "refresh" ? "刷新生成" : "常规生成"}`}
            </p>
          ) : null}
          {tokenSummary ? (
            <p className="muted">
              Token：未命中输入 {formatTokens(tokenSummary.promptCacheMissTokens)} / 命中输入 {formatTokens(tokenSummary.promptCacheHitTokens)} / 输出{" "}
              {formatTokens(tokenSummary.completionTokens)}
            </p>
          ) : null}
        </div>
      </header>

      <section className="score-strip">
        <ScoreTile label="公司质量评分（CQS）" value={report.cqs} />
        <ScoreTile label="投资吸引力评分（IAS）" value={report.ias} />
        <div className="decision">
          <span>最终动作</span>
          <strong>{report.conclusion}</strong>
          <small>{report.qualitativeBand}</small>
        </div>
      </section>

      <section className="dashboard-grid">
        <InfoTile title="估值判断" value={report.summaryDashboard.valuationView} />
        <InfoTile title="建议仓位" value={report.summaryDashboard.positionAdvice} />
        <InfoTile title="投资期限" value={report.summaryDashboard.investmentHorizon} />
        <InfoTile title="公司等级" value={report.accountRules.companyGrade} />
      </section>

      <ReportBlock title="一页结论与评分仪表盘" body={report.fullSections.onePageConclusion} />

      <section className="module-table">
        <div className="table-row table-head">
          <span>模块</span>
          <span>权重</span>
          <span>得分</span>
          <span>标签</span>
          <span>一句话理由</span>
        </div>
        {report.moduleScores.map((module) => (
          <ModuleRow key={module.id} module={module} />
        ))}
      </section>

      <section className="score-items">
        <h3>20 项详细评分</h3>
        {report.scoreItems20.map((item, index) => (
          <ScoreItemCard key={item.id} item={item} index={index + 1} />
        ))}
      </section>

      <FinancialTable report={report} />
      <ValuationSection report={report} />
      <RiskSection report={report} />

      <section className="section-stack">
        {Object.entries(fullSectionTitles).map(([key, title]) => (
          <ReportBlock key={key} title={title} body={report.fullSections[key as keyof typeof report.fullSections]} />
        ))}
      </section>

      <EvidenceList report={report} />
      <p className="disclaimer">{report.disclaimer}</p>
    </article>
  );
}

function ScoreTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="score-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      <meter min="0" max="100" value={value} />
    </div>
  );
}

function InfoTile({ title, value }: { title: string; value: string }) {
  return (
    <div className="info-tile">
      <span>{title}</span>
      <strong>{value || "待验证"}</strong>
    </div>
  );
}

function ModuleRow({ module }: { module: ModuleScore }) {
  return (
    <div className="table-row">
      <span>{module.name}</span>
      <span>{module.weight}%</span>
      <span>{module.score}</span>
      <span>{module.label}</span>
      <span>{module.summary}</span>
    </div>
  );
}

function ScoreItemCard({ item, index }: { item: ScoreItem; index: number }) {
  return (
    <section className="score-item-card">
      <header>
        <span>{index}</span>
        <div>
          <h4>{item.title}</h4>
          <p>{item.moduleName} / 权重 {item.weight}%</p>
        </div>
        <strong>
          {item.score}/100（{item.label}）
        </strong>
      </header>
      <p>{item.reason}</p>
      <div className="item-columns">
        <div>
          <span>核心证据</span>
          <ul>{listItems(item.evidence)}</ul>
        </div>
        <div>
          <span>主要扣分点</span>
          <ul>{listItems(item.deductions)}</ul>
        </div>
      </div>
      <small>{item.recentChange}</small>
    </section>
  );
}

function FinancialTable({ report }: { report: InvestmentReport }) {
  const years = Array.from(new Set(report.financialTenYear.rows.flatMap((row) => Object.keys(row.values)))).slice(-10);
  const gridTemplateColumns = `150px repeat(${years.length}, minmax(84px, 1fr)) 104px`;
  const minWidth = `${150 + years.length * 84 + 104}px`;
  return (
    <section className="wide-section">
      <h3>十年财务数据总表</h3>
      {report.financialTenYear.rows.length && years.length ? (
        <div className="financial-table">
          <div className="financial-row financial-head" style={{ gridTemplateColumns, minWidth }}>
            <span>指标</span>
            {years.map((year) => (
              <span key={year}>{year}</span>
            ))}
            <span>趋势</span>
          </div>
          {report.financialTenYear.rows.map((row) => (
            <div key={row.metric} className="financial-row" style={{ gridTemplateColumns, minWidth }}>
              <span>{row.metric}</span>
              {years.map((year) => (
                <span key={year}>{row.values[year] || "-"}</span>
              ))}
              <span>{row.trend}</span>
            </div>
          ))}
        </div>
      ) : (
        <p>数据不足：公开接口未返回可直接入表的十年财务数据。</p>
      )}
      <p>{report.financialTenYear.interpretation}</p>
    </section>
  );
}

function ValuationSection({ report }: { report: InvestmentReport }) {
  return (
    <section className="wide-section">
      <h3>估值分析</h3>
      <div className="dashboard-grid">
        <InfoTile title="当前价格" value={report.valuationAnalysis.currentPrice} />
        <InfoTile title="合理价值区间" value={report.valuationAnalysis.fairValueRange} />
        <InfoTile title="期望买入区间" value={report.valuationAnalysis.buyRange} />
        <InfoTile title="减仓区间" value={report.valuationAnalysis.sellReduceRange} />
      </div>
      <p>{report.valuationAnalysis.conclusion}</p>
      {report.valuationAnalysis.scenarios.length ? (
        <div className="scenario-grid">
          {report.valuationAnalysis.scenarios.map((scenario) => (
            <section key={scenario.name}>
              <h4>{scenario.name}</h4>
              <p>{scenario.assumptions}</p>
              <span>{scenario.value}</span>
              <small>
                预期回报 {scenario.expectedReturn} / 概率 {scenario.probability}
              </small>
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RiskSection({ report }: { report: InvestmentReport }) {
  return (
    <section className="wide-section">
      <h3>风险清单与反证条件</h3>
      <div className="risk-list">
        {report.riskMatrix.length ? (
          report.riskMatrix.map((risk) => (
            <section key={`${risk.type}-${risk.risk}`}>
              <strong>{risk.type}</strong>
              <p>{risk.risk}</p>
              <span>
                概率 {risk.probability} / 影响 {risk.impact} / 预警指标 {risk.warningMetric}
              </span>
              <small>{risk.response}</small>
            </section>
          ))
        ) : (
          <p>数据不足：模型未提供完整风险矩阵。</p>
        )}
      </div>
    </section>
  );
}

function ReportBlock({ title, body }: { title: string; body: string }) {
  return (
    <section className="report-section">
      <h3>{title}</h3>
      {splitReportParagraphs(body).map((paragraph, index) => (
        <p key={`${title}-${index}`}>{paragraph}</p>
      ))}
    </section>
  );
}

function EvidenceList({ report }: { report: InvestmentReport }) {
  return (
    <section className="evidence-list">
      <h3>证据来源</h3>
      {report.evidence.map((item) => (
        <a key={`${item.source}-${item.url}-${item.title}`} href={item.url || undefined} target="_blank" rel="noreferrer">
          <strong>{item.title}</strong>
          <span>{item.source}</span>
          <span>{item.freshness}</span>
          <small>{item.notes}</small>
        </a>
      ))}
    </section>
  );
}

function EmptyState() {
  return (
    <section className="empty-state">
      <h2>先选择具体上市公司</h2>
      <p>输入公司名后会先弹出候选项，确认公司名、代码和上市地点，再生成完整评分报告。</p>
    </section>
  );
}

function listItems(items: string[]) {
  const values = items.length ? items : ["数据不足，需要继续核验。"];
  return values.map((item) => <li key={item}>{item}</li>);
}

function formatMetric(value: number | string | undefined, suffix = "") {
  if (typeof value === "string") return value || "待验证";
  if (value === undefined || !Number.isFinite(value)) return "待验证";
  return `${Math.abs(value) >= 1000 ? value.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${suffix}`;
}

function formatPercent(value: number | undefined) {
  return value === undefined ? "待验证" : `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
}

function formatCacheTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function isSameCompany(left: CompanyCandidate | null, right: CompanyCandidate) {
  return Boolean(left && left.code === right.code && left.listingPlace === right.listingPlace && left.marketType === right.marketType);
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds} 秒`;
}

function summarizeTokenUsage(usage: ReportGenerationMetrics["tokenUsage"] | undefined) {
  if (!usage?.length) return undefined;
  return usage.reduce(
    (sum, item) => ({
      promptCacheHitTokens: sum.promptCacheHitTokens + item.promptCacheHitTokens,
      promptCacheMissTokens: sum.promptCacheMissTokens + item.promptCacheMissTokens,
      completionTokens: sum.completionTokens + item.completionTokens,
    }),
    { promptCacheHitTokens: 0, promptCacheMissTokens: 0, completionTokens: 0 },
  );
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}M`;
  if (value >= 1000) return `${(value / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}K`;
  return value.toLocaleString("zh-CN");
}

function splitReportParagraphs(body: string) {
  const blocks = body
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const source = blocks.length ? blocks : [body.trim()].filter(Boolean);
  return source.flatMap((paragraph) => {
    if (paragraph.length <= 360) return [paragraph];
    const sentences = paragraph.match(/[^。！？；]+[。！？；]?/g) ?? [paragraph];
    const result: string[] = [];
    let current = "";
    for (const sentence of sentences) {
      if ((current + sentence).length > 300 && current) {
        result.push(current);
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current) result.push(current);
    return result;
  });
}

function parseNumbers(value: string) {
  return Array.from(value.replace(/[,，]/g, "").replace(/(\d)\s*[-–—~至到]\s*(\d)/g, "$1 $2").matchAll(/-?\d+(?:\.\d+)?/g))
    .map((match) => Number(match[0]))
    .filter((number) => Number.isFinite(number));
}

const fullSectionTitles = {
  companyOverview: "公司概况与发展史",
  industryTrack: "行业与细分赛道分析",
  businessModel: "商业模式与价值链",
  moat: "核心竞争力与长期竞争优势",
  governance: "管理层、治理结构与股东文化",
  financialQuality: "十年财务数据与现金流分析",
  growthInflection: "成长空间与重大转折期判断",
  valuation: "估值分析：好公司是否有好价格",
  risks: "风险清单与反证条件",
  finalConclusion: "最终投资结论",
  accountRules: "账户管理与仓位规则",
} as const;

export default App;
