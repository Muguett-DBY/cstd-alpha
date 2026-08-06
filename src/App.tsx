import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { addWatchlistItem, checkSession, fetchChartData, fetchRadarScan, fetchReportLibraryRecord, fetchWatchlist, generateReport, login, logout, refreshRadarScan, REPORT_CANCELLED_MESSAGE, searchCompanies, type ReportProgress } from "./api";
import { ErrorBoundary } from "./ErrorBoundary";
import "./App.css";
import type { RadarPhase } from "./RadarView";
import { ProgressPanel } from "./ProgressPanel";
import { CandidateModal } from "./CandidateModal";
import { displayExchange } from "./company-utils";
import type { ChartPhase } from "./ReportCharts";
const OpportunityDashboard = lazy(() => import("./OpportunityDashboard").then((module) => ({ default: module.OpportunityDashboard })));
import { ToastContainer } from "./Toast";
import { showToast } from "./toast-state";
import { ThemeControl } from "./ThemeControl";
import { useThemePreference } from "./theme";
import type { RankingMarket } from "./RankingView";
import { usePwaInstallPrompt } from "./usePwaInstallPrompt";
import { canPersistLocalReportStorage, clearLocalReportStorage, loadCachedChart, loadCachedReport, loadLastReportEntry, saveCachedChart, saveCachedReport, saveLastReport } from "./storage";
import { canPersistRecentSearches, loadRecentSearches, rememberRecentSearch } from "./recent-searches";
import { canPersistImportedRankingReports, clearImportedRankingReports } from "./ranking-storage";
import { radarRefreshFallbackMessage, resolveRadarResultState } from "./radar-ui";
import { describeAppViewLoading, type AppViewLoadingTarget } from "./app-view-loading";
import { resolveAppViewPresentation } from "./app-view-presentation";
import { hasRecentPreloadRecovery, PRELOAD_RECOVERY_NOTICE } from "./preload-recovery";
import { watchlistAddToastMessage } from "./watchlist-add-status";
import { resolveWatchlistMembership, type WatchlistMembership } from "./watchlist-membership";
import type { ChartBundle, PriceMode } from "./shared/chart";
import { companyCandidateFromRanking, type RankingEntry } from "./shared/ranking";
import type { RadarAnalysisJob, RadarDiagnostics, RadarScan } from "./shared/radar";
import type { CompanyCandidate, InvestmentReport, ReportGenerationMetrics } from "./shared/report";
import type { UserSession, WatchlistRankingEntry } from "./shared/user-research";

type Phase = "idle" | "searching" | "selecting" | "generating" | "ready" | "error";
type AppView = AppViewLoadingTarget;

export const DEFAULT_APP_VIEW: AppView = "opportunities";
export const LOCAL_PERSISTENCE_UNAVAILABLE_NOTICE = "本地缓存不可用；最近搜索、报告缓存、导入榜单、最近模板和新闻缓存只在当前页面生效。";
const ResearchWorkspace = lazy(() => import("./ResearchWorkspace").then((module) => ({ default: module.ResearchWorkspace })));
const MarketWorkspace = lazy(() => import("./MarketWorkspace").then((module) => ({ default: module.MarketWorkspace })));
const ValuationLabView = lazy(() => import("./ValuationLabView").then((module) => ({ default: module.ValuationLabView })));
const RadarView = lazy(() => import("./RadarView").then((module) => ({ default: module.RadarView })));
const ReportView = lazy(() => import("./ReportView").then((module) => ({ default: module.ReportView })));
const ChartDashboard = lazy(() => import("./ReportCharts").then((module) => ({ default: module.ChartDashboard })));
const RankingView = lazy(() => import("./RankingView").then((module) => ({ default: module.RankingView })));
const WatchlistRankingView = lazy(() => import("./WatchlistRankingView").then((module) => ({ default: module.WatchlistRankingView })));
const MyResearchView = lazy(() => import("./MyResearchView").then((module) => ({ default: module.MyResearchView })));
const AssistantView = lazy(() => import("./AssistantView").then((module) => ({ default: module.AssistantView })));

function canPersistLocalUserData() {
  return canPersistRecentSearches() && canPersistLocalReportStorage() && canPersistImportedRankingReports();
}

function App() {
  const theme = useThemePreference();
  const [assistantPrefill, setAssistantPrefill] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<UserSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [query, setQuery] = useState("");
  const [searchSuggestions, setSearchSuggestions] = useState<CompanyCandidate[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => loadRecentSearches());
  const [localPersistenceAvailable] = useState(() => canPersistLocalUserData());
  const suggestionsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const [watchlistMembership, setWatchlistMembership] = useState<WatchlistMembership>("unavailable");
  const [comparisonReport, setComparisonReport] = useState<InvestmentReport | null>(null);
  const [rankingMarket, setRankingMarket] = useState<RankingMarket>("a-share");
  const [radar, setRadar] = useState<RadarScan | null>(null);
  const [radarJob, setRadarJob] = useState<RadarAnalysisJob | null>(null);
  const [radarDiagnostics, setRadarDiagnostics] = useState<RadarDiagnostics | null>(null);
  const [radarPhase, setRadarPhase] = useState<RadarPhase>("idle");
  const [radarError, setRadarError] = useState("");
  const [isMobileViewport, setIsMobileViewport] = useState(() => (typeof window !== "undefined" ? window.matchMedia("(max-width: 760px)").matches : false));
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
        const state = resolveRadarResultState(nextRadar, hasExistingRadar);
        setRadarPhase(state.phase);
        setRadarError(state.error);
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
          const state = resolveRadarResultState(result, Boolean(radarRef.current));
          setRadarPhase(state.phase);
          setRadarError(state.error);
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
      .catch((err) => {
        setUser(null);
        setAuthenticated(false);
        setError(errorMessage(err, "登录状态读取失败，请重新登录。"));
      })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    selectedCompanyRef.current = selectedCompany;
  }, [selectedCompany]);

  useEffect(() => {
    if (!authenticated || !selectedCompany) return;

    const requestCompany = selectedCompany;
    let active = true;
    void fetchWatchlist()
      .then(({ items }) => {
        if (!active || !isSameCompany(selectedCompanyRef.current, requestCompany)) return;
        setWatchlistMembership(resolveWatchlistMembership(items, requestCompany));
      })
      .catch(() => {
        if (!active || !isSameCompany(selectedCompanyRef.current, requestCompany)) return;
        setWatchlistMembership("unavailable");
      });

    return () => {
      active = false;
    };
  }, [authenticated, selectedCompany]);

  useEffect(() => {
    if (!authenticated || activeView !== "radar" || radar || radarPhase !== "idle") return;
    const id = window.setTimeout(() => void loadRadar(false), 0);
    return () => window.clearTimeout(id);
  }, [activeView, authenticated, loadRadar, radar, radarPhase]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobileViewport(media.matches);
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
    if (hasRecentPreloadRecovery()) showToast(PRELOAD_RECOVERY_NOTICE, "success", 6000);
  }, []);

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

  useEffect(() => {
    if (suggestionsTimerRef.current) clearTimeout(suggestionsTimerRef.current);
    if (!query.trim() || query.trim().length < 2) return;
    suggestionsTimerRef.current = setTimeout(() => {
      searchCompanies(query.trim()).then((results) => {
        setSearchSuggestions(results.slice(0, 8));
        setShowSuggestions(results.length > 0);
      }).catch(() => {});
    }, 300);
    return () => { if (suggestionsTimerRef.current) clearTimeout(suggestionsTimerRef.current); };
  }, [query]);

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
    try { await logout(); } catch { /* logout failure is non-critical */ }
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
      const result = await addWatchlistItem({ company: selectedCompany });
      setWatchlistMembership("present");
      showToast(watchlistAddToastMessage(selectedCompany.name, result.status), "success");
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
      const recentSearchUpdate = rememberRecentSearch(query.trim(), recentSearches);
      setRecentSearches(recentSearchUpdate.searches);
      if (!recentSearchUpdate.persisted) {
        setCacheNotice(
          recentSearchUpdate.persistenceAvailable
            ? "公司候选已返回；浏览器本地缓存写入失败，最近搜索仅保留在当前页面。"
            : "公司候选已返回；浏览器本地缓存不可用，最近搜索仅保留在当前页面。",
        );
      }
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
    setWatchlistMembership("checking");
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
    setWatchlistMembership("present");
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
    setWatchlistMembership("present");
    setReport(null);
    setReportMetrics(null);
    setProgress([]);
    setEvidenceCount(0);
    setPhase("idle");
    setActiveView("mine");
    setCacheNotice("已从自选股排行打开公司，可在“我的”里查看模板或重新评分。");
  }

  if (checking) return (
    <>
      <main className="loading-screen">
        <img src="/app-icon.svg" alt="CSTD Alpha" className="loading-icon" />
        <p className="brand">CSTD Alpha</p>
        <div className="loading-spinner" />
      </main>
      <ToastContainer />
    </>
  );

  if (!authenticated) {
    return (
      <>
        <main className="auth-page">
          <div className="auth-theme-control">
            <ThemeControl value={theme.preference} onChange={theme.setPreference} compact />
          </div>
          <section className="auth-panel" aria-labelledby="auth-title">
            <img src="/app-icon.svg" alt="CSTD Alpha" className="auth-icon" />
            <p className="brand">CSTD Alpha</p>
            <h1 id="auth-title">私人公司深度研究工具</h1>
            <p className="auth-tagline">AI 驱动的深度研究，从公司质量评分到投资吸引力分析</p>
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
            {!localPersistenceAvailable ? <p className="storage-health auth-storage-health" role="status">{LOCAL_PERSISTENCE_UNAVAILABLE_NOTICE}</p> : null}
            {error ? <p className="error-text">{error}</p> : null}
          </section>
        </main>
        <ToastContainer />
      </>
    );
  }

  const { renderedView, mobileAssistantLayout } = resolveAppViewPresentation(activeView, {
    isMobileViewport,
    role: user?.role,
  });
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
    <main className={`app-shell view-${renderedView} ${mobileAssistantLayout ? "mobile-assistant-only" : ""}`}>
      <a href="#workspace" className="skip-link">跳转到工作区</a>
      <aside className={`input-rail ${isWorkbenchView ? "workbench-nav-rail" : ""}`}>
        <div>
          <p className="brand">CSTD Alpha</p>
          <h1>{isWorkbenchView ? "AI 数据工作台" : "中文深度评分报告"}</h1>
          <p className="rail-copy">{isWorkbenchView ? "发现机会、进入研究、验证估值，再用助手追问。" : "先确认上市主体，再生成完整模板报告，避免同名公司或错误代码。"}</p>
          <p className="muted">当前账号：{user?.displayName || user?.username}</p>
          <div className="rail-utilities">
            <ThemeControl value={theme.preference} onChange={theme.setPreference} compact />
            <button type="button" className="ghost-button" onClick={() => void submitLogout()}>
              退出登录
            </button>
          </div>
          {!localPersistenceAvailable ? <p className="storage-health" role="status">{LOCAL_PERSISTENCE_UNAVAILABLE_NOTICE}</p> : null}
        </div>

        <nav className="view-tabs" aria-label="工作区">
          <button type="button" className={renderedView === "opportunities" ? "active" : ""} aria-current={renderedView === "opportunities" ? "page" : undefined} onClick={() => setActiveView("opportunities")}>
            今日机会<kbd>1</kbd>
          </button>
          <button type="button" className={renderedView === "research" || renderedView === "mine" || renderedView === "report" ? "active" : ""} aria-current={renderedView === "research" || renderedView === "mine" || renderedView === "report" ? "page" : undefined} onClick={() => setActiveView("research")}>
            研究<kbd>2</kbd>
          </button>
          <button type="button" className={renderedView === "market" || renderedView === "ranking" || renderedView === "watchlist-ranking" || renderedView === "radar" ? "active" : ""} aria-current={renderedView === "market" || renderedView === "ranking" || renderedView === "watchlist-ranking" || renderedView === "radar" ? "page" : undefined} onClick={() => setActiveView("market")}>
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
                setShowSuggestions(event.target.value.trim().length >= 2);
                if (event.target.value.trim().length < 2) setSearchSuggestions([]);
              }}
              onFocus={() => { if (!query.trim() && recentSearches.length) { setShowSuggestions(true); setSearchSuggestions([]); } else if (searchSuggestions.length) { setShowSuggestions(true); } }}
              onBlur={() => { setTimeout(() => setShowSuggestions(false), 200); }}
              placeholder="例如：万科A、苹果、腾讯、贵州茅台"
              required
            />
            {query ? (
              <button type="button" className="search-clear" onClick={() => { setQuery(""); setSelectedCompany(null); setSearchSuggestions([]); setShowSuggestions(false); }} aria-label="清除搜索">
                ×
              </button>
            ) : null}
          </div>
          {showSuggestions && (searchSuggestions.length || (!query.trim() && recentSearches.length)) ? (
            <div className="search-suggestions">
              {!query.trim() && recentSearches.length && !searchSuggestions.length ? (
                <div className="suggestion-label">最近搜索</div>
              ) : null}
              {searchSuggestions.length ? searchSuggestions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="suggestion-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setQuery(item.name);
                    setSelectedCompany(item);
                    setWatchlistMembership("checking");
                    setShowSuggestions(false);
                    setSearchSuggestions([]);
                    setPhase("idle");
                  }}
                >
                  <strong>{item.name}</strong>
                  <span>{item.code}</span>
                  <small>{item.listingPlace}</small>
                </button>
              )) : recentSearches.map((search) => (
                <button
                  key={search}
                  type="button"
                  className="suggestion-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setQuery(search);
                    setShowSuggestions(false);
                  }}
                >
                  <strong>{search}</strong>
                  <small>最近搜索</small>
                </button>
              ))}
            </div>
          ) : null}
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
        <ErrorBoundary>
        <Suspense fallback={<ModuleLoadingFallback view={renderedView} />}>
          {renderedView === "opportunities" ? (
            <OpportunityDashboard onOpenResearch={() => setActiveView("research")} />
          ) : renderedView === "research" ? (
            <ResearchWorkspace onOpenLegacyMine={() => setActiveView("mine")} onOpenAssistant={(prefill) => { setActiveView("assistant"); if (prefill) setAssistantPrefill(prefill); }} onOpenReport={() => setActiveView("report")} />
          ) : renderedView === "market" ? (
            <MarketWorkspace onOpenRanking={openMarketRanking} onOpenWatchlistRanking={() => setActiveView("watchlist-ranking")} onOpenRadar={openRadarFromMarket} />
          ) : renderedView === "valuation" ? (
            <ValuationLabView />
          ) : renderedView === "ranking" ? (
            <RankingView market={rankingMarket} onOpenEntry={openRankingEntry} canManageGlobalLibrary={user?.role === "admin"} />
          ) : renderedView === "watchlist-ranking" ? (
            <WatchlistRankingView onOpenEntry={openWatchlistRankingEntry} />
          ) : renderedView === "mine" ? (
            <MyResearchView user={user} selectedCompany={selectedCompany} onOpenCompany={openCompanyFromMine} />
          ) : renderedView === "radar" ? (
            <RadarView radar={radar} job={radarJob} diagnostics={radarDiagnostics} isAdmin={user?.role === "admin"} phase={radarPhase} error={radarError} onRefresh={() => void loadRadar(true)} />
          ) : renderedView === "assistant" && user?.role === "admin" ? (
            <AssistantView prefillMessage={assistantPrefill} onPrefillUsed={() => setAssistantPrefill("")} />
          ) : (
            <>
              {chartBundle || chartPhase === "loading" || chartPhase === "error" ? (
                <ChartDashboard chartBundle={chartBundle} chartPhase={chartPhase} report={report} priceMode={priceMode} />
              ) : null}
              {report ? <ReportView report={report} metrics={reportMetrics ?? undefined} onAddToWatchlist={addToWatchlist} onOpenWatchlistResearch={() => setActiveView("mine")} watchlistMembership={selectedCompany ? watchlistMembership : "unavailable"} chartBundle={chartBundle ?? undefined} onSaveComparison={() => {
                if (comparisonReport?.company.name === report.company.name) { showToast("已取消对比。", "info"); setComparisonReport(null); }
                else if (comparisonReport) { showToast(`对比已更新：${report.company.name} vs ${comparisonReport.company.name}`, "success"); setComparisonReport(report); }
                else { showToast(`${report.company.name} 已保存为对比基准。`, "success"); setComparisonReport(report); }
              }} comparisonReport={comparisonReport} /> : <EmptyState />}
            </>
          )}
        </Suspense>
        </ErrorBoundary>
      </section>

      {phase === "selecting" && candidates.length > 0 ? (
        <CandidateModal
          candidates={candidates}
          onClose={() => setPhase("idle")}
          onSelect={(candidate) => {
            setSelectedCompany(candidate);
            setWatchlistMembership("checking");
            setPhase("idle");
          }}
        />
      ) : null}
      <BackToTop />
      <nav className="mobile-bottom-nav" aria-label="移动端导航">
        <button type="button" className={renderedView === "opportunities" ? "active" : ""} aria-current={renderedView === "opportunities" ? "page" : undefined} onClick={() => setActiveView("opportunities")}>
          <span className="nav-icon">📊</span>
          <span className="nav-label">机会</span>
        </button>
        <button type="button" className={renderedView === "research" || renderedView === "mine" || renderedView === "report" ? "active" : ""} aria-current={renderedView === "research" || renderedView === "mine" || renderedView === "report" ? "page" : undefined} onClick={() => setActiveView("research")}>
          <span className="nav-icon">🔬</span>
          <span className="nav-label">研究</span>
        </button>
        <button type="button" className={renderedView === "market" || renderedView === "ranking" || renderedView === "watchlist-ranking" || renderedView === "radar" ? "active" : ""} aria-current={renderedView === "market" || renderedView === "ranking" || renderedView === "watchlist-ranking" || renderedView === "radar" ? "page" : undefined} onClick={() => setActiveView("market")}>
          <span className="nav-icon">📈</span>
          <span className="nav-label">市场</span>
        </button>
        <button type="button" className={renderedView === "valuation" ? "active" : ""} aria-current={renderedView === "valuation" ? "page" : undefined} onClick={() => setActiveView("valuation")}>
          <span className="nav-icon">💰</span>
          <span className="nav-label">估值</span>
        </button>
        {user?.role === "admin" ? (
          <button type="button" className={renderedView === "assistant" ? "active" : ""} aria-current={renderedView === "assistant" ? "page" : undefined} onClick={() => setActiveView("assistant")}>
            <span className="nav-icon">🤖</span>
            <span className="nav-label">助手</span>
          </button>
        ) : null}
      </nav>
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

function EmptyState() {
  return (
    <section className="empty-state">
      <h2>先选择具体上市公司</h2>
      <p>输入公司名后会先弹出候选项，确认公司名、代码和上市地点，再生成完整评分报告。</p>
      <p className="muted">快捷键：Ctrl+1 今日机会 / Ctrl+2 研究 / Ctrl+3 市场 / Ctrl+4 估值</p>
    </section>
  );
}

function ModuleLoadingFallback({ view }: { view: AppView }) {
  const loading = describeAppViewLoading(view);

  return (
    <section className="module-loading-state" role="status" aria-live="polite" aria-label={loading.title}>
      <header className="module-loading-header">
        <span className="module-loading-spinner" aria-hidden="true" />
        <div>
          <p className="module-loading-label">{loading.label}</p>
          <h2>{loading.title}</h2>
          <p className="module-loading-detail">{loading.detail}</p>
        </div>
      </header>
      <div className="module-loading-progress" aria-hidden="true">
        <span />
      </div>
      <ul className="module-loading-checkpoints">
        {loading.checkpoints.map((checkpoint, index) => (
          <li key={checkpoint}>
            <span aria-hidden="true">{index + 1}</span>
            {checkpoint}
          </li>
        ))}
      </ul>
    </section>
  );
}

function isReportCancelled(error: unknown) {
  return error instanceof Error && error.message === REPORT_CANCELLED_MESSAGE;
}

function formatCacheTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function isSameCompany(left: CompanyCandidate | null, right: CompanyCandidate) {
  return Boolean(left && left.code === right.code && left.listingPlace === right.listingPlace && left.marketType === right.marketType);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default App;
