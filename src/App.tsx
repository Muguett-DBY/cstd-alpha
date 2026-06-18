import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addWatchlistItem, checkSession, fetchChartData, fetchRadarScan, fetchReportLibraryRecord, generateReport, login, logout, refreshRadarScan, REPORT_CANCELLED_MESSAGE, searchCompanies, type ReportProgress } from "./api";
import { downloadReportDocx } from "./docx/export-report";
import { ErrorBoundary } from "./ErrorBoundary";
import "./App.css";
import { RadarView, type RadarPhase } from "./RadarView";
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
import { radarRefreshFallbackMessage } from "./radar-ui";
import type { ChartBundle, PriceMode } from "./shared/chart";
import { companyCandidateFromRanking, type RankingEntry } from "./shared/ranking";
import type { RadarAnalysisJob, RadarDiagnostics, RadarScan } from "./shared/radar";
import type { CompanyCandidate, InvestmentReport, ModuleScore, ReportGenerationMetrics, ScoreItem } from "./shared/report";
import type { UserSession, WatchlistRankingEntry } from "./shared/user-research";

type Phase = "idle" | "searching" | "selecting" | "generating" | "ready" | "error";
type AppView = "opportunities" | "research" | "market" | "valuation" | "report" | "ranking" | "watchlist-ranking" | "mine" | "radar" | "assistant";

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
  const [searchSuggestions, setSearchSuggestions] = useState<CompanyCandidate[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("cstd-alpha:recent-searches") || "[]"); } catch { return []; }
  });
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
  const [isInWatchlist, setIsInWatchlist] = useState(false);
  const [comparisonReport, setComparisonReport] = useState<InvestmentReport | null>(null);
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
      setRecentSearches((prev) => {
        const next = [query.trim(), ...prev.filter((s) => s !== query.trim())].slice(0, 8);
        localStorage.setItem("cstd-alpha:recent-searches", JSON.stringify(next));
        return next;
      });
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

  if (checking) return (
    <main className="loading-screen">
      <img src="/app-icon.svg" alt="CSTD Alpha" className="loading-icon" />
      <p className="brand">CSTD Alpha</p>
      <div className="loading-spinner" />
    </main>
  );

  if (!authenticated) {
    return (
      <main className="auth-page">
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
              {report ? <ReportView report={report} metrics={reportMetrics ?? undefined} onAddToWatchlist={addToWatchlist} isWatchlisted={isInWatchlist} chartBundle={chartBundle ?? undefined} onSaveComparison={() => {
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

function ReportView({ report, metrics, onAddToWatchlist, isWatchlisted, chartBundle, onSaveComparison, comparisonReport }: { report: InvestmentReport; metrics?: ReportGenerationMetrics; onAddToWatchlist?: () => void; isWatchlisted?: boolean; chartBundle?: ChartBundle; onSaveComparison?: () => void; comparisonReport?: InvestmentReport | null }) {
  const tokenSummary = summarizeTokenUsage(metrics?.tokenUsage);
  const [activeSection, setActiveSection] = useState("scores");

  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>(".report [id]");
    if (!sections.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [report]);

  const navItems = [
    { id: "scores", label: "评分" },
    { id: "conclusion", label: "结论" },
    { id: "scoreboard", label: "模块" },
    { id: "detailed-scores", label: "详细评分" },
    { id: "financials", label: "财务" },
    { id: "valuation", label: "估值" },
    { id: "risks", label: "风险" },
    { id: "evidence", label: "证据" },
  ];

  return (
    <article className="report">
      <nav className="report-section-nav" aria-label="报告章节">
        {navItems.map((item) => (
          <a key={item.id} href={`#${item.id}`} className={activeSection === item.id ? "active" : ""}>{item.label}</a>
        ))}
      </nav>

      <div className="quick-jump-bar">
        <a href="#conclusion" className="quick-jump-pill">结论</a>
        <a href="#cqs" className="quick-jump-pill">CQS</a>
        <a href="#ias" className="quick-jump-pill">IAS</a>
        <a href="#scoreboard" className="quick-jump-pill">评分板</a>
        <a href="#valuation" className="quick-jump-pill">估值</a>
        <a href="#risks" className="quick-jump-pill">风险</a>
      </div>

      <header className="report-header">
        <div>
          <p className="eyebrow">
            {report.company.ticker || "未识别代码"} / {report.company.market || "未识别市场"} / {report.company.industry || "行业待验证"}
          </p>
          <h2>{report.company.name}</h2>
          <p className="muted">{report.oneSentence}</p>
          <div className="company-profile">
            <span className="profile-item" id="cqs"><strong>CQS</strong> {report.cqs}</span>
            <span className="profile-item" id="ias"><strong>IAS</strong> {report.ias}</span>
            <span className="profile-item"><strong>结论</strong> {report.conclusion}</span>
            <span className="profile-item"><strong>估值</strong> {report.summaryDashboard.valuationView}</span>
          </div>
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
        <button type="button" className="secondary-button" onClick={() => {
          const text = `${report.company.name}（${report.company.ticker || "未知代码"}）\nCQS: ${report.cqs} / IAS: ${report.ias}\n结论: ${report.conclusion}（${report.qualitativeBand}）\n${report.oneSentence}`;
          navigator.clipboard.writeText(text).then(() => showToast("摘要已复制到剪贴板。", "success")).catch(() => showToast("复制失败，请手动选择复制。", "error"));
        }}>
          复制摘要
        </button>
        {onSaveComparison ? (
          <button type="button" className="secondary-button" onClick={onSaveComparison}>
            {comparisonReport ? "对比中" : "保存对比"}
          </button>
        ) : null}
      </header>

      {comparisonReport ? (
        <section className="report-comparison">
          <h3>对比视图</h3>
          <div className="comparison-grid">
            <div className="comparison-col">
              <h4>{report.company.name}</h4>
              <p className="muted">{report.company.ticker || "未知代码"}</p>
            </div>
            <div className="comparison-col">
              <h4>{comparisonReport.company.name}</h4>
              <p className="muted">{comparisonReport.company.ticker || "未知代码"}</p>
            </div>
          </div>
          <div className="comparison-grid">
            <div className="comparison-col">
              <div className="comparison-metric"><span>CQS</span><strong>{report.cqs}</strong></div>
              <div className="comparison-metric"><span>IAS</span><strong>{report.ias}</strong></div>
              <div className="comparison-metric"><span>结论</span><strong>{report.conclusion}</strong></div>
            </div>
            <div className="comparison-col">
              <div className="comparison-metric"><span>CQS</span><strong>{comparisonReport.cqs}</strong></div>
              <div className="comparison-metric"><span>IAS</span><strong>{comparisonReport.ias}</strong></div>
              <div className="comparison-metric"><span>结论</span><strong>{comparisonReport.conclusion}</strong></div>
            </div>
          </div>
          <div className="comparison-grid">
            <div className="comparison-col">
              <div className="comparison-metric"><span>估值判断</span><span>{report.summaryDashboard.valuationView}</span></div>
              <div className="comparison-metric"><span>建议仓位</span><span>{report.summaryDashboard.positionAdvice}</span></div>
              <div className="comparison-metric"><span>投资期限</span><span>{report.summaryDashboard.investmentHorizon}</span></div>
            </div>
            <div className="comparison-col">
              <div className="comparison-metric"><span>估值判断</span><span>{comparisonReport.summaryDashboard.valuationView}</span></div>
              <div className="comparison-metric"><span>建议仓位</span><span>{comparisonReport.summaryDashboard.positionAdvice}</span></div>
              <div className="comparison-metric"><span>投资期限</span><span>{comparisonReport.summaryDashboard.investmentHorizon}</span></div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="score-strip" id="scores">
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

      <ReportBlock title="一页结论与评分仪表盘" body={report.fullSections.onePageConclusion} id="conclusion" />

      <section className="module-table" id="scoreboard">
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

      <section className="score-items" id="detailed-scores">
        <h3>20 项详细评分</h3>
        <p className="muted">点击展开查看每项评分的详细证据和扣分点。低分项自动高亮。</p>
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
    <div className="score-tile" onClick={() => navigator.clipboard.writeText(String(value)).then(() => showToast(`${label}: ${value}`, "success")).catch(() => {})} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigator.clipboard.writeText(String(value)).then(() => showToast(`${label}: ${value}`, "success")).catch(() => {}); } }}>
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
  const isLowScore = item.score < 50;
  return (
    <details className={`score-item-card ${isLowScore ? "low-score" : ""}`}>
      <summary>
        <span className="score-index">{index}</span>
        <div className="score-summary-text">
          <strong>{item.title}</strong>
          <span>{item.moduleName} / 权重 {item.weight}%</span>
        </div>
        <span className="score-badge">
          {item.score}/100
          <small>{item.label}</small>
        </span>
      </summary>
      <div className="score-item-body">
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
        {item.recentChange ? <small>{item.recentChange}</small> : null}
      </div>
    </details>
  );
}

function FinancialTable({ report }: { report: InvestmentReport }) {
  const allYears = Array.from(new Set(report.financialTenYear.rows.flatMap((row) => Object.keys(row.values)))).slice(-10);
  const [sortField, setSortField] = useState<"metric" | "latest">("metric");
  const [sortAsc, setSortAsc] = useState(true);
  const [yearRange, setYearRange] = useState<{ start: number; end: number }>({ start: 0, end: allYears.length - 1 });
  const years = allYears.slice(yearRange.start, yearRange.end + 1);
  const gridTemplateColumns = `150px repeat(${years.length}, minmax(84px, 1fr)) 104px`;
  const minWidth = `${150 + years.length * 84 + 104}px`;

  const sortedRows = useMemo(() => {
    const rows = [...report.financialTenYear.rows];
    if (sortField === "metric") {
      rows.sort((a, b) => sortAsc ? a.metric.localeCompare(b.metric) : b.metric.localeCompare(a.metric));
    } else {
      const latest = years[years.length - 1];
      rows.sort((a, b) => {
        const aVal = parseFloat(a.values[latest] || "0");
        const bVal = parseFloat(b.values[latest] || "0");
        return sortAsc ? aVal - bVal : bVal - aVal;
      });
    }
    return rows;
  }, [report.financialTenYear.rows, sortField, sortAsc, years]);

  const handleYearRangeStart = (val: string) => {
    const idx = parseInt(val, 10);
    setYearRange((prev) => ({ start: Math.min(idx, prev.end), end: prev.end }));
  };
  const handleYearRangeEnd = (val: string) => {
    const idx = parseInt(val, 10);
    setYearRange((prev) => ({ start: prev.start, end: Math.max(idx, prev.start) }));
  };

  const toggleSort = (field: "metric" | "latest") => {
    if (sortField === field) setSortAsc(!sortAsc);
    else { setSortField(field); setSortAsc(true); }
  };

  return (
    <details className="wide-section" id="financials" open>
      <summary><h3>十年财务数据总表</h3></summary>
      {report.financialTenYear.rows.length && years.length ? (
        <>
          <div className="financial-controls">
            <div className="year-range-selector">
              <label>年份范围：</label>
              <select value={yearRange.start} onChange={(e) => handleYearRangeStart(e.target.value)}>
                {allYears.map((y, i) => <option key={y} value={i} disabled={i > yearRange.end}>{y}</option>)}
              </select>
              <span>至</span>
              <select value={yearRange.end} onChange={(e) => handleYearRangeEnd(e.target.value)}>
                {allYears.map((y, i) => <option key={y} value={i} disabled={i < yearRange.start}>{y}</option>)}
              </select>
            </div>
          </div>
          <div className="financial-table">
            <div className="financial-row financial-head" style={{ gridTemplateColumns, minWidth }}>
              <span className="sortable-header" onClick={() => toggleSort("metric")} style={{ cursor: "pointer" }}>
                指标 {sortField === "metric" ? (sortAsc ? "↑" : "↓") : ""}
              </span>
              {years.map((year) => (
                <span key={year}>{year}</span>
              ))}
              <span className="sortable-header" onClick={() => toggleSort("latest")} style={{ cursor: "pointer" }}>
                趋势 {sortField === "latest" ? (sortAsc ? "↑" : "↓") : ""}
              </span>
            </div>
            {sortedRows.map((row) => (
              <div key={row.metric} className="financial-row" style={{ gridTemplateColumns, minWidth }}>
                <span>{row.metric}</span>
                {years.map((year) => (
                  <span key={year}>{row.values[year] || "-"}</span>
                ))}
                <span>{row.trend}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p>数据不足：公开接口未返回可直接入表的十年财务数据。</p>
      )}
      <p>{report.financialTenYear.interpretation}</p>
    </details>
  );
}

function ValuationSection({ report }: { report: InvestmentReport }) {
  return (
    <section className="wide-section" id="valuation">
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
    <details className="wide-section" id="risks">
      <summary><h3>风险清单与反证条件</h3></summary>
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
    </details>
  );
}

function ReportBlock({ title, body, id }: { title: string; body: string; id?: string }) {
  return (
    <section className="report-section" id={id}>
      <h3>{title}</h3>
      {splitReportParagraphs(body).map((paragraph, index) => (
        <p key={`${title}-${index}`}>{paragraph}</p>
      ))}
    </section>
  );
}

function EvidenceList({ report }: { report: InvestmentReport }) {
  return (
    <section className="evidence-list" id="evidence">
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
      <p className="muted">快捷键：Ctrl+1 今日机会 / Ctrl+2 研究 / Ctrl+3 市场 / Ctrl+4 估值</p>
    </section>
  );
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

function listItems(items: string[]) {
  const values = items.length ? items : ["数据不足，需要继续核验。"];
  return values.map((item) => <li key={item}>{item}</li>);
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
