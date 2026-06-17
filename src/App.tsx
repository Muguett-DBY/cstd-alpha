import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { addWatchlistItem, checkSession, fetchChartData, fetchRadarScan, fetchReportLibraryRecord, generateReport, login, logout, refreshRadarScan, REPORT_CANCELLED_MESSAGE, searchCompanies, type ReportProgress } from "./api";
import { downloadReportDocx } from "./docx/export-report";
import "./App.css";
import { RadarVisualCharts } from "./RadarVisualCharts";
import { ChartDashboard, type ChartPhase } from "./ReportCharts";
import { OpportunityDashboard } from "./OpportunityDashboard";
import { ResearchWorkspace } from "./ResearchWorkspace";
import { MarketWorkspace } from "./MarketWorkspace";
import { ValuationLabView } from "./ValuationLabView";
import { ToastContainer } from "./Toast";
import { showToast } from "./toast-state";
import type { RankingMarket } from "./RankingView";
import { usePwaInstallPrompt } from "./usePwaInstallPrompt";
import { clearLocalReportStorage, loadCachedChart, loadCachedReport, loadLastReportEntry, saveCachedChart, saveCachedReport, saveLastReport } from "./storage";
import { clearImportedRankingReports } from "./ranking-storage";
import { buildRadarSourceLibrary, isWeakRadarPacket, radarCardInsights, radarChangeBuckets, radarPacketDisplayPlan, radarPacketGapExplanation, radarRefreshFallbackMessage } from "./radar-ui";
import type { ChartBundle, PriceMode } from "./shared/chart";
import { companyCandidateFromRanking, type RankingEntry } from "./shared/ranking";
import type { RadarAnalysisJob, RadarCitation, RadarCoverageItem, RadarCoverageReview, RadarDiagnostics, RadarEvidenceBreakdown, RadarEvidenceType, RadarIndustryPacket, RadarIndustryStage, RadarItem, RadarList, RadarScan } from "./shared/radar";
import type { CompanyCandidate, InvestmentReport, ModuleScore, ReportGenerationMetrics, ScoreItem } from "./shared/report";
import type { UserSession, WatchlistRankingEntry } from "./shared/user-research";

type Phase = "idle" | "searching" | "selecting" | "generating" | "ready" | "error";
type AppView = "opportunities" | "research" | "market" | "valuation" | "report" | "ranking" | "watchlist-ranking" | "mine" | "radar" | "assistant";
type RadarPhase = "idle" | "loading" | "refreshing" | "ready" | "error";

export const DEFAULT_APP_VIEW: AppView = "opportunities";
const RankingView = lazy(() => import("./RankingView").then((module) => ({ default: module.RankingView })));
const WatchlistRankingView = lazy(() => import("./WatchlistRankingView").then((module) => ({ default: module.WatchlistRankingView })));
const MyResearchView = lazy(() => import("./MyResearchView").then((module) => ({ default: module.MyResearchView })));
const AssistantView = lazy(() => import("./AssistantView").then((module) => ({ default: module.AssistantView })));

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<UserSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<CompanyCandidate[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<CompanyCandidate | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ReportProgress[]>([]);
  const [evidenceCount, setEvidenceCount] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
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
  const [activeView, setActiveView] = useState<AppView>(DEFAULT_APP_VIEW);
  const [isInWatchlist, setIsInWatchlist] = useState(false);
  const [rankingMarket, setRankingMarket] = useState<RankingMarket>("a-share");
  const [radar, setRadar] = useState<RadarScan | null>(null);
  const [radarJob, setRadarJob] = useState<RadarAnalysisJob | null>(null);
  const [radarDiagnostics, setRadarDiagnostics] = useState<RadarDiagnostics | null>(null);
  const [radarPhase, setRadarPhase] = useState<RadarPhase>("idle");
  const [radarError, setRadarError] = useState("");
  const [mobileAssistantOnly, setMobileAssistantOnly] = useState(() => (typeof window !== "undefined" ? window.matchMedia("(max-width: 760px)").matches : false));
  const installPrompt = usePwaInstallPrompt();
  const selectedCompanyRef = useRef<CompanyCandidate | null>(selectedCompany);

  const radarRef = useRef(radar);

  useEffect(() => { radarRef.current = radar; }, [radar]);

  const loadRadar = useCallback(
    async (forceRefresh: boolean) => {
      const hasExistingRadar = Boolean(radarRef.current);
      setRadarPhase(forceRefresh && hasExistingRadar ? "refreshing" : "loading");
      setRadarError("");
      try {
        const nextRadar = forceRefresh ? await refreshRadarScan() : await fetchRadarScan();
        if (nextRadar.radar) setRadar(nextRadar.radar);
        else if (!hasExistingRadar) setRadar(null);
        setRadarJob(nextRadar.job ?? null);
        setRadarDiagnostics(nextRadar.diagnostics ?? null);
        if (nextRadar.job?.status === "queued" || nextRadar.job?.status === "running") {
          setRadarPhase(nextRadar.radar || hasExistingRadar ? "refreshing" : "loading");
        } else {
          setRadarPhase(nextRadar.radar ? "ready" : "error");
        }
        setRadarError(nextRadar.warning ?? nextRadar.radar?.refreshWarning ?? "");
      } catch (err) {
        setRadarPhase(hasExistingRadar ? "ready" : "error");
        setRadarError(radarRefreshFallbackMessage(hasExistingRadar, err));
      }
    },
    [],
  );

  useEffect(() => {
    if (activeView !== "radar" || (radarJob?.status !== "queued" && radarJob?.status !== "running")) return;
    const id = window.setInterval(() => {
      void fetchRadarScan()
        .then((result) => {
          if (result.radar) setRadar(result.radar);
          setRadarJob(result.job ?? null);
          setRadarDiagnostics(result.diagnostics ?? null);
          if (result.job?.status === "queued" || result.job?.status === "running") {
            setRadarPhase((prev) => prev === "loading" ? "loading" : "refreshing");
          } else {
            setRadarPhase(result.radar ? "ready" : "error");
          }
          setRadarError(result.warning ?? result.radar?.refreshWarning ?? "");
        })
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(id);
  }, [activeView, radarJob?.status]);

  useEffect(() => {
    void checkSession()
      .then((session) => {
        setUser(session);
        setAuthenticated(Boolean(session));
      })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    selectedCompanyRef.current = selectedCompany;
  }, [selectedCompany]);

  useEffect(() => {
    if (!authenticated || activeView !== "radar" || radar || radarPhase !== "idle") return;
    const id = window.setTimeout(() => void loadRadar(false), 0);
    return () => window.clearTimeout(id);
  }, [activeView, authenticated, loadRadar, radar, radarPhase]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setMobileAssistantOnly(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const viewMap: Record<string, AppView> = { "1": "opportunities", "2": "research", "3": "market", "4": "valuation", "5": "assistant" };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      const view = viewMap[event.key];
      if (view === "assistant" && user?.role !== "admin") return;
      if (view) { event.preventDefault(); setActiveView(view); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [user?.role]);

  useEffect(() => {
    const goOffline = () => showToast("网络连接已断开，部分功能暂时不可用。", "error", 8000);
    const goOnline = () => showToast("网络已恢复。", "success", 3000);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setIsLoggingIn(true);
    try {
      const session = await login(password, username);
      setUser(session);
      setAuthenticated(true);
      setRadarError("");
      if (activeView === "radar" && !radar) setRadarPhase("idle");
    } catch (err) {
      setError(errorMessage(err, "登录失败。"));
    } finally {
      setIsLoggingIn(false);
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
    setRadar(null);
    setRadarJob(null);
    setRadarDiagnostics(null);
    setRadarPhase("idle");
    setRadarError("");
    setProgress([]);
    setCacheNotice("");
    clearLocalReportStorage();
    clearImportedRankingReports();
  }

  async function addToWatchlist() {
    if (!selectedCompany) return;
    try {
      await addWatchlistItem({ company: selectedCompany });
      setIsInWatchlist(true);
      showToast(`${selectedCompany.name} 已加入自选股。`, "success");
    } catch (err) {
      showToast(errorMessage(err, "加入自选失败。"), "error");
    }
  }

  async function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim() || phase === "searching") return;
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
      setError(errorMessage(err, "公司搜索失败。"));
    }
  }

  async function submitReport(forceRefresh = false) {
    if (phase === "generating") return;
    if (!selectedCompany) {
      setError("请先从候选列表中选择具体公司。");
      setPhase("selecting");
      return;
    }
    const requestCompany = selectedCompany;

    if (reportAbortController) reportAbortController.abort();

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
        setError(errorMessage(err, "报告生成失败。"));
      }
    } finally {
      setStartedAt(null);
      setReportAbortController(null);
    }
  }

  async function submitChart(nextPriceMode = priceMode, forceRefresh = false) {
    if (chartPhase === "loading") return;
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
      setChartError(errorMessage(err, "图表数据生成失败。"));
    }
  }

  async function openRankingEntry(entry: RankingEntry) {
    const company = companyCandidateFromRanking(entry);
    setSelectedCompany(company);
    setQuery(entry.name);
    setChartBundle(null);
    setChartError("");
    setIsInWatchlist(false);
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
        setError(errorMessage(err, "报告库读取失败。"));
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
    setIsInWatchlist(false);
    setReport(null);
    setReportMetrics(null);
    setProgress([]);
    setEvidenceCount(0);
    setPhase("idle");
    setActiveView("report");
    setCacheNotice("已从我的自选股打开公司，可生成或查看完整评分报告。");
  }

  function openWatchlistRankingEntry(entry: WatchlistRankingEntry) {
    const company: CompanyCandidate = {
      id: `watchlist-ranking:${entry.market}:${entry.ticker}`,
      name: entry.companyName,
      code: entry.ticker,
      exchange: entry.market,
      listingPlace: entry.listingPlace || entry.market,
      marketType: "Library",
      source: entry.market.includes("美") || /^[A-Z.]+$/.test(entry.ticker) ? "yahoo" : "eastmoney",
    };
    setSelectedCompany(company);
    setQuery(company.name);
    setChartBundle(null);
    setChartError("");
    setIsInWatchlist(false);
    setReport(null);
    setReportMetrics(null);
    setProgress([]);
    setEvidenceCount(0);
    setPhase("idle");
    setActiveView("mine");
    setCacheNotice("已从自选股排行打开公司，可在“我的”里查看模板或重新评分。");
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
            <button type="submit" disabled={isLoggingIn}>{isLoggingIn ? "验证中..." : "进入"}</button>
          </form>
          {error ? <p className="error-text">{error}</p> : null}
        </section>
      </main>
    );
  }

  const renderedView: AppView = mobileAssistantOnly && user?.role === "admin" ? "assistant" : activeView;
  const isWorkbenchView = renderedView === "opportunities" || renderedView === "research" || renderedView === "market" || renderedView === "valuation" || renderedView === "assistant";
  const openMarketRanking = (market: "A股" | "美股" | "港股") => {
    setRankingMarket(market === "A股" ? "a-share" : market === "美股" ? "us" : "hk");
    setActiveView("ranking");
  };
  const openRadarFromMarket = () => {
    setActiveView("radar");
    if (!radar && radarPhase === "idle") void loadRadar(false);
  };

  return (
    <main className={`app-shell view-${renderedView} ${mobileAssistantOnly ? "mobile-assistant-only" : ""}`}>
      <a href="#workspace" className="skip-link">跳转到工作区</a>
      <aside className={`input-rail ${isWorkbenchView ? "workbench-nav-rail" : ""}`}>
        <div>
          <p className="brand">CSTD Alpha</p>
          <h1>{isWorkbenchView ? "AI 数据工作台" : "中文深度评分报告"}</h1>
          <p className="rail-copy">{isWorkbenchView ? "发现机会、进入研究、验证估值，再用助手追问。" : "先确认上市主体，再生成完整模板报告，避免同名公司或错误代码。"}</p>
          <p className="muted">当前账号：{user?.displayName || user?.username}</p>
          <button type="button" className="ghost-button" onClick={() => void submitLogout()}>
            退出登录
          </button>
        </div>

        <nav className="view-tabs" aria-label="工作区">
          <button type="button" className={renderedView === "opportunities" ? "active" : ""} aria-current={renderedView === "opportunities" ? "page" : undefined} onClick={() => setActiveView("opportunities")}>
            今日机会<kbd>1</kbd>
          </button>
          <button type="button" className={renderedView === "research" || renderedView === "mine" || renderedView === "report" ? "active" : ""} aria-current={renderedView === "research" ? "page" : undefined} onClick={() => setActiveView("research")}>
            研究<kbd>2</kbd>
          </button>
          <button type="button" className={renderedView === "market" || renderedView === "ranking" || renderedView === "watchlist-ranking" || renderedView === "radar" ? "active" : ""} aria-current={renderedView === "market" ? "page" : undefined} onClick={() => setActiveView("market")}>
            市场<kbd>3</kbd>
          </button>
          <button type="button" className={renderedView === "valuation" ? "active" : ""} aria-current={renderedView === "valuation" ? "page" : undefined} onClick={() => setActiveView("valuation")}>
            估值<kbd>4</kbd>
          </button>
          {user?.role === "admin" ? (
            <button type="button" className={renderedView === "assistant" ? "active" : ""} aria-current={renderedView === "assistant" ? "page" : undefined} onClick={() => setActiveView("assistant")}>
              助手<kbd>5</kbd>
            </button>
          ) : null}
        </nav>

        {!isWorkbenchView ? (
        <>
        <form onSubmit={submitSearch} className="report-form">
          <label htmlFor="companyQuery">公司名或股票代码</label>
          <div className="search-input-wrap">
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
            {query ? (
              <button type="button" className="search-clear" onClick={() => { setQuery(""); setSelectedCompany(null); }} aria-label="清除搜索">
                ×
              </button>
            ) : null}
          </div>
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
          startedAt={startedAt}
          completedElapsedMs={reportMetrics?.elapsedMs}
          evidenceCount={evidenceCount || report?.evidence.length || 0}
        />
        {error ? <p className="error-text">{error}</p> : null}
        </>
        ) : null}
      </aside>

      <section id="workspace" className="workspace">
        <Suspense fallback={<section className="empty-state"><div className="button-spinner" /><h2>正在加载</h2></section>}>
          {renderedView === "opportunities" ? (
            <OpportunityDashboard onOpenResearch={() => setActiveView("research")} />
          ) : renderedView === "research" ? (
            <ResearchWorkspace onOpenLegacyMine={() => setActiveView("mine")} onOpenAssistant={() => setActiveView("assistant")} onOpenReport={() => setActiveView("report")} />
          ) : renderedView === "market" ? (
            <MarketWorkspace onOpenRanking={openMarketRanking} onOpenWatchlistRanking={() => setActiveView("watchlist-ranking")} onOpenRadar={openRadarFromMarket} />
          ) : renderedView === "valuation" ? (
            <ValuationLabView />
          ) : renderedView === "ranking" ? (
            <RankingView market={rankingMarket} onOpenEntry={openRankingEntry} />
          ) : renderedView === "watchlist-ranking" ? (
            <WatchlistRankingView onOpenEntry={openWatchlistRankingEntry} />
          ) : renderedView === "mine" ? (
            <MyResearchView user={user} selectedCompany={selectedCompany} onOpenCompany={openCompanyFromMine} />
          ) : renderedView === "radar" ? (
            <RadarView radar={radar} job={radarJob} diagnostics={radarDiagnostics} isAdmin={user?.role === "admin"} phase={radarPhase} error={radarError} onRefresh={() => void loadRadar(true)} />
          ) : renderedView === "assistant" && user?.role === "admin" ? (
            <AssistantView />
          ) : (
            <>
              {chartBundle || chartPhase === "loading" || chartPhase === "error" ? (
                <ChartDashboard chartBundle={chartBundle} chartPhase={chartPhase} report={report} priceMode={priceMode} />
              ) : null}
              {report ? <ReportView report={report} metrics={reportMetrics ?? undefined} onAddToWatchlist={addToWatchlist} isWatchlisted={isInWatchlist} chartBundle={chartBundle ?? undefined} /> : <EmptyState />}
            </>
          )}
        </Suspense>
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
      <BackToTop />
      <InstallPromptBanner visible={installPrompt.visible} onInstall={() => void installPrompt.install()} onDismiss={installPrompt.dismiss} />
      <ToastContainer />
    </main>
  );
}

function BackToTop() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!visible) return null;
  return (
    <button type="button" className="back-to-top" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="回到顶部">
      ↑
    </button>
  );
}

function InstallPromptBanner({ visible, onInstall, onDismiss }: { visible: boolean; onInstall: () => void; onDismiss: () => void }) {
  if (!visible) return null;
  return (
    <aside className="install-prompt" aria-label="添加到桌面">
      <div>
        <strong>CSTD Alpha</strong>
        <span>添加到桌面，直接打开雷达扫描。</span>
      </div>
      <div>
        <button type="button" onClick={onInstall}>
          添加
        </button>
        <button type="button" className="ghost-button" onClick={onDismiss} aria-label="关闭添加到桌面提示">
          关闭
        </button>
      </div>
    </aside>
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
  const modalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const firstButton = modalRef.current?.querySelector<HTMLElement>("button");
    firstButton?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { onClose(); return; }
    if (event.key !== "Tab") return;
    const focusable = modalRef.current?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className="modal-backdrop" role="presentation" tabIndex={-1} onKeyDown={handleKeyDown}>
      <section ref={modalRef} className="candidate-modal" role="dialog" aria-modal="true" aria-labelledby="candidate-title">
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
  return error instanceof Error && error.message === REPORT_CANCELLED_MESSAGE;
}

function ProgressPanel({
  progress,
  phase,
  startedAt,
  completedElapsedMs,
  evidenceCount,
}: {
  progress: ReportProgress[];
  phase: Phase;
  startedAt: number | null;
  completedElapsedMs?: number;
  evidenceCount: number;
}) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const latest = progress.at(-1);

  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const statusText =
    phase === "generating"
      ? formatDuration(elapsedMs)
      : phase === "ready"
        ? completedElapsedMs !== undefined
          ? `完成 / ${formatDuration(completedElapsedMs)}`
          : "完成"
        : phase === "error"
          ? "失败"
          : "待开始";
  return (
    <section className="progress-panel" aria-live="polite" aria-atomic="true">
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

function ReportView({ report, metrics, onAddToWatchlist, isWatchlisted, chartBundle }: { report: InvestmentReport; metrics?: ReportGenerationMetrics; onAddToWatchlist?: () => void; isWatchlisted?: boolean; chartBundle?: ChartBundle }) {
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
        {onAddToWatchlist ? (
          <button type="button" className="secondary-button" onClick={onAddToWatchlist} disabled={isWatchlisted}>
            {isWatchlisted ? "已加入自选" : "加入自选"}
          </button>
        ) : null}
        <button type="button" className="secondary-button" onClick={() => downloadReportDocx(report, chartBundle)}>
          下载报告
        </button>
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

function RadarView({
  radar,
  job,
  diagnostics,
  isAdmin,
  phase,
  error,
  onRefresh,
}: {
  radar: RadarScan | null;
  job: RadarAnalysisJob | null;
  diagnostics: RadarDiagnostics | null;
  isAdmin: boolean;
  phase: RadarPhase;
  error: string;
  onRefresh: () => void;
}) {
  const loading = phase === "loading" || phase === "refreshing";
  const refreshing = phase === "refreshing";
  const jobRunning = job?.status === "queued" || job?.status === "running";
  const sourceMap = useMemo(() => new Map((radar?.evidenceSources ?? []).map((source) => [source.id, source])), [radar?.evidenceSources]);
  const radarItems = useMemo(() => (radar ? allRadarItems(radar) : []), [radar]);
  const visualPackets = useMemo(() => (radar ? buildRadarVisualPackets(radar) : []), [radar]);
  const [selectedIndustry, setSelectedIndustry] = useState("");
  const selectedPacket = useMemo(() => visualPackets.find((packet) => packet.industry === selectedIndustry) ?? null, [selectedIndustry, visualPackets]);
  return (
    <section className="radar-view">
      <header className={`radar-header ${refreshing ? "is-refreshing" : ""}`}>
        <div>
          <p className="eyebrow">行业雷达</p>
          <h2>
            <span>全市场增长、</span>
            <span>泡沫与衰退扫描</span>
          </h2>
          <p>综合公开信息源与模型产业判断，优先识别可持续增长、短期透支、产业泡沫和衰退风险。</p>
        </div>
        <button className="generate-button radar-scan-button" type="button" disabled={loading} onClick={onRefresh}>
          {loading ? <span className="button-spinner" aria-hidden="true" /> : null}
          {jobRunning ? "后台分析中" : loading ? "正在扫描..." : "雷达扫描"}
        </button>
      </header>

      {error ? <p className="error-text">{error}</p> : null}
      {radar?.reuseReason ? <p className="cache-notice">{radar.reuseReason}</p> : null}
      {jobRunning || refreshing ? <p className="cache-notice radar-refresh-notice">{job?.message || "后台深度分析中，当前页面继续显示上次稳定结果。"}</p> : null}

      {!radar && loading ? (
        <section className="empty-state radar-empty">
          <h2>正在生成行业雷达</h2>
          <p>正在读取公开新闻源并让模型做稳定产业归类，首次扫描可能需要一些时间。</p>
        </section>
      ) : null}

      {!radar && phase === "error" ? (
        <section className="empty-state radar-empty">
          <h2>雷达暂时不可用</h2>
          <p>请稍后重试，或检查后端模型与缓存配置。</p>
        </section>
      ) : null}

      {radar ? (
        <>
          <div className="radar-meta">
            <InfoTile title="信息截止" value={radar.asOfDate} />
            <InfoTile title="公开来源" value={`${radar.sourceCount} 条`} />
            <InfoTile title="模型" value={radar.model} />
            <InfoTile title="状态" value={jobRunning ? "后台分析中" : radar.fromCache ? "复用稳定扫描" : "本次新扫描"} />
            <InfoTile title="证据新鲜度" value={radar.evidenceFreshness?.generatedAt ? `${radar.evidenceFreshness.ageHours ?? 0} 小时` : "待确认"} />
          </div>

          {radar.evidenceFreshness?.stale ? <p className="cache-notice">当前证据包偏旧，已按现有证据分析；请关注信息截止时间。</p> : null}
          {isAdmin && diagnostics ? <RadarDiagnosticsPanel diagnostics={diagnostics} /> : null}
          <RadarRoundChanges changeLog={radar.changeLog} />
          <RadarSectionNav />
          <RadarBrief radar={radar} />
          <RadarMarketOverview radar={radar} packets={visualPackets} onSelectIndustry={setSelectedIndustry} />
          <RadarIndustryTable packets={visualPackets} onSelectIndustry={setSelectedIndustry} />
          <RadarEvidenceOverview
            breakdown={radar.evidenceBreakdown}
            confidenceSummary={radar.confidenceSummary}
            changeLog={radar.changeLog}
            softCoverage={radar.softCoverage}
            coverageReview={radar.coverageReview}
          />

          <RadarItemSection id="radar-growth" title="一、当前扎实增长的细分产业" items={radar.solidGrowth} sourceMap={sourceMap} />
          <RadarItemSection id="radar-sustainability" title="二、增长可持续性" items={radar.sustainability} sourceMap={sourceMap} />
          <RadarItemSection id="radar-bubble" title="三、高增长陷阱与泡沫风险" items={radar.bubbleRisks} sourceMap={sourceMap} />
          <RadarItemSection id="radar-upcoming" title="四、即将进入增长期的产业和公司" items={radar.upcomingGrowth} sourceMap={sourceMap} />
          <RadarItemSection id="radar-decline" title="五、衰退产业识别" items={radar.decliningIndustries} sourceMap={sourceMap} />
          <RadarListSection id="radar-companies" title="六、代表性公司清单" lists={radar.representativeCompanies} />
          <RadarListSection id="radar-stages" title="七、不同产业阶段中的典型公司" lists={radar.stageCompanies} />
          <RadarSourceLibrary sources={radar.evidenceSources ?? []} items={radarItems} />

          {radar.limitations.length ? (
            <section className="radar-summary" id="radar-limitations">
              <h3>约束与待验证</h3>
              <ul>{listItems(radar.limitations)}</ul>
            </section>
          ) : null}
          {selectedPacket ? (
            <RadarIndustryDrawer packet={selectedPacket} items={radarItems} sourceMap={sourceMap} onClose={() => setSelectedIndustry("")} />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function RadarRoundChanges({ changeLog }: { changeLog?: string[] }) {
  const buckets = radarChangeBuckets(changeLog ?? []);
  const groups = [
    { key: "added", title: "新增", items: buckets.added, note: "新进入本轮重点跟踪" },
    { key: "upgraded", title: "升级", items: buckets.upgraded, note: "从观察转向更强结论" },
    { key: "downgraded", title: "降级", items: buckets.downgraded, note: "证据转弱或本次未延续" },
    { key: "maintained", title: "维持", items: buckets.maintained, note: "延续上次稳定判断" },
  ];
  return (
    <section className="radar-summary radar-round-changes" aria-labelledby="radar-round-changes-title">
      <div className="radar-round-changes-head">
        <div>
          <p className="eyebrow">上次 vs 本次</p>
          <h3 id="radar-round-changes-title">本轮变化</h3>
        </div>
        <p>按新增、升级、降级、维持拆开，优先看判断是否发生实质变化。</p>
      </div>
      <div className="radar-round-change-grid">
        {groups.map((group) => (
          <article className={`radar-round-change-card change-${group.key}`} key={group.key}>
            <div>
              <span>{group.note}</span>
              <strong>
                {group.title}
                <small>{group.items.length}</small>
              </strong>
            </div>
            <ul>{listItems(group.items.length ? group.items.slice(0, 4) : ["本轮无明确变化。"])}</ul>
          </article>
        ))}
      </div>
      <RadarChangeFlow buckets={buckets} />
    </section>
  );
}

function RadarChangeFlow({ buckets }: { buckets: ReturnType<typeof radarChangeBuckets> }) {
  const flows = [
    { from: "未覆盖/弱线索", to: "新增跟踪", items: buckets.added, className: "added" },
    { from: "观察", to: "更强结论", items: buckets.upgraded, className: "upgraded" },
    { from: "正式结论", to: "降级/撤销", items: buckets.downgraded, className: "downgraded" },
    { from: "上次结论", to: "维持", items: buckets.maintained, className: "maintained" },
  ].filter((flow) => flow.items.length);
  if (!flows.length) return null;
  return (
    <div className="radar-change-flow" aria-label="上次到本次变化流向">
      {flows.map((flow) => (
        <article key={flow.className} className={`radar-flow-${flow.className}`}>
          <span>{flow.from}</span>
          <i aria-hidden="true" />
          <strong>{flow.to}</strong>
          <small>{flow.items.slice(0, 3).join(" / ")}</small>
        </article>
      ))}
    </div>
  );
}

function RadarSectionNav() {
  return (
    <nav className="radar-section-nav" aria-label="雷达章节">
      <a href="#radar-overview">概览</a>
      <a href="#radar-market-map">热力图</a>
      <a href="#radar-all-industries">全行业</a>
      <a href="#radar-growth">增长</a>
      <a href="#radar-sustainability">可持续性</a>
      <a href="#radar-bubble">泡沫</a>
      <a href="#radar-upcoming">增长期</a>
      <a href="#radar-decline">衰退</a>
      <a href="#radar-companies">代表公司</a>
      <a href="#radar-sources">证据</a>
    </nav>
  );
}

function RadarBrief({ radar }: { radar: RadarScan }) {
  const focusCards = [
    { label: "增长重点", item: highestPriorityRadarItem(radar.solidGrowth) },
    { label: "泡沫/衰退风险", item: highestPriorityRadarItem([...radar.bubbleRisks, ...radar.decliningIndustries]) },
    { label: "即将进入增长期", item: highestPriorityRadarItem(radar.upcomingGrowth) },
  ].filter((entry): entry is { label: string; item: RadarItem } => Boolean(entry.item));
  return (
    <section className="radar-summary radar-brief" id="radar-overview">
      <div className="radar-brief-main">
        <div>
          <p className="eyebrow">雷达简报</p>
          <h3>{radar.title}</h3>
          <p>
            生成时间 {formatDateTime(radar.generatedAt)}，稳定窗口至 {formatDateTime(radar.validUntil)}。
          </p>
        </div>
        <ul>{listItems(radar.executiveSummary.slice(0, 5))}</ul>
      </div>
      <RadarSignalMap radar={radar} />
      {focusCards.length ? (
        <div className="radar-focus-grid">
          {focusCards.map(({ label, item }) => (
            <article key={label}>
              <span>{label}</span>
              <strong>{item.title || "待确认主题"}</strong>
              <p>{item.thesis || "模型未提供完整分析。"}</p>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RadarSignalMap({ radar }: { radar: RadarScan }) {
  const groups = [
    { label: "扎实增长", value: radar.solidGrowth.length, className: "growth" },
    { label: "可持续性", value: radar.sustainability.length, className: "sustain" },
    { label: "泡沫风险", value: radar.bubbleRisks.length, className: "bubble" },
    { label: "增长期", value: radar.upcomingGrowth.length, className: "upcoming" },
    { label: "衰退", value: radar.decliningIndustries.length, className: "decline" },
  ];
  const total = groups.reduce((sum, item) => sum + item.value, 0);
  return (
    <div className="radar-signal-map" aria-label="本轮结论分布">
      <div className="radar-signal-map-head">
        <strong>结论分布</strong>
        <span>{total} 个雷达条目</span>
      </div>
      <div className="radar-signal-bars">
        {groups.map((group) => (
          <span key={group.label} className={`signal-${group.className}`} style={{ "--bar": `${total ? Math.max(8, (group.value / total) * 100) : 0}%` } as CSSProperties}>
            <small>{group.label}</small>
            <strong>{group.value}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function RadarMarketOverview({ radar, packets, onSelectIndustry }: { radar: RadarScan; packets: RadarIndustryPacket[]; onSelectIndustry: (industry: string) => void }) {
  if (!packets.length) return null;
  const formalTotal = allRadarItems(radar).filter((item) => item.conclusionStrength === "正式结论").length;
  const scannedTotal = radar.analysisScope?.totalIndustryCount ?? radar.industryPackets?.length ?? 0;
  const weakTotal = packets.filter((packet) => packet.stage === "证据不足").length;
  return (
    <section className="radar-summary radar-market-overview" id="radar-market-map">
      <header className="radar-section-head">
        <div>
          <p className="eyebrow">全行业地图</p>
          <h3>全行业扫描地图</h3>
          <p>正式结论、观察线索和弱证据分开看；热力图覆盖全量扫描包，不等同于正式推荐。</p>
        </div>
        <span>{packets.length} 个细分主题</span>
      </header>
      <div className="radar-market-kpis" aria-label="雷达覆盖口径">
        <span>
          <strong>{formalTotal}</strong>
          正式结论条目
        </span>
        <span>
          <strong>{scannedTotal || packets.length}</strong>
          后台行业包
        </span>
        <span>
          <strong>{packets.length}</strong>
          可视化主题
        </span>
        <span>
          <strong>{weakTotal}</strong>
          证据不足
        </span>
      </div>
      <RadarVisualCharts packets={packets} onSelectIndustry={onSelectIndustry} />
      <div className="radar-market-layout">
        <RadarIndustryHeatmap packets={packets} onSelectIndustry={onSelectIndustry} />
        <RadarStageBuckets packets={packets} onSelectIndustry={onSelectIndustry} />
      </div>
      <RadarTopSignalLists packets={packets} onSelectIndustry={onSelectIndustry} />
    </section>
  );
}

function RadarIndustryHeatmap({ packets, onSelectIndustry }: { packets: RadarIndustryPacket[]; onSelectIndustry: (industry: string) => void }) {
  const visiblePackets = [...packets].sort((left, right) => radarPacketPriority(right) - radarPacketPriority(left));
  return (
    <div className="radar-heatmap" aria-label="产业增长动量和风险热力图">
      <div className="radar-heatmap-axis y-axis">泡沫/衰退风险</div>
      <div className="radar-heatmap-axis x-axis">增长动量</div>
      <div className="radar-heatmap-quadrants" aria-hidden="true">
        <span>高增长高风险</span>
        <span>重点机会区</span>
        <span>避雷/衰退区</span>
        <span>稳定/高股息区</span>
      </div>
      {visiblePackets.map((packet) => {
        const scores = radarPacketVisualScores(packet);
        const growthMomentum = Math.max(scores.growth, scores.momentum);
        const risk = Math.max(scores.bubbleRisk, scores.declineRisk, scores.valuationRisk);
        const size = Math.max(10, Math.min(32, 11 + Math.sqrt(packet.sourceCount || 0) * 3 + scores.evidence / 18));
        return (
          <button
            type="button"
            key={packet.industry}
            className={`radar-heatmap-dot ${radarStageClass(packet.stage)} ${scores.confidence < 45 ? "is-low-confidence" : ""}`}
            onClick={() => onSelectIndustry(packet.industry)}
            title={`${packet.industry}｜${packet.stage ?? "证据不足"}｜动量 ${growthMomentum}｜风险 ${risk}｜证据 ${packet.sourceCount} 条`}
            style={{ left: `${growthMomentum}%`, top: `${100 - risk}%`, width: size, height: size } as CSSProperties}
          >
            <span>{packet.industry}</span>
          </button>
        );
      })}
      <div className="radar-heatmap-legend" aria-label="热力图图例">
        <span className="stage-growth">增长</span>
        <span className="stage-bubble">泡沫</span>
        <span className="stage-decline">衰退</span>
        <span className="stage-watch">观察</span>
        <span className="stage-weak">弱证据</span>
      </div>
    </div>
  );
}

function RadarStageBuckets({ packets, onSelectIndustry }: { packets: RadarIndustryPacket[]; onSelectIndustry: (industry: string) => void }) {
  const buckets = radarStageBuckets(packets);
  return (
    <div className="radar-stage-buckets" aria-label="产业阶段分布">
      <div className="radar-signal-map-head">
        <strong>全量扫描分层</strong>
        <span>全行业包阶段，不等同正式结论数量</span>
      </div>
      {buckets.map((bucket) => (
        <details key={bucket.stage} className={`radar-stage-bucket ${radarStageClass(bucket.stage)}`} open={bucket.stage === "扎实增长" || bucket.stage === "泡沫风险"}>
          <summary>
            <span>{bucket.stage}</span>
            <strong>{bucket.items.length}</strong>
            <i style={{ width: `${bucket.percent}%` }} />
          </summary>
          <div>
            {bucket.items.slice(0, 12).map((packet) => (
              <button key={packet.industry} type="button" onClick={() => onSelectIndustry(packet.industry)}>
                {packet.industry}
                <small>{packet.sourceCount} 条</small>
              </button>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function RadarTopSignalLists({ packets, onSelectIndustry }: { packets: RadarIndustryPacket[]; onSelectIndustry: (industry: string) => void }) {
  const lists = [
    { title: "机会强度 Top 20", items: topRadarPackets(packets, (packet) => radarPacketMetricValue(packet, "opportunity")), metric: "opportunity" },
    { title: "风险压力 Top 20", items: topRadarPackets(packets, (packet) => radarPacketMetricValue(packet, "risk")), metric: "risk" },
    { title: "证据充分度 Top 20", items: topRadarPackets(packets, (packet) => radarPacketMetricValue(packet, "evidence")), metric: "evidence" },
    { title: "边际变化 Top 20", items: topRadarPackets(packets, (packet) => radarPacketMetricValue(packet, "change")), metric: "change" },
  ];
  return (
    <div className="radar-top-lists">
      {lists.map((list) => (
        <article key={list.title}>
          <h4>{list.title}</h4>
          <ol>
            {list.items.map((packet) => (
              <li key={`${list.title}-${packet.industry}`}>
                <button type="button" onClick={() => onSelectIndustry(packet.industry)}>{packet.industry}</button>
                <span className={`coverage-status ${radarStageClass(packet.stage)}`}>{packet.stage ?? "证据不足"}</span>
                <strong>{radarPacketMetric(packet, list.metric)}</strong>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </div>
  );
}

function RadarIndustryTable({ packets, onSelectIndustry }: { packets: RadarIndustryPacket[]; onSelectIndustry: (industry: string) => void }) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("all");
  const [expanded, setExpanded] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: "priority", desc: true }]);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const defaultVisibleCount = 10;
  const displayPlan = useMemo(
    () => radarPacketDisplayPlan(packets, { query, stage: stage as RadarIndustryStage | "all", expanded, defaultVisibleCount }),
    [packets, query, stage, expanded],
  );
  const rows = displayPlan.allRows;
  const hasActiveFilter = stage !== "all" || Boolean(query.trim());
  const visibleRows = displayPlan.visibleRows;
  const columns = useMemo(
    () => [
      radarIndustryColumnHelper.accessor("industry", {
        header: "细分产业",
        cell: ({ row }) => (
          <span>
            <strong>{row.original.industry}</strong>
            <small>{row.original.group}{row.original.themes?.length ? ` · ${row.original.themes.slice(0, 2).join("、")}` : ""}</small>
          </span>
        ),
      }),
      radarIndustryColumnHelper.accessor((row) => row.stage ?? "证据不足", {
        id: "stage",
        header: "阶段",
        cell: ({ getValue }) => {
          const value = getValue();
          return <span className={`coverage-status ${radarStageClass(value)}`}>{value}</span>;
        },
      }),
      radarIndustryColumnHelper.accessor((row) => Math.round(Math.max(radarPacketVisualScores(row).growth, radarPacketVisualScores(row).momentum)), {
        id: "growth",
        header: "增长",
      }),
      radarIndustryColumnHelper.accessor((row) => {
        const scores = radarPacketVisualScores(row);
        return Math.round(Math.max(scores.bubbleRisk, scores.declineRisk, scores.valuationRisk));
      }, {
        id: "risk",
        header: "风险",
      }),
      radarIndustryColumnHelper.accessor("sourceCount", {
        id: "sourceCount",
        header: "全量扫描证据",
        cell: ({ getValue }) => `${getValue()} 条`,
      }),
      radarIndustryColumnHelper.accessor((row) => radarPacketGapExplanation(row).compact, {
        id: "gap",
        header: "缺口",
      }),
      radarIndustryColumnHelper.accessor((row) => radarPacketPriority(row), {
        id: "priority",
        header: "优先级",
      }),
    ],
    [],
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table owns its own mutable table API; row rendering remains local to this component.
  const table = useReactTable({
    data: visibleRows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: { columnVisibility: { priority: false } },
  });
  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => 76,
    overscan: 6,
  });
  const stages = ["all", "扎实增长", "即将增长", "泡沫风险", "衰退", "平稳现金流", "继续观察", "证据不足"];
  return (
    <section className="radar-section radar-industry-table-section" id="radar-all-industries">
      <header className="radar-source-header">
        <div>
          <h3>全行业扫描表</h3>
          <p>后台全量扫描的细分产业都在这里；正式结论只代表证据强度达到门槛。</p>
        </div>
        <div className="radar-source-filters" aria-label="全行业筛选">
          <label htmlFor="radar-industry-search">搜索</label>
          <input id="radar-industry-search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="行业、主题、分组" />
          <label htmlFor="radar-stage-filter">阶段</label>
          <select id="radar-stage-filter" value={stage} onChange={(event) => setStage(event.currentTarget.value)}>
            {stages.map((item) => (
              <option key={item} value={item}>{item === "all" ? "全部阶段" : item}</option>
            ))}
          </select>
        </div>
      </header>
      <div className="radar-industry-table-summary">
        <span>
          显示 {visibleRows.length} / {rows.length} 个细分产业
        </span>
        <strong>{hasActiveFilter ? "当前筛选已显示全部匹配项" : expanded ? "已展开完整列表" : "默认只看前 10 条，避免页面过长"}</strong>
        {!hasActiveFilter && rows.length > defaultVisibleCount ? (
          <button type="button" className="ghost-button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起列表" : `展开全部 ${Math.min(rows.length, 120)} 项`}
          </button>
        ) : null}
      </div>
      <div className="radar-industry-table" role="table" aria-label="全行业扫描表">
        {table.getHeaderGroups().map((headerGroup) => (
          <div role="row" className="radar-industry-row is-head" key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <button
                key={header.id}
                type="button"
                className={header.column.getCanSort() ? "sortable-table-head" : ""}
                onClick={header.column.getToggleSortingHandler()}
                role="columnheader"
              >
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                {header.column.getIsSorted() === "asc" ? " ↑" : header.column.getIsSorted() === "desc" ? " ↓" : ""}
              </button>
            ))}
          </div>
        ))}
        <div ref={tableScrollRef} className="radar-industry-scroll" tabIndex={0} aria-label="全行业扫描表，可滚动浏览">
          <div className="radar-industry-virtual-space" style={{ height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = tableRows[virtualRow.index];
              const packet = row.original;
              return (
                <button
                  key={row.id}
                  type="button"
                  role="row"
                  className="radar-industry-row"
                  onClick={() => onSelectIndustry(packet.industry)}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <span key={cell.id} title={cell.column.id === "gap" ? `${radarPacketGapExplanation(packet).reason}${radarPacketGapExplanation(packet).nextEvidence}` : undefined}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </span>
                  ))}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

const radarIndustryColumnHelper = createColumnHelper<RadarIndustryPacket>();

function RadarIndustryDrawer({ packet, items, sourceMap, onClose }: { packet: RadarIndustryPacket; items: RadarItem[]; sourceMap: Map<string, RadarCitation>; onClose: () => void }) {
  const scores = radarPacketVisualScores(packet);
  const relatedItems = items.filter((item) => item.industries.includes(packet.industry) || item.title.includes(packet.industry) || packet.industry.includes(item.title));
  const sources = uniqueStrings(relatedItems.flatMap((item) => item.sourceIds ?? [])).map((id) => sourceMap.get(id)).filter((source): source is RadarCitation => Boolean(source));
  const trend = packet.scoreTrend?.length ? packet.scoreTrend : [
    { runTime: "上次", growth: Math.max(0, scores.growth - 8), evidence: Math.max(0, scores.evidence - 6), risk: Math.max(0, Math.max(scores.bubbleRisk, scores.declineRisk) - 5), stage: packet.stage },
    { runTime: "本次", growth: scores.growth, evidence: scores.evidence, risk: Math.max(scores.bubbleRisk, scores.declineRisk), stage: packet.stage },
  ];
  return (
    <div className="radar-drawer-backdrop" role="presentation" onClick={onClose}>
      <aside className="radar-drawer" role="dialog" aria-modal="true" aria-label={`${packet.industry} 产业详情`} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className={`coverage-status ${radarStageClass(packet.stage)}`}>{packet.stage ?? "证据不足"}</span>
            <h3>{packet.industry}</h3>
            <p>{packet.group} · {packet.sourceCount} 条证据 · {packet.evidenceTypes.map(radarEvidenceLabel).join("、") || "线索"}</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>关闭</button>
        </header>
        <div className="radar-drawer-score-grid">
          <RadarScoreDial label="增长" value={Math.max(scores.growth, scores.momentum)} />
          <RadarScoreDial label="证据" value={scores.evidence} />
          <RadarScoreDial label="风险" value={Math.max(scores.bubbleRisk, scores.declineRisk, scores.valuationRisk)} />
          <RadarScoreDial label="变化" value={scores.change} />
        </div>
        <section className="radar-drawer-panel">
          <h4>趋势</h4>
          <div className="radar-mini-trend">
            {trend.map((point) => (
              <div key={point.runTime}>
                <span>{point.runTime}</span>
                <i style={{ height: `${Math.max(4, point.growth)}%` }} title={`增长 ${Math.round(point.growth)}`} />
                <i style={{ height: `${Math.max(4, point.evidence)}%` }} title={`证据 ${Math.round(point.evidence)}`} />
                <i style={{ height: `${Math.max(4, point.risk)}%` }} title={`风险 ${Math.round(point.risk)}`} />
              </div>
            ))}
          </div>
        </section>
        <section className="radar-drawer-panel">
          <h4>正式结论资格</h4>
          <p>{packet.conclusionEligibility === "eligible" ? "已达到硬证据和交叉验证门槛。" : radarPacketGapExplanation(packet).reason}</p>
          <p className="muted">下一步证据：{radarPacketGapExplanation(packet).nextEvidence}</p>
          {packet.evidenceGaps?.length ? <ul>{listItems(packet.evidenceGaps)}</ul> : null}
        </section>
        {relatedItems.length ? (
          <section className="radar-drawer-panel">
            <h4>关联结论</h4>
            {relatedItems.slice(0, 4).map((item) => (
              <article key={item.title}>
                <strong>{item.title}</strong>
                <p>{item.thesis}</p>
                <small>{item.companies.join("、") || "代表公司待确认"}</small>
              </article>
            ))}
          </section>
        ) : null}
        <section className="radar-drawer-panel">
          <h4>证据时间线</h4>
          {sources.length ? <RadarCitationCards sourceIds={sources.map((source) => source.id)} sourceMap={sourceMap} /> : <p className="muted">暂无绑定到正式结论的证据卡片，可在证据库中继续筛选。</p>}
        </section>
      </aside>
    </div>
  );
}

function RadarScoreDial({ label, value }: { label: string; value: number }) {
  const score = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="radar-score-dial" style={{ "--score": `${score * 3.6}deg` } as CSSProperties}>
      <strong>{score}</strong>
      <span>{label}</span>
    </div>
  );
}

function RadarDiagnosticsPanel({ diagnostics }: { diagnostics: RadarDiagnostics }) {
  return (
    <details className="radar-diagnostics">
      <summary>管理员诊断</summary>
      <dl>
        <dt>GitHub Job</dt>
        <dd>{diagnostics.jobStatus || "无"}</dd>
        <dt>Job 信息</dt>
        <dd>{diagnostics.jobMessage || "无"}</dd>
        <dt>证据包</dt>
        <dd>{diagnostics.evidenceGeneratedAt || "未知"} / {diagnostics.evidenceHash || "无 hash"}</dd>
        <dt>证据年龄</dt>
        <dd>{typeof diagnostics.evidenceAgeHours === "number" ? `${diagnostics.evidenceAgeHours} 小时` : "未知"}</dd>
        <dt>最新报告</dt>
        <dd>{diagnostics.latestRadarGeneratedAt || "无"}</dd>
        {diagnostics.tokenUsage ? (
          <>
            <dt>DeepSeek Token</dt>
            <dd>
              命中 {formatTokens(diagnostics.tokenUsage.promptCacheHitTokens)} / 未命中 {formatTokens(diagnostics.tokenUsage.promptCacheMissTokens)} / 输出{" "}
              {formatTokens(diagnostics.tokenUsage.completionTokens)}
              {typeof diagnostics.tokenUsage.cacheHitRate === "number" ? ` / 命中率 ${(diagnostics.tokenUsage.cacheHitRate * 100).toFixed(1)}%` : ""}
            </dd>
          </>
        ) : null}
      </dl>
    </details>
  );
}

function RadarItemSection({ id, title, items, sourceMap }: { id: string; title: string; items: RadarItem[]; sourceMap: Map<string, RadarCitation> }) {
  const sortedItems = sortRadarItems(items);
  return (
    <section className="radar-section" id={id}>
      <header className="radar-section-head">
        <div>
          <h3>{title}</h3>
          <p>{radarSectionHint(id)}</p>
        </div>
        <span>{sortedItems.length} 条</span>
      </header>
      <div className="radar-grid">
        {sortedItems.length ? (
          sortedItems.map((item) => <RadarCard key={`${title}-${item.title}-${item.companies.join(",")}`} item={item} sourceMap={sourceMap} />)
        ) : (
          <p className="muted">本轮扫描未给出足够稳定的结论。</p>
        )}
      </div>
    </section>
  );
}

function radarSectionHint(id: string) {
  return (
    {
      "radar-growth": "优先看硬数据、财报和多源验证支撑的增长。",
      "radar-sustainability": "区分短期催化、中期景气和长期护城河。",
      "radar-bubble": "关注股价透支、产能过剩和情绪退潮信号。",
      "radar-upcoming": "跟踪价格、销量、订单或政策拐点是否启动。",
      "radar-decline": "识别需求萎缩、技术替代和产能过剩风险。",
    }[id] ?? "按证据强度和优先级排序。"
  );
}

function RadarEvidenceOverview({
  breakdown,
  confidenceSummary,
  changeLog,
  softCoverage,
  coverageReview,
}: {
  breakdown?: RadarEvidenceBreakdown;
  confidenceSummary?: string;
  changeLog?: string[];
  softCoverage?: RadarCoverageItem[];
  coverageReview?: RadarCoverageReview[];
}) {
  const entries = radarEvidenceEntries(breakdown);
  return (
    <section className="radar-summary radar-evidence-panel" id="radar-evidence-overview">
      <div>
        <h3>证据权重与稳定性</h3>
        <p>{confidenceSummary || "本轮扫描未返回置信度说明。"}</p>
      </div>
      <div className="evidence-tier-grid">
        {entries.map(([type, count]) => (
          <span key={type}>
            <strong>{radarEvidenceLabel(type)}</strong>
            {count} 条
          </span>
        ))}
      </div>
      <RadarEvidenceBars breakdown={breakdown} />
      {changeLog?.length ? (
        <div className="radar-change-log">
          <strong>变化说明</strong>
          <ul>{listItems(changeLog)}</ul>
        </div>
      ) : null}
      {softCoverage?.length ? <RadarCoverageOverview coverage={softCoverage} /> : null}
      {coverageReview?.length ? <RadarCoverageReviewPanel coverageReview={coverageReview} /> : null}
    </section>
  );
}

function RadarEvidenceBars({ breakdown }: { breakdown?: RadarEvidenceBreakdown }) {
  const entries = radarEvidenceEntries(breakdown);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!total) return null;
  return (
    <div className="radar-evidence-bars" aria-label="证据类型占比">
      <div>
        {entries.map(([type, count]) => (
          <span key={type} className={`evidence-bar-${type}`} style={{ width: `${(count / total) * 100}%` }} title={`${radarEvidenceLabel(type)} ${count} 条`} />
        ))}
      </div>
      <p>{entries.map(([type, count]) => `${radarEvidenceLabel(type)} ${Math.round((count / total) * 100)}%`).join(" · ")}</p>
    </div>
  );
}

function RadarCoverageOverview({ coverage }: { coverage: RadarCoverageItem[] }) {
  return (
    <div className="radar-coverage">
      <strong>软覆盖方向</strong>
      <div>
        {coverage.slice(0, 10).map((item) => (
          <span key={item.label}>
            {item.label}
            <small>{item.sourceCount} 条</small>
          </span>
        ))}
      </div>
    </div>
  );
}

function RadarCoverageReviewPanel({ coverageReview }: { coverageReview: RadarCoverageReview[] }) {
  const labels = {
    formal: "已成结论",
    watched: "继续观察",
    insufficient: "证据不足",
  };
  return (
    <div className="radar-coverage-review">
      <strong>覆盖复核</strong>
      <div>
        {coverageReview.slice(0, 12).map((item) => (
          <article key={item.label}>
            <span className={`coverage-status coverage-${item.status}`}>{labels[item.status]}</span>
            <h4>{item.label}</h4>
            <p>{item.note}</p>
            <small>
              {item.sourceCount} 条 / {item.evidenceTypes.map(radarEvidenceLabel).join("、") || "线索"}
            </small>
          </article>
        ))}
      </div>
    </div>
  );
}

function RadarCard({ item, sourceMap }: { item: RadarItem; sourceMap: Map<string, RadarCitation> }) {
  const sourceIds = item.sourceIds ?? [];
  const insights = radarCardInsights(item);
  return (
    <article className={`radar-card radar-risk-${item.riskLevel} radar-strength-${item.conclusionStrength}`}>
      <header>
        <div>
          <span className="radar-stage-label">{item.conclusionStrength}</span>
          <h4>{item.title || "待确认主题"}</h4>
          <p>{item.thesis || "模型未提供完整分析。"}</p>
        </div>
        <div className="radar-card-pills">
          <span className={`risk-pill risk-${item.riskLevel}`}>风险 {item.riskLevel}</span>
          <span className={`risk-pill confidence-${item.confidence || "中"}`}>置信 {item.confidence || "中"}</span>
        </div>
      </header>
      <div className="radar-card-meters">
        <RadarConfidenceMeter confidence={item.confidence || "中"} />
        {item.driverTags?.length ? (
          <div className="radar-driver-tags" aria-label="驱动因素标签">
            {item.driverTags.slice(0, 5).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        ) : null}
      </div>
      <RadarCardMiniCharts item={item} />
      <dl>
        <dt>产业</dt>
        <dd>{item.industries.join("、") || "待确认"}</dd>
        <dt>公司</dt>
        <dd>{item.companies.join("、") || "待确认"}</dd>
        <dt>持续性</dt>
        <dd>{item.durability}</dd>
        <dt>证据</dt>
        <dd>
          {item.supportingSourceCount ? `核心结论证据 ${item.supportingSourceCount} 条` : "核心结论证据待确认"}
          {item.evidenceTypes?.length ? ` / ${item.evidenceTypes.map(radarEvidenceLabel).join("、")}` : ""}
        </dd>
      </dl>
      <div className="radar-card-insights" aria-label="结论复核">
        <section>
          <span>结论强度</span>
          <strong>{insights.strengthLabel}</strong>
          <small>{insights.strengthDetail}</small>
        </section>
        {insights.evidenceGaps.length ? (
          <section>
            <span>证据缺口</span>
            <ul>{listItems(insights.evidenceGaps.slice(0, 3))}</ul>
          </section>
        ) : null}
        <section>
          <span>反证信号</span>
          <ul>{listItems(insights.counterSignals.slice(0, 3))}</ul>
        </section>
        <section>
          <span>正向确认信号</span>
          <ul>{listItems(insights.confirmationSignals.slice(0, 3))}</ul>
        </section>
      </div>
      <p className="radar-change-reason">
        <strong>上次 vs 本次</strong>
        {insights.changeExplanation}
      </p>
      <details className="radar-card-details">
        <summary>展开证据、驱动和拐点</summary>
        <div className="radar-columns">
          <div>
            <strong>驱动因素</strong>
            <ul>{listItems(item.drivers)}</ul>
          </div>
          <div>
            <strong>模型证据</strong>
            <ul>{listItems(item.evidence)}</ul>
          </div>
          <div>
            <strong>正向确认信号</strong>
            <ul>{listItems(insights.confirmationSignals)}</ul>
          </div>
          <div>
            <strong>其他拐点</strong>
            <ul>{listItems(item.turningPoints)}</ul>
          </div>
        </div>
        <RadarCitationCards sourceIds={sourceIds} sourceMap={sourceMap} />
      </details>
    </article>
  );
}

function RadarCardMiniCharts({ item }: { item: RadarItem }) {
  const metrics = radarCardChartMetrics(item);
  return (
    <div className="radar-card-mini-charts" aria-label="卡片关键指标">
      {metrics.map((metric) => (
        <div key={metric.label}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
          <i style={{ width: `${metric.value}%` }} />
        </div>
      ))}
    </div>
  );
}

function RadarConfidenceMeter({ confidence }: { confidence: "低" | "中" | "高" }) {
  const score = { 低: 1, 中: 2, 高: 3 }[confidence];
  return (
    <div className="radar-confidence-meter" aria-label={`置信度 ${confidence}`}>
      <span>置信度</span>
      <div>
        {[1, 2, 3].map((level) => (
          <i key={level} className={level <= score ? "active" : ""} />
        ))}
      </div>
      <strong>{confidence}</strong>
    </div>
  );
}

function RadarCitationCards({ sourceIds, sourceMap }: { sourceIds: string[]; sourceMap: Map<string, RadarCitation> }) {
  const sources = sourceIds.map((id) => sourceMap.get(id)).filter((source): source is RadarCitation => Boolean(source));
  return (
    <div className="radar-citation-block">
      <strong>引用证据</strong>
      <div className="radar-citation-grid">
        {sources.length ? sources.map((source) => <RadarCitationCard key={source.id} source={source} />) : <p className="muted">本条结论暂未绑定公开来源编号。</p>}
      </div>
    </div>
  );
}

function RadarCitationCard({ source, context }: { source: RadarCitation; context?: { industries: string[]; itemTitles: string[] } }) {
  const sourceKind = source.url ? "可点击来源" : "结构化来源无原文链接";
  const body = (
    <>
      <span>
        {source.id} / {radarEvidenceLabel(source.sourceType)}
      </span>
      <strong>{source.title}</strong>
      <small>{source.source}{source.publishedAt ? ` · ${formatDateTime(source.publishedAt)}` : ""} · {sourceKind}</small>
      {source.summary ? <p>{source.summary}</p> : null}
      {context?.industries.length || context?.itemTitles.length ? (
        <small className="radar-citation-context">
          关联：{[...context.industries, ...context.itemTitles].slice(0, 4).join("、")}
        </small>
      ) : null}
    </>
  );
  return source.url ? (
    <a href={source.url} target="_blank" rel="noreferrer">
      {body}
    </a>
  ) : (
    <article>{body}</article>
  );
}

function RadarListSection({ id, title, lists }: { id: string; title: string; lists: RadarList[] }) {
  return (
    <section className="radar-section" id={id}>
      <h3>{title}</h3>
      <div className="radar-list-grid">
        {lists.length ? (
          lists.map((list) => (
            <article key={`${title}-${list.label}`} className="radar-list-card">
              <h4>{list.label}</h4>
              <p>{list.note}</p>
              <div>{list.companies.map((company) => <span key={company}>{company}</span>)}</div>
            </article>
          ))
        ) : (
          <p className="muted">本轮扫描未给出代表公司清单。</p>
        )}
      </div>
    </section>
  );
}

function RadarSourceLibrary({ sources, items }: { sources: RadarCitation[]; items: RadarItem[] }) {
  const [industryFilter, setIndustryFilter] = useState("all");
  const [evidenceTypeFilter, setEvidenceTypeFilter] = useState<RadarEvidenceType | "all">("all");
  const [expanded, setExpanded] = useState(false);
  const library = useMemo(() => buildRadarSourceLibrary(sources, items, { industry: industryFilter, evidenceType: evidenceTypeFilter }), [evidenceTypeFilter, industryFilter, items, sources]);
  const hasActiveFilter = industryFilter !== "all" || evidenceTypeFilter !== "all";
  const visibleEntries = hasActiveFilter || expanded ? library.entries : library.entries.slice(0, 30);
  if (!sources.length) return null;
  return (
    <section className="radar-section" id="radar-sources">
      <header className="radar-source-header">
        <div>
          <h3>证据引用库</h3>
          <p>
            已显示 {visibleEntries.length} / {library.entries.length} 条匹配证据，来源总数 {sources.length} 条；可按行业和证据类型快速收敛。
          </p>
        </div>
        <div className="radar-source-filters" aria-label="证据筛选">
          <label htmlFor="radar-source-industry">行业</label>
          <select id="radar-source-industry" value={industryFilter} onChange={(event) => setIndustryFilter(event.currentTarget.value)}>
            <option value="all">全部行业</option>
            {library.industries.map((industry) => (
              <option key={industry} value={industry}>
                {industry}
              </option>
            ))}
          </select>
          <label htmlFor="radar-source-type">证据类型</label>
          <select id="radar-source-type" value={evidenceTypeFilter} onChange={(event) => setEvidenceTypeFilter(event.currentTarget.value as RadarEvidenceType | "all")}>
            <option value="all">全部类型</option>
            {library.evidenceTypes.map((type) => (
              <option key={type} value={type}>
                {radarEvidenceLabel(type)}
              </option>
            ))}
          </select>
        </div>
      </header>
      {!hasActiveFilter && library.entries.length > 30 ? (
        <div className="radar-industry-table-summary">
          <span>默认展示前 30 条核心证据</span>
          <button type="button" className="ghost-button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起证据库" : `展开全部 ${library.entries.length} 条来源`}
          </button>
        </div>
      ) : null}
      <div className="radar-source-library">
        {library.entries.length ? (
          visibleEntries.map((entry) => <RadarCitationCard key={entry.source.id} source={entry.source} context={{ industries: entry.industries, itemTitles: entry.itemTitles }} />)
        ) : (
          <p className="muted">当前筛选没有匹配证据，请放宽行业或证据类型。</p>
        )}
      </div>
    </section>
  );
}

function radarStageBuckets(packets: RadarIndustryPacket[]) {
  const order = ["扎实增长", "即将增长", "泡沫风险", "衰退", "平稳现金流", "继续观察", "证据不足"];
  const total = Math.max(1, packets.length);
  return order.map((stage) => {
    const items = packets.filter((packet) => (packet.stage ?? "证据不足") === stage).sort((left, right) => radarPacketPriority(right) - radarPacketPriority(left));
    return { stage, items, percent: Math.max(4, (items.length / total) * 100) };
  });
}

function buildRadarVisualPackets(radar: RadarScan): RadarIndustryPacket[] {
  const staged = new Map<string, RadarIndustryPacket>();
  const addPacket = (packet: RadarIndustryPacket) => {
    const existing = staged.get(packet.industry);
    if (!existing || radarPacketPriority(packet) > radarPacketPriority(existing)) staged.set(packet.industry, packet);
  };
  for (const packet of radar.industryPackets ?? []) addPacket({ ...packet, stage: packet.stage ?? inferPacketStage(packet), scores: packet.scores ?? visualScoresForPacket(packet) });
  for (const [stage, items] of [
    ["扎实增长", radar.solidGrowth],
    ["继续观察", radar.sustainability],
    ["泡沫风险", radar.bubbleRisks],
    ["即将增长", radar.upcomingGrowth],
    ["衰退", radar.decliningIndustries],
  ] as const) {
    for (const item of items) {
      const itemStage = radarItemVisualStage(item, stage);
      for (const industry of item.industries.length ? item.industries : [item.title]) {
        addPacket({
          group: itemStage,
          industry,
          status: "scanned",
          changeStatus: item.changeReason?.includes("复用") ? "unchanged" : "changed",
          stage: itemStage,
          evidenceHash: `${itemStage}-${industry}`,
          sourceCount: item.supportingSourceCount ?? item.sourceIds?.length ?? 0,
          evidenceTypes: item.evidenceTypes ?? [],
          signalTypes: item.driverTags ?? [],
          evidenceGaps: item.evidenceGaps ?? [],
          themes: item.driverTags,
          scores: visualScoresForRadarItem(item, itemStage),
        });
      }
    }
  }
  return [...staged.values()].sort((left, right) => radarPacketPriority(right) - radarPacketPriority(left));
}

function radarItemVisualStage(item: RadarItem, defaultStage: RadarIndustryStage): RadarIndustryStage {
  const text = [item.title, item.thesis, ...item.industries, ...item.drivers, ...item.driverTags].join(" ");
  if (defaultStage === "继续观察" && /平稳现金流|高股息|分红|公用事业|电力|水电|高速公路|电信运营|运营商|银行|保险/.test(text) && !/泡沫|衰退|严重下滑|流动性风险/.test(text)) {
    return "平稳现金流";
  }
  return defaultStage;
}

function inferPacketStage(packet: RadarIndustryPacket) {
  const scores = packet.scores ?? visualScoresForPacket(packet);
  if (packet.sourceCount <= 0 || scores.evidence < 30) return "证据不足";
  if (scores.declineRisk >= 62) return "衰退";
  if (scores.bubbleRisk >= 62) return "泡沫风险";
  if (/现金流|高股息|公用事业|银行|电信|高速|水电/.test(`${packet.group} ${packet.industry}`)) return "平稳现金流";
  if (scores.growth >= 68 && Math.max(scores.bubbleRisk, scores.declineRisk) < 58) return "扎实增长";
  if (scores.growth >= 50 || scores.momentum >= 50) return "继续观察";
  return "证据不足";
}

function visualScoresForPacket(packet: RadarIndustryPacket) {
  const evidence = Math.min(100, (packet.sourceCount ?? 0) * 9 + (packet.evidenceTypes?.length ?? 0) * 12 - (packet.evidenceGaps?.length ?? 0) * 8);
  const growth = Math.min(100, 28 + evidence * 0.45 + (packet.signalTypes?.length ?? 0) * 7);
  const riskText = `${packet.group} ${packet.industry} ${(packet.evidenceGaps ?? []).join(" ")}`;
  const bubbleRisk = /泡沫|机器人|低空|AI应用|商业航天/.test(riskText) ? 72 : 24;
  const declineRisk = /衰退|过剩|地产|光伏|传统/.test(riskText) ? 72 : 24;
  return { growth, momentum: growth, evidence, valuationRisk: bubbleRisk, bubbleRisk, declineRisk, confidence: Math.max(0, evidence - (packet.evidenceGaps?.length ?? 0) * 6), change: packet.changeStatus === "unchanged" ? 32 : 64 };
}

function visualScoresForRadarItem(item: RadarItem, stage: string) {
  const evidence = Math.min(100, (item.supportingSourceCount ?? item.sourceIds?.length ?? 0) * 18 + (item.evidenceTypes?.length ?? 0) * 10);
  const confidence = { 低: 35, 中: 62, 高: 88 }[item.confidence || "中"];
  const risk = { 低: 28, 中: 58, 高: 88 }[item.riskLevel];
  const growth = stage === "扎实增长" ? 82 : stage === "即将增长" ? 72 : stage === "衰退" ? 22 : stage === "泡沫风险" ? 70 : 54;
  const declineRisk = stage === "衰退" ? 88 : Math.max(18, risk - 20);
  const bubbleRisk = stage === "泡沫风险" ? 88 : risk;
  return { growth, momentum: growth, evidence, valuationRisk: risk, bubbleRisk, declineRisk, confidence, change: item.changeReason?.includes("维持") ? 42 : 68 };
}

function radarPacketPriority(packet: RadarIndustryPacket) {
  const scores = radarPacketVisualScores(packet);
  return Math.max(scores.growth, scores.momentum) * 2 + scores.evidence + Math.max(scores.bubbleRisk, scores.declineRisk) + Math.sqrt(packet.sourceCount ?? 0) * 10;
}

function topRadarPackets(packets: RadarIndustryPacket[], score: (packet: RadarIndustryPacket) => number) {
  const strongPackets = packets.filter((packet) => !isWeakRadarPacket(packet));
  const source = strongPackets.length ? strongPackets : packets;
  return [...source].sort((left, right) => score(right) - score(left)).slice(0, 20);
}

function radarPacketMetric(packet: RadarIndustryPacket, metric: string) {
  const value = radarPacketMetricValue(packet, metric);
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

function radarPacketMetricValue(packet: RadarIndustryPacket, metric: string) {
  const scores = radarPacketVisualScores(packet);
  if (metric === "risk") return Math.round(Math.max(scores.bubbleRisk, scores.declineRisk) * 0.72 + scores.valuationRisk * 0.18 + scores.evidence * 0.1);
  if (metric === "evidence") return Math.round(scores.evidence * 0.72 + scores.confidence * 0.2 + Math.min(12, Math.sqrt(packet.sourceCount || 0) * 2));
  if (metric === "change") return Math.round(scores.change * 0.74 + Math.max(scores.growth, scores.momentum) * 0.16 + scores.evidence * 0.1);
  const riskDrag = Math.max(scores.bubbleRisk, scores.declineRisk) * 0.22;
  return Math.max(0, Math.round(Math.max(scores.growth, scores.momentum) * 0.52 + scores.evidence * 0.28 + scores.confidence * 0.2 - riskDrag));
}

function radarPacketVisualScores(packet: RadarIndustryPacket) {
  const raw = packet.scores ?? emptyRadarScores();
  const sourceEvidence = Math.min(96, 18 + Math.sqrt(packet.sourceCount || 0) * 10 + (packet.evidenceTypes?.length ?? 0) * 8 - (packet.evidenceGaps?.length ?? 0) * 7);
  const evidence = Math.round(Math.min(raw.evidence || sourceEvidence, sourceEvidence));
  const confidence = Math.round(Math.max(0, Math.min(96, (raw.confidence || evidence) * 0.55 + evidence * 0.45 - (packet.evidenceGaps?.length ?? 0) * 3)));
  const rawGrowth = Math.max(raw.growth, raw.momentum);
  const stageGrowth =
    packet.stage === "扎实增长" ? 78 : packet.stage === "即将增长" ? 70 : packet.stage === "泡沫风险" ? 64 : packet.stage === "衰退" ? 26 : packet.stage === "平稳现金流" ? 42 : packet.stage === "继续观察" ? 48 : 24;
  const growth = Math.round(Math.max(6, Math.min(96, rawGrowth * 0.42 + stageGrowth * 0.38 + confidence * 0.2 - (packet.evidenceGaps?.length ?? 0) * 4)));
  const stageRisk = packet.stage === "衰退" ? 84 : packet.stage === "泡沫风险" ? 88 : packet.stage === "证据不足" ? 44 : packet.stage === "继续观察" ? 46 : packet.stage === "平稳现金流" ? 24 : 38;
  const rawRisk = Math.max(raw.bubbleRisk, raw.declineRisk, raw.valuationRisk);
  const combinedRisk = Math.round(Math.max(8, Math.min(96, rawRisk * 0.5 + stageRisk * 0.5)));
  return {
    growth,
    momentum: Math.round(Math.max(growth, raw.momentum * 0.45 + growth * 0.55)),
    evidence,
    valuationRisk: Math.round(raw.valuationRisk * 0.45 + combinedRisk * 0.55),
    bubbleRisk: packet.stage === "泡沫风险" ? Math.max(78, combinedRisk) : Math.round(raw.bubbleRisk * 0.45 + combinedRisk * 0.55),
    declineRisk: packet.stage === "衰退" ? Math.max(78, combinedRisk) : Math.round(raw.declineRisk * 0.45 + combinedRisk * 0.55),
    confidence,
    change: Math.round(Math.max(10, Math.min(96, raw.change * 0.65 + (packet.changeStatus === "changed" ? 64 : packet.changeStatus === "new" ? 72 : 34) * 0.35))),
  };
}

function emptyRadarScores() {
  return { growth: 0, momentum: 0, evidence: 0, valuationRisk: 0, bubbleRisk: 0, declineRisk: 0, confidence: 0, change: 0 };
}

function radarStageClass(stage?: string) {
  return (
    {
      扎实增长: "stage-growth",
      即将增长: "stage-upcoming",
      泡沫风险: "stage-bubble",
      衰退: "stage-decline",
      平稳现金流: "stage-stable",
      继续观察: "stage-watch",
      证据不足: "stage-weak",
    }[stage || "证据不足"] ?? "stage-weak"
  );
}

function radarCardChartMetrics(item: RadarItem) {
  const confidence = { 低: 35, 中: 62, 高: 88 }[item.confidence || "中"];
  const risk = { 低: 28, 中: 58, 高: 88 }[item.riskLevel];
  const evidence = Math.min(100, (item.supportingSourceCount ?? item.sourceIds?.length ?? 0) * 18 + (item.evidenceTypes?.length ?? 0) * 10);
  const driver = Math.min(100, (item.driverTags?.length ?? 0) * 16 + (item.drivers?.length ?? 0) * 5);
  return [
    { label: "证据", value: evidence },
    { label: "驱动", value: driver },
    { label: "置信", value: confidence },
    { label: "风险", value: risk },
  ];
}

function allRadarItems(radar: RadarScan) {
  return [
    ...(radar.solidGrowth ?? []),
    ...(radar.sustainability ?? []),
    ...(radar.bubbleRisks ?? []),
    ...(radar.upcomingGrowth ?? []),
    ...(radar.decliningIndustries ?? []),
  ];
}

function highestPriorityRadarItem(items: RadarItem[]) {
  return sortRadarItems(items)[0];
}

function sortRadarItems(items: RadarItem[]) {
  return [...items].sort((left, right) => radarItemPriority(right) - radarItemPriority(left));
}

function radarItemPriority(item: RadarItem) {
  const confidence = { 高: 3, 中: 2, 低: 1 }[item.confidence || "中"];
  const risk = { 高: 3, 中: 2, 低: 1 }[item.riskLevel];
  const evidence = item.supportingSourceCount ?? item.sourceIds?.length ?? 0;
  const longTerm = item.durability === "长期" ? 2 : item.durability === "中期" ? 1 : 0;
  return confidence * 20 + risk * 10 + evidence + longTerm;
}

function listItems(items: string[]) {
  const values = items.length ? items : ["数据不足，需要继续核验。"];
  return values.map((item) => <li key={item}>{item}</li>);
}

function uniqueStrings(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

function radarEvidenceEntries(breakdown?: RadarEvidenceBreakdown): Array<[RadarEvidenceType, number]> {
  const order: RadarEvidenceType[] = ["hard_data", "official", "announcement", "market", "news", "research"];
  return order.map((type): [RadarEvidenceType, number] => [type, breakdown?.[type] ?? 0]).filter(([, count]) => count > 0);
}

function radarEvidenceLabel(type: RadarEvidenceType) {
  return {
    hard_data: "硬数据",
    official: "官方/协会",
    announcement: "公告/财报",
    market: "市场数据",
    news: "新闻线索",
    research: "研报摘要",
  }[type];
}

function formatCacheTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatDateTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value || "待验证";
  return new Date(time).toLocaleString("zh-CN", { hour12: false });
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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default App;
