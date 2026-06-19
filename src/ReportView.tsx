import { useEffect, useMemo, useState } from "react";
import { downloadReportDocx } from "./docx/export-report";
import { printReportAsPdf } from "./pdf/export-report";
import { showToast } from "./toast-state";
import type { ChartBundle } from "./shared/chart";
import type { InvestmentReport, ModuleScore, ReportGenerationMetrics, ScoreItem } from "./shared/report";

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

export function ReportView({ report, metrics, onAddToWatchlist, isWatchlisted, chartBundle, onSaveComparison, comparisonReport }: { report: InvestmentReport; metrics?: ReportGenerationMetrics; onAddToWatchlist?: () => void; isWatchlisted?: boolean; chartBundle?: ChartBundle; onSaveComparison?: () => void; comparisonReport?: InvestmentReport | null }) {
  const tokenSummary = summarizeTokenUsage(metrics?.tokenUsage);
  const [activeSection, setActiveSection] = useState("scores");
  const [readProgress, setReadProgress] = useState(0);

  const navItems = useMemo(() => [
    { id: "scores", label: "评分" },
    { id: "conclusion", label: "结论" },
    { id: "scoreboard", label: "模块" },
    { id: "detailed-scores", label: "详细评分" },
    { id: "financials", label: "财务" },
    { id: "valuation", label: "估值" },
    { id: "risks", label: "风险" },
    { id: "evidence", label: "证据" },
  ], []);

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

  // Deep linking: sync active section to URL hash
  useEffect(() => {
    if (typeof window === "undefined" || !activeSection) return;
    const targetHash = `#${activeSection}`;
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, "", targetHash);
    }
  }, [activeSection]);

  // Read progress tracking
  useEffect(() => {
    const reportEl = document.querySelector<HTMLElement>(".report");
    if (!reportEl) return;
    const updateProgress = () => {
      const rect = reportEl.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      if (total <= 0) {
        setReadProgress(1);
        return;
      }
      const scrolled = -rect.top;
      const ratio = Math.max(0, Math.min(1, scrolled / total));
      setReadProgress(ratio);
    };
    updateProgress();
    window.addEventListener("scroll", updateProgress, { passive: true });
    window.addEventListener("resize", updateProgress);
    return () => {
      window.removeEventListener("scroll", updateProgress);
      window.removeEventListener("resize", updateProgress);
    };
  }, [report]);

  // Copy deep link to current section
  function copyDeepLink(sectionId: string) {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}#${sectionId}`;
    navigator.clipboard.writeText(url)
      .then(() => showToast("章节链接已复制，可粘贴分享。", "success"))
      .catch(() => showToast("复制失败，请手动复制地址栏链接。", "error"));
  }

  // Keyboard navigation: J/K or ArrowDown/Up to jump between sections
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const sections = navItems.map((item) => item.id);
      const currentIdx = sections.indexOf(activeSection);
      if (currentIdx < 0) return;
      let nextIdx: number | null = null;
      if (event.key === "j" || event.key === "J" || event.key === "ArrowDown") {
        nextIdx = Math.min(sections.length - 1, currentIdx + 1);
      } else if (event.key === "k" || event.key === "K" || event.key === "ArrowUp") {
        nextIdx = Math.max(0, currentIdx - 1);
      } else if (event.key === "Home") {
        nextIdx = 0;
      } else if (event.key === "End") {
        nextIdx = sections.length - 1;
      }
      if (nextIdx === null || nextIdx < 0 || nextIdx === currentIdx) return;
      event.preventDefault();
      const nextId = sections[nextIdx];
      const el = document.getElementById(nextId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setActiveSection(nextId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSection, navItems]);

  return (
    <article className="report">
      <div className="report-read-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(readProgress * 100)} aria-label="阅读进度">
        <div className="report-read-progress-bar" style={{ width: `${readProgress * 100}%` }} />
      </div>
      <nav className="report-section-nav" aria-label="报告章节">
        {navItems.map((item) => (
          <a key={item.id} href={`#${item.id}`} className={activeSection === item.id ? "active" : ""}>{item.label}</a>
        ))}
        <button type="button" className="report-copy-link" onClick={() => copyDeepLink(activeSection)} aria-label="复制当前章节链接">
          🔗 复制章节链接
        </button>
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
        <div className="report-actions">
          {onAddToWatchlist ? (
            <button type="button" className="secondary-button" onClick={onAddToWatchlist} disabled={isWatchlisted}>
              {isWatchlisted ? "已加入自选" : "加入自选"}
            </button>
          ) : null}
          <button type="button" className="secondary-button" onClick={() => downloadReportDocx(report, chartBundle)}>
            下载 Word
          </button>
          <button type="button" className="secondary-button" onClick={() => {
            try {
              printReportAsPdf(report);
              showToast("已打开打印窗口，可选择“另存为 PDF”。", "success");
            } catch {
              showToast("无法打开打印窗口，请检查浏览器打印权限。", "error");
            }
          }}>
            导出 PDF
          </button>
          <button type="button" className="secondary-button" onClick={() => {
            const text = `${report.company.name}（${report.company.ticker || "未知代码"}）\nCQS: ${report.cqs} / IAS: ${report.ias}\n结论: ${report.conclusion}（${report.qualitativeBand}）\n${report.oneSentence}`;
            navigator.clipboard.writeText(text).then(() => showToast("摘要已复制到剪贴板。", "success")).catch(() => showToast("复制失败，请手动选择复制。", "error"));
          }}>
            复制摘要
          </button>
          <button type="button" className="secondary-button" onClick={() => {
            const shareData = {
              title: `${report.company.name} 投资分析报告`,
              text: `${report.company.name}（${report.company.ticker || "未知代码"}）\nCQS: ${report.cqs} / IAS: ${report.ias}\n结论: ${report.conclusion}（${report.qualitativeBand}）\n${report.oneSentence}`,
            };
            if (navigator.share) {
              navigator.share(shareData).catch((err) => {
                if (err?.name !== "AbortError") {
                  navigator.clipboard.writeText(shareData.text)
                    .then(() => showToast("分享失败，摘要已复制到剪贴板。", "success"))
                    .catch(() => showToast("分享失败，请手动复制。", "error"));
                }
              });
            } else {
              navigator.clipboard.writeText(shareData.text).then(() => showToast("报告摘要已复制，可粘贴分享。", "success")).catch(() => showToast("复制失败，请手动选择复制。", "error"));
            }
          }}>
            分享
          </button>
          {onSaveComparison ? (
            <button type="button" className="secondary-button" onClick={onSaveComparison}>
              {comparisonReport ? "对比中" : "保存对比"}
            </button>
          ) : null}
        </div>
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
  const copyValue = () => navigator.clipboard.writeText(String(value))
    .then(() => showToast(`${label}: ${value}`, "success"))
    .catch(() => showToast("复制失败，请检查浏览器权限。", "error"));
  return (
    <div className="score-tile" onClick={copyValue} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyValue(); } }}>
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
      <strong>{value}</strong>
    </div>
  );
}

function ModuleRow({ module }: { module: ModuleScore }) {
  const scoreColor = module.score >= 70 ? "var(--teal)" : module.score >= 50 ? "var(--amber)" : "var(--red)";
  return (
    <div className="table-row">
      <span>{module.name}</span>
      <span>{module.weight}%</span>
      <span style={{ color: scoreColor, fontWeight: 700 }}>{module.score}</span>
      <span>{module.label}</span>
      <span className="muted">{module.summary}</span>
    </div>
  );
}

function ScoreItemCard({ item, index }: { item: ScoreItem; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const scoreColor = item.score >= 70 ? "var(--teal)" : item.score >= 50 ? "var(--amber)" : "var(--red)";
  return (
    <details className={`score-item-card ${item.score < 50 ? "low-score" : ""}`} open={expanded} onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="score-card-index">{index}</span>
        <span className="score-card-label">{item.label}</span>
        <div className="score-card-bar">
          <div className="score-card-bar-fill" style={{ width: `${item.score}%`, background: scoreColor }} />
        </div>
        <span className="score-card-score" style={{ color: scoreColor }}>{item.score}</span>
      </summary>
      <div className="score-card-body">
        <p>{item.reason}</p>
        {item.evidence.length ? (
          <div>
            <strong>证据</strong>
            <ul>{listItems(item.evidence)}</ul>
          </div>
        ) : null}
        {item.deductions.length ? (
          <div>
            <strong>扣分点</strong>
            <ul>{listItems(item.deductions)}</ul>
          </div>
        ) : null}
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

  const sortedRows = (() => {
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
  })();

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
  const va = report.valuationAnalysis;
  return (
    <details className="wide-section" id="valuation" open>
      <summary><h3>估值分析</h3></summary>
      <div className="valuation-table">
        <div className="valuation-row">
          <span>当前价格</span>
          <span>{va.currentPrice}</span>
        </div>
        <div className="valuation-row">
          <span>合理价值区间</span>
          <span>{va.fairValueRange}</span>
        </div>
        <div className="valuation-row">
          <span>买入区间</span>
          <span>{va.buyRange}</span>
        </div>
        <div className="valuation-row">
          <span>减持区间</span>
          <span>{va.sellReduceRange}</span>
        </div>
        <div className="valuation-row">
          <span>结论</span>
          <span className="muted">{va.conclusion}</span>
        </div>
      </div>
    </details>
  );
}

function RiskSection({ report }: { report: InvestmentReport }) {
  return (
    <details className="wide-section" id="risks" open>
      <summary><h3>风险清单</h3></summary>
      {report.riskMatrix.length ? (
        <ul className="risk-list">
          {report.riskMatrix.map((item) => (
            <li key={item.risk}>
              <span>{item.risk}</span>
              <small className="muted"> — {item.type} / {item.probability} / {item.impact}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>未识别到显著风险。</p>
      )}
    </details>
  );
}

function ReportBlock({ title, body, id }: { title: string; body: string; id?: string }) {
  return (
    <section className="report-block" id={id}>
      <h3>{title}</h3>
      {splitReportParagraphs(body).map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </section>
  );
}

function EvidenceList({ report }: { report: InvestmentReport }) {
  function copyEvidenceLink(evidenceIndex: number, evidence: { source: string; title?: string; url?: string }) {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}#evidence-${evidenceIndex}`;
    const text = `${evidence.source} - ${evidence.title || evidence.url || "查看详情"}\n${url}`;
    navigator.clipboard.writeText(text)
      .then(() => showToast("引用已复制到剪贴板，可粘贴分享。", "success"))
      .catch(() => showToast("复制失败，请手动复制。", "error"));
  }

  return (
    <section className="section-stack" id="evidence">
      <h3>证据引用</h3>
      {report.evidence.length ? (
        <ul className="evidence-list">
          {report.evidence.map((item, index) => (
            <li key={index} id={`evidence-${index}`}>
              <span className="evidence-source">{item.source}</span>
              {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}</a> : <span>{item.title}</span>}
              <button type="button" className="evidence-copy-btn" onClick={() => copyEvidenceLink(index, item)} aria-label={`复制第 ${index + 1} 条引用链接`}>
                复制
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">未附带引用来源。</p>
      )}
    </section>
  );
}

export function EmptyState() {
  return (
    <section className="empty-state">
      <h2>先选择具体上市公司</h2>
      <p>输入公司名后会先弹出候选项，确认公司名、代码和上市地点，再生成完整评分报告。</p>
      <p className="muted">快捷键：Ctrl+1 今日机会 / Ctrl+2 研究 / Ctrl+3 市场 / Ctrl+4 估值</p>
    </section>
  );
}
