import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { checkSession, fetchChartData, fetchRadarScan, fetchReportLibraryRecord, generateReport, login, logout, refreshRadarScan, searchCompanies, type ReportProgress } from "./api";
import "./App.css";
import { RankingView, type RankingMarket } from "./RankingView";
import { MyResearchView } from "./MyResearchView";
import { clearLocalReportStorage, loadCachedChart, loadCachedReport, loadLastReportEntry, saveCachedChart, saveCachedReport, saveLastReport } from "./storage";
import { clearImportedRankingReports } from "./ranking-storage";
import { buildRadarSourceLibrary, radarCardInsights, radarChangeBuckets, radarRefreshFallbackMessage } from "./radar-ui";
import { extractFinancialChartSeries, extractModuleScoreSeries, type ChartBundle, type ChartSeries, type PriceMode } from "./shared/chart";
import { companyCandidateFromRanking, type RankingEntry } from "./shared/ranking";
import type { RadarAnalysisJob, RadarCitation, RadarCoverageItem, RadarCoverageReview, RadarEvidenceBreakdown, RadarEvidenceType, RadarIndustryPacket, RadarItem, RadarList, RadarScan } from "./shared/radar";
import type { CompanyCandidate, InvestmentReport, ModuleScore, ReportGenerationMetrics, ScoreItem } from "./shared/report";
import type { UserSession } from "./shared/user-research";

type Phase = "idle" | "searching" | "selecting" | "generating" | "ready" | "error";
type ChartPhase = "idle" | "loading" | "ready" | "error";
type AppView = "report" | "ranking" | "mine" | "radar";
type RadarPhase = "idle" | "loading" | "refreshing" | "ready" | "error";
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export const DEFAULT_APP_VIEW: AppView = "radar";
const INSTALL_PROMPT_DISMISSED_KEY = "cstd-alpha-install-dismissed";

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
  const [activeView, setActiveView] = useState<AppView>(DEFAULT_APP_VIEW);
  const [rankingMarket, setRankingMarket] = useState<RankingMarket>("a-share");
  const [radar, setRadar] = useState<RadarScan | null>(null);
  const [radarJob, setRadarJob] = useState<RadarAnalysisJob | null>(null);
  const [radarPhase, setRadarPhase] = useState<RadarPhase>("idle");
  const [radarError, setRadarError] = useState("");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const selectedCompanyRef = useRef<CompanyCandidate | null>(selectedCompany);

  const loadRadar = useCallback(
    async (forceRefresh: boolean) => {
      const hasExistingRadar = Boolean(radar);
      setRadarPhase(forceRefresh && hasExistingRadar ? "refreshing" : "loading");
      setRadarError("");
      try {
        const nextRadar = forceRefresh ? await refreshRadarScan() : await fetchRadarScan();
        if (nextRadar.radar) setRadar(nextRadar.radar);
        else if (!hasExistingRadar) setRadar(null);
        setRadarJob(nextRadar.job ?? null);
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
    [radar],
  );

  useEffect(() => {
    if (activeView !== "radar" || (radarJob?.status !== "queued" && radarJob?.status !== "running")) return;
    const id = window.setInterval(() => {
      void fetchRadarScan()
        .then((result) => {
          if (result.radar) setRadar(result.radar);
          setRadarJob(result.job ?? null);
          if (result.job?.status === "queued" || result.job?.status === "running") {
            setRadarPhase(result.radar || radar ? "refreshing" : "loading");
          } else {
            setRadarPhase(result.radar || radar ? "ready" : "error");
          }
          setRadarError(result.warning ?? result.radar?.refreshWarning ?? "");
        })
        .catch((err) => {
          setRadarPhase(radar ? "ready" : "error");
          setRadarError(radarRefreshFallbackMessage(Boolean(radar), err));
        });
    }, 5000);
    return () => window.clearInterval(id);
  }, [activeView, radar, radarJob?.status]);

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

  useEffect(() => {
    if (!authenticated || activeView !== "radar" || radar || radarPhase !== "idle") return;
    const id = window.setTimeout(() => void loadRadar(false), 0);
    return () => window.clearTimeout(id);
  }, [activeView, authenticated, loadRadar, radar, radarPhase]);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      if (window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY) === "1") return;
      if (!window.matchMedia("(max-width: 820px), (pointer: coarse)").matches) return;
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setShowInstallPrompt(true);
    };
    const onInstalled = () => {
      setShowInstallPrompt(false);
      setInstallPrompt(null);
      window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "1");
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function installMobileApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => ({ outcome: "dismissed" as const, platform: "" }));
    if (choice.outcome !== "accepted") window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "1");
    setShowInstallPrompt(false);
    setInstallPrompt(null);
  }

  function dismissInstallPrompt() {
    window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "1");
    setShowInstallPrompt(false);
  }

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const session = await login(password, username);
      setUser(session);
      setAuthenticated(true);
      setRadarError("");
      if (activeView === "radar" && !radar) setRadarPhase("idle");
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
    setRadar(null);
    setRadarJob(null);
    setRadarPhase("idle");
    setRadarError("");
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
    <main className={`app-shell view-${activeView}`}>
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
          <button type="button" className={`wide-tab ${activeView === "mine" ? "active" : ""}`} aria-current={activeView === "mine" ? "page" : undefined} onClick={() => setActiveView("mine")}>
            我的
          </button>
          <button type="button" className={`wide-tab ${activeView === "radar" ? "active" : ""}`} aria-current={activeView === "radar" ? "page" : undefined} onClick={() => setActiveView("radar")}>
            扫描
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
        ) : activeView === "radar" ? (
          <RadarView radar={radar} job={radarJob} phase={radarPhase} error={radarError} onRefresh={() => void loadRadar(true)} />
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
      <InstallPromptBanner visible={showInstallPrompt} onInstall={() => void installMobileApp()} onDismiss={dismissInstallPrompt} />
    </main>
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

function RadarView({
  radar,
  job,
  phase,
  error,
  onRefresh,
}: {
  radar: RadarScan | null;
  job: RadarAnalysisJob | null;
  phase: RadarPhase;
  error: string;
  onRefresh: () => void;
}) {
  const loading = phase === "loading" || phase === "refreshing";
  const refreshing = phase === "refreshing";
  const jobRunning = job?.status === "queued" || job?.status === "running";
  const sourceMap = useMemo(() => new Map((radar?.evidenceSources ?? []).map((source) => [source.id, source])), [radar?.evidenceSources]);
  const radarItems = useMemo(() => (radar ? allRadarItems(radar) : []), [radar]);
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
          </div>

          <RadarRoundChanges changeLog={radar.changeLog} />
          <RadarSectionNav />
          <RadarBrief radar={radar} />
          <RadarMarketOverview radar={radar} />
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
    { label: "高置信增长", item: highestPriorityRadarItem(radar.solidGrowth) },
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

function RadarMarketOverview({ radar }: { radar: RadarScan }) {
  const packets = buildRadarVisualPackets(radar);
  if (!packets.length) return null;
  const formalTotal = allRadarItems(radar).length;
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
          正式雷达条目
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
      <div className="radar-market-layout">
        <RadarIndustryHeatmap packets={packets} />
        <RadarStageBuckets packets={packets} />
      </div>
      <RadarTopSignalLists packets={packets} />
    </section>
  );
}

function RadarIndustryHeatmap({ packets }: { packets: RadarIndustryPacket[] }) {
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
          <a
            key={packet.industry}
            className={`radar-heatmap-dot ${radarStageClass(packet.stage)} ${scores.confidence < 45 ? "is-low-confidence" : ""}`}
            href={stageTarget(packet.stage)}
            title={`${packet.industry}｜${packet.stage ?? "证据不足"}｜动量 ${growthMomentum}｜风险 ${risk}｜证据 ${packet.sourceCount} 条`}
            style={{ left: `${growthMomentum}%`, top: `${100 - risk}%`, width: size, height: size } as CSSProperties}
          >
            <span>{packet.industry}</span>
          </a>
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

function RadarStageBuckets({ packets }: { packets: RadarIndustryPacket[] }) {
  const buckets = radarStageBuckets(packets);
  return (
    <div className="radar-stage-buckets" aria-label="产业阶段分布">
      <div className="radar-signal-map-head">
        <strong>全量扫描分层</strong>
        <span>非正式结论，可展开</span>
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
              <a key={packet.industry} href={stageTarget(packet.stage)}>
                {packet.industry}
                <small>{packet.sourceCount} 条</small>
              </a>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function RadarTopSignalLists({ packets }: { packets: RadarIndustryPacket[] }) {
  const lists = [
    { title: "机会强度 Top 20", items: topRadarPackets(packets, (packet) => radarPacketMetricValue(packet, "opportunity")), metric: "opportunity" },
    { title: "风险压力 Top 20", items: topRadarPackets(packets, (packet) => radarPacketMetricValue(packet, "risk")), metric: "risk" },
    { title: "硬证据 Top 20", items: topRadarPackets(packets, (packet) => radarPacketMetricValue(packet, "evidence")), metric: "evidence" },
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
                <span>{packet.industry}</span>
                <strong>{radarPacketMetric(packet, list.metric)}</strong>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </div>
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
          {item.supportingSourceCount ? `${item.supportingSourceCount} 条` : "待确认"}
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
          <span>反证/拐点</span>
          <ul>{listItems(insights.counterSignals.slice(0, 3))}</ul>
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
            <strong>原始拐点</strong>
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
  const body = (
    <>
      <span>
        {source.id} / {radarEvidenceLabel(source.sourceType)}
      </span>
      <strong>{source.title}</strong>
      <small>{source.source}{source.publishedAt ? ` · ${formatDateTime(source.publishedAt)}` : ""}</small>
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
  const library = useMemo(() => buildRadarSourceLibrary(sources, items, { industry: industryFilter, evidenceType: evidenceTypeFilter }), [evidenceTypeFilter, industryFilter, items, sources]);
  if (!sources.length) return null;
  return (
    <section className="radar-section" id="radar-sources">
      <header className="radar-source-header">
        <div>
          <h3>证据引用库</h3>
          <p>
            已显示 {Math.min(library.entries.length, 30)} / {sources.length} 条，可按行业和证据类型快速收敛。
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
      <div className="radar-source-library">
        {library.entries.length ? (
          library.entries.slice(0, 30).map((entry) => <RadarCitationCard key={entry.source.id} source={entry.source} context={{ industries: entry.industries, itemTitles: entry.itemTitles }} />)
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
      for (const industry of item.industries.length ? item.industries : [item.title]) {
        addPacket({
          group: stage,
          industry,
          status: "scanned",
          changeStatus: item.changeReason?.includes("复用") ? "unchanged" : "changed",
          stage,
          evidenceHash: `${stage}-${industry}`,
          sourceCount: item.supportingSourceCount ?? item.sourceIds?.length ?? 0,
          evidenceTypes: item.evidenceTypes ?? [],
          signalTypes: item.driverTags ?? [],
          evidenceGaps: item.evidenceGaps ?? [],
          themes: item.driverTags,
          scores: visualScoresForRadarItem(item, stage),
        });
      }
    }
  }
  for (const coverage of radar.coverageReview ?? []) {
    addPacket({
      group: "覆盖复核",
      industry: coverage.label,
      status: "scanned",
      stage: coverage.status === "formal" ? "继续观察" : coverage.status === "watched" ? "继续观察" : "证据不足",
      evidenceHash: `coverage-${coverage.label}`,
      sourceCount: coverage.sourceCount,
      evidenceTypes: coverage.evidenceTypes,
      signalTypes: [],
      evidenceGaps: coverage.status === "insufficient" ? ["缺多源验证"] : [],
      scores: visualScoresForCoverage(coverage),
    });
  }
  for (const coverage of radar.softCoverage ?? []) {
    addPacket({
      group: "软覆盖",
      industry: coverage.label,
      status: "scanned",
      stage: coverage.sourceCount >= 2 ? "继续观察" : "证据不足",
      evidenceHash: `soft-${coverage.label}`,
      sourceCount: coverage.sourceCount,
      evidenceTypes: coverage.evidenceTypes,
      signalTypes: [],
      evidenceGaps: coverage.sourceCount >= 2 ? [] : ["缺多源验证"],
      scores: visualScoresForCoverage(coverage),
    });
  }
  return [...staged.values()].sort((left, right) => radarPacketPriority(right) - radarPacketPriority(left));
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

function visualScoresForCoverage(coverage: RadarCoverageItem | RadarCoverageReview) {
  const evidence = Math.min(100, coverage.sourceCount * 10 + coverage.evidenceTypes.length * 10);
  const watched = "status" in coverage && coverage.status === "watched";
  const formal = "status" in coverage && coverage.status === "formal";
  const growth = formal ? 62 : watched ? 48 : 28;
  const risk = /泡沫|衰退|过剩|地产|光伏|机器人/.test(`${coverage.label} ${coverage.note}`) ? 68 : 32;
  return { growth, momentum: growth, evidence, valuationRisk: risk, bubbleRisk: risk, declineRisk: risk, confidence: evidence, change: watched || formal ? 48 : 25 };
}

function radarPacketPriority(packet: RadarIndustryPacket) {
  const scores = radarPacketVisualScores(packet);
  return Math.max(scores.growth, scores.momentum) * 2 + scores.evidence + Math.max(scores.bubbleRisk, scores.declineRisk) + Math.sqrt(packet.sourceCount ?? 0) * 10;
}

function topRadarPackets(packets: RadarIndustryPacket[], score: (packet: RadarIndustryPacket) => number) {
  return [...packets].sort((left, right) => score(right) - score(left)).slice(0, 20);
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

function stageTarget(stage?: string) {
  return (
    {
      扎实增长: "#radar-growth",
      即将增长: "#radar-upcoming",
      泡沫风险: "#radar-bubble",
      衰退: "#radar-decline",
      平稳现金流: "#radar-stages",
      继续观察: "#radar-sustainability",
      证据不足: "#radar-evidence-overview",
    }[stage || "证据不足"] ?? "#radar-evidence-overview"
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
