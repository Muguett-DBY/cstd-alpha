import { useEffect, useMemo, useState } from "react";
import { checkSession, generateReport, login, type GenerateReportInput } from "./api";
import "./App.css";
import { downloadReportDocx } from "./docx/export-report";
import { loadLastReport, saveLastReport } from "./storage";
import type { InvestmentReport, ModuleScore, ReportLanguage } from "./shared/report";

type Phase = "idle" | "collecting" | "scoring" | "ready" | "error";

const progressItems = [
  ["collecting", "公开财务数据"],
  ["scoring", "DeepSeek V4 Pro"],
  ["ready", "报告与导出"],
] as const;

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [ticker, setTicker] = useState("");
  const [market, setMarket] = useState("");
  const [language, setLanguage] = useState<ReportLanguage>("zh-CN");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [report, setReport] = useState<InvestmentReport | null>(() => loadLastReport());

  useEffect(() => {
    void checkSession()
      .then(setAuthenticated)
      .finally(() => setChecking(false));
  }, []);

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await login(password);
      setAuthenticated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    }
  }

  async function submitReport(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setPhase("collecting");

    const input: GenerateReportInput = {
      companyName,
      ticker: ticker || undefined,
      market: market || undefined,
      language,
    };

    try {
      window.setTimeout(() => setPhase("scoring"), 500);
      const nextReport = await generateReport(input);
      setReport(nextReport);
      saveLastReport(nextReport);
      setPhase("ready");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Report generation failed.");
    }
  }

  if (checking) {
    return <div className="loading-screen">CSTD Alpha</div>;
  }

  if (!authenticated) {
    return (
      <main className="auth-page">
        <section className="auth-panel" aria-labelledby="auth-title">
          <p className="brand">CSTD Alpha</p>
          <h1 id="auth-title">Private investment research</h1>
          <form onSubmit={submitLogin} className="auth-form">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
            <button type="submit">Enter</button>
          </form>
          {error ? <p className="error-text">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="input-rail">
        <div>
          <p className="brand">CSTD Alpha</p>
          <h1>Company scoring report</h1>
        </div>

        <form onSubmit={submitReport} className="report-form">
          <label htmlFor="companyName">Company name</label>
          <input
            id="companyName"
            value={companyName}
            onChange={(event) => setCompanyName(event.target.value)}
            placeholder="Apple, Tencent, Costco..."
            required
          />

          <label htmlFor="ticker">Ticker</label>
          <input id="ticker" value={ticker} onChange={(event) => setTicker(event.target.value)} placeholder="AAPL / 0700.HK" />

          <label htmlFor="market">Market</label>
          <input id="market" value={market} onChange={(event) => setMarket(event.target.value)} placeholder="US / HK / CN" />

          <label htmlFor="language">Language</label>
          <select id="language" value={language} onChange={(event) => setLanguage(event.target.value as ReportLanguage)}>
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>

          <button type="submit" disabled={phase === "collecting" || phase === "scoring"}>
            Generate report
          </button>
        </form>

        <Progress phase={phase} />
        {error ? <p className="error-text">{error}</p> : null}
      </aside>

      <section className="workspace">
        {report ? <ReportView report={report} /> : <EmptyState />}
      </section>
    </main>
  );
}

function Progress({ phase }: { phase: Phase }) {
  return (
    <ol className="progress-list">
      {progressItems.map(([key, label]) => (
        <li key={key} className={progressClass(phase, key)}>
          <span />
          {label}
        </li>
      ))}
    </ol>
  );
}

function ReportView({ report }: { report: InvestmentReport }) {
  const jsonUrl = useMemo(() => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    return URL.createObjectURL(blob);
  }, [report]);

  useEffect(() => () => URL.revokeObjectURL(jsonUrl), [jsonUrl]);

  return (
    <article className="report">
      <header className="report-header">
        <div>
          <p className="eyebrow">{report.company.ticker || report.company.market || "Research report"}</p>
          <h2>{report.company.name}</h2>
          <p className="muted">{report.oneSentence}</p>
        </div>
        <div className="actions">
          <button type="button" onClick={() => downloadReportDocx(report)}>
            Export DOCX
          </button>
          <a href={jsonUrl} download={`${report.company.name}-cstd-alpha.json`}>
            Export JSON
          </a>
        </div>
      </header>

      <section className="score-strip">
        <ScoreTile label="CQS" value={report.cqs} />
        <ScoreTile label="IAS" value={report.ias} />
        <div className="decision">
          <span>Conclusion</span>
          <strong>{report.conclusion}</strong>
        </div>
      </section>

      <section className="module-table">
        <div className="table-row table-head">
          <span>Module</span>
          <span>Weight</span>
          <span>Score</span>
          <span>Summary</span>
        </div>
        {report.moduleScores.map((module) => (
          <ModuleRow key={module.id} module={module} />
        ))}
      </section>

      <section className="section-grid">
        {Object.entries(report.sections).map(([key, value]) => (
          <section key={key} className="report-section">
            <h3>{sectionTitle(key)}</h3>
            <p>{value}</p>
          </section>
        ))}
      </section>

      <section className="evidence-list">
        <h3>Evidence</h3>
        {report.evidence.map((item) => (
          <a key={`${item.source}-${item.url}-${item.title}`} href={item.url || undefined} target="_blank" rel="noreferrer">
            <strong>{item.title}</strong>
            <span>{item.source}</span>
            <span>{item.freshness}</span>
          </a>
        ))}
      </section>
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

function ModuleRow({ module }: { module: ModuleScore }) {
  return (
    <div className="table-row">
      <span>{module.name}</span>
      <span>{module.weight}%</span>
      <span>{module.score}</span>
      <span>{module.summary}</span>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="empty-state">
      <h2>Ready for a company</h2>
      <p>Reports follow the CQS + IAS scoring system and keep source freshness visible.</p>
    </section>
  );
}

function progressClass(phase: Phase, key: (typeof progressItems)[number][0]) {
  if (phase === "ready") return "done";
  if (phase === key) return "active";
  if (phase === "scoring" && key === "collecting") return "done";
  return "";
}

function sectionTitle(key: string) {
  const titles: Record<string, string> = {
    companyOverview: "Company overview",
    industry: "Industry",
    businessModel: "Business model",
    moat: "Moat",
    governance: "Governance",
    financialQuality: "Financial quality",
    growth: "Growth",
    valuation: "Valuation",
    risks: "Risks",
    finalConclusion: "Final conclusion",
  };
  return titles[key] ?? key;
}

export default App;
