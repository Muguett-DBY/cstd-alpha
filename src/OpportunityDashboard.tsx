import { useEffect, useMemo, useRef, useState } from "react";
import { addResearchItem, fetchOpportunities, type OpportunitiesResult } from "./api";
import { RESEARCH_STAGE_LABELS, RESEARCH_STAGES, type ResearchOpportunitySignal } from "./shared/research-workbench";
import { loadRecentReportHistory } from "./storage";
import { showToast } from "./toast-state";

type Props = {
  onOpenResearch: () => void;
};

export function OpportunityDashboard({ onOpenResearch }: Props) {
  const [data, setData] = useState<OpportunitiesResult | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "radar" | "watchlist" | "hybrid">("all");
  const [minScore, setMinScore] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchOpportunities()
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setPhase("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : "今日机会读取失败。");
        setPhase("error");
      });
    return () => { cancelled = true; };
  }, []);

  const allOpportunities = useMemo(() => data?.opportunities ?? [], [data]);
  const sourceBreakdown = useMemo(() => {
    const counts = { radar: 0, watchlist: 0, hybrid: 0 };
    for (const item of allOpportunities) counts[item.source] += 1;
    return counts;
  }, [allOpportunities]);
  const matrixItems = useMemo(() => allOpportunities
    .filter((item) => sourceFilter === "all" || item.source === sourceFilter)
    .filter((item) => item.opportunityScore >= minScore)
    .slice(0, 36), [allOpportunities, sourceFilter, minScore]);

  const [recentCutoff] = useState(() => Date.now() - 7 * 24 * 60 * 60 * 1000);

  const portfolioHealth = useMemo(() => {
    if (!data) return null;
    const items = data.researchItems;
    const total = items.length;
    const withThesis = items.filter((i) => i.currentThesisVersionId).length;
    const withEvidence = items.filter((i) => i.evidenceHash).length;
    const recentlyUpdated = items.filter((i) => new Date(i.updatedAt).getTime() > recentCutoff).length;
    const active = items.filter((i) => i.stage !== "archived").length;
    const completeness = total > 0 ? Math.round(((withThesis + withEvidence) / (total * 2)) * 100) : 0;
    return { total, active, withThesis, withEvidence, recentlyUpdated, completeness };
  }, [data, recentCutoff]);

  async function queueResearch(item: ResearchOpportunitySignal) {
    try {
      await addResearchItem({
        entityType: item.entityType,
        entityId: item.entityId,
        title: item.title,
        subtitle: item.subtitle,
        source: item.source,
        stage: item.stage,
      });
      showToast(`${item.title} 已加入研究队列。`, "success");
      onOpenResearch();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "加入研究队列失败。", "error");
    }
  }

  return (
    <section className="workbench-page opportunities-page">
      <div className="workbench-hero">
        <div>
          <p className="eyebrow">今日研究机会</p>
          <h1>从证据变化里筛出值得研究的机会</h1>
          <p className="hero-copy">后台复用雷达、公司证据包和自选排行做规则评分，不在后台自动调用模型。</p>
        </div>
        <div className="hero-kpis">
          <Kpi label="机会信号" value={data?.opportunities.length ?? 0} />
          <Kpi label="研究队列" value={data?.researchItems.length ?? 0} />
          <Kpi label="风险恶化" value={data?.riskWorsening.length ?? 0} />
        </div>
      </div>

      {phase === "loading" ? <div className="workbench-empty">正在读取机会快照…</div> : null}
      {phase === "error" ? (
        <div className="workbench-empty error">
          <p>{message}</p>
          <button type="button" className="secondary-button" onClick={() => { setPhase("loading"); setMessage(""); void fetchOpportunities().then((next) => { setData(next); setPhase("ready"); }).catch((error) => { setMessage(error instanceof Error ? error.message : "今日机会读取失败。"); setPhase("error"); }); }}>重试</button>
        </div>
      ) : null}
      {phase === "ready" && data ? (
        <>
          {portfolioHealth && portfolioHealth.total > 0 ? (
            <div className="terminal-panel portfolio-health">
              <PanelHeader title="研究概况" subtitle="你的研究组合健康度概览。" />
              <div className="health-metrics">
                <div className="health-metric">
                  <strong>{portfolioHealth.total}</strong>
                  <span>研究项</span>
                  <small>{portfolioHealth.active} 项进行中</small>
                </div>
                <div className="health-metric">
                  <strong>{portfolioHealth.withThesis}</strong>
                  <span>已生成论点</span>
                  <small>{portfolioHealth.total > 0 ? Math.round((portfolioHealth.withThesis / portfolioHealth.total) * 100) : 0}%</small>
                </div>
                <div className="health-metric">
                  <strong>{portfolioHealth.withEvidence}</strong>
                  <span>已采集证据</span>
                  <small>{portfolioHealth.total > 0 ? Math.round((portfolioHealth.withEvidence / portfolioHealth.total) * 100) : 0}%</small>
                </div>
                <div className="health-metric">
                  <strong>{portfolioHealth.recentlyUpdated}</strong>
                  <span>7 天内更新</span>
                  <small>最近活跃</small>
                </div>
                <div className="health-metric highlight">
                  <strong>{portfolioHealth.completeness}%</strong>
                  <span>完成度</span>
                  <meter min="0" max="100" value={portfolioHealth.completeness} />
                </div>
              </div>
              <div className="health-stages">
                {RESEARCH_STAGES.map((stage) => {
                  const count = data.researchItems.filter((i) => i.stage === stage).length;
                  return count > 0 ? (
                    <span key={stage} className="stage-pill">{RESEARCH_STAGE_LABELS[stage]} {count}</span>
                  ) : null;
                })}
              </div>
            </div>
          ) : null}

          {(() => {
            const recentReports = loadRecentReportHistory();
            return recentReports.length > 0 ? (
              <div className="terminal-panel recent-reports">
                <PanelHeader title="最近报告" subtitle="点击快速查看。" />
                <div className="recent-reports-list">
                  {recentReports.slice(0, 5).map((report, index) => (
                    <div key={index} className="recent-report-item">
                      <div className="recent-report-info">
                        <strong>{report.name}</strong>
                        <span>{report.ticker}</span>
                      </div>
                      <div className="recent-report-scores">
                        <span>CQS {report.cqs}</span>
                        <span>IAS {report.ias}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
          })()}

          <div className="opportunity-grid">
            <div className="terminal-panel matrix-panel">
              <PanelHeader title="机会与风险矩阵" subtitle="横轴为研究价值，纵轴为风险；气泡大小代表证据强度。" />
              <div className="opportunity-filters" role="group" aria-label="机会筛选">
                <div className="opportunity-filter-group">
                  <span className="filter-label">信号源</span>
                  <div className="opportunity-filter-pills">
                    {[
                      { key: "all" as const, label: `全部 (${allOpportunities.length})` },
                      { key: "radar" as const, label: `雷达 (${sourceBreakdown.radar})` },
                      { key: "watchlist" as const, label: `自选 (${sourceBreakdown.watchlist})` },
                      { key: "hybrid" as const, label: `混合 (${sourceBreakdown.hybrid})` },
                    ].map((opt) => (
                      <button key={opt.key} type="button" className={`opportunity-filter-pill ${sourceFilter === opt.key ? "active" : ""}`} onClick={() => setSourceFilter(opt.key)}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="opportunity-filter-group">
                  <label className="filter-label" htmlFor="opportunity-min-score">
                    最低机会分: <strong>{minScore}</strong>
                  </label>
                  <input id="opportunity-min-score" type="range" min="0" max="100" step="5" value={minScore} onChange={(e) => setMinScore(Number(e.currentTarget.value))} className="opportunity-score-slider" />
                </div>
                <div className="opportunity-filter-count">
                  匹配 <strong>{matrixItems.length}</strong> / {allOpportunities.length}
                </div>
              </div>
              <OpportunityMatrix items={matrixItems} onSelect={queueResearch} />
            </div>
            <div className="terminal-panel">
              <PanelHeader title="五阶段研究漏斗" subtitle="只有用户确认才改变阶段。" />
              <ResearchFunnel funnel={data.funnel} />
            </div>
          </div>

          <div className="opportunity-columns">
            <OpportunityList title="值得研究排行榜" items={data.topResearch.slice(0, 10)} actionLabel="加入研究" onAction={queueResearch} />
            <OpportunityList title="风险恶化榜" items={data.riskWorsening.slice(0, 10)} tone="risk" actionLabel="加入排雷" onAction={queueResearch} />
            <OpportunityList title="证据变化与催化剂" items={data.catalysts.slice(0, 10)} tone="catalyst" actionLabel="跟踪" onAction={queueResearch} />
          </div>

          <div className="terminal-panel inbox-panel">
            <PanelHeader title="站内研究收件箱" subtitle="证据变化只生成提醒，刷新论点需要用户主动触发。" />
            {data.inbox.length ? (
              <div className="inbox-list">
                {data.inbox.map((item) => (
                  <article key={item.id} className="inbox-item">
                    <span className={`status-dot ${item.severity}`} />
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.body}</p>
                    </div>
                    <time>{formatDate(item.createdAt)}</time>
                  </article>
                ))}
              </div>
            ) : (
              <div className="workbench-empty compact">暂无新的研究提醒。</div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

async function loadOpportunityECharts() {
  return import("./echarts-loader").then((module) => module.loadSharedECharts());
}

function OpportunityMatrix({ items, onSelect }: { items: ResearchOpportunitySignal[]; onSelect: (item: ResearchOpportunitySignal) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let chart: import("echarts/core").EChartsType | undefined;
    if (!ref.current) return undefined;
    void loadOpportunityECharts().then((echarts) => {
      if (disposed || !ref.current) return;
      chart = echarts.init(ref.current, undefined, { renderer: "canvas" });
      chart.setOption({
        grid: { left: 48, right: 24, top: 28, bottom: 42 },
        tooltip: {
          trigger: "item",
          formatter: (params: { data?: [number, number, number, string, string] }) => {
            const data = params.data;
            if (!data) return "";
            return `${data[3]}<br/>研究价值 ${data[0]} / 风险 ${data[1]}<br/>${data[4]}`;
          },
        },
        xAxis: { name: "研究价值", min: 0, max: 100, splitLine: { lineStyle: { color: "var(--line)" } } },
        yAxis: { name: "风险", min: 0, max: 100, splitLine: { lineStyle: { color: "var(--line)" } } },
        series: [{
          type: "scatter",
          symbolSize: (value: [number, number, number]) => Math.max(16, Math.min(54, value[2] / 2.2)),
          data: items.map((item) => [item.opportunityScore, item.riskScore, item.evidenceScore, item.title, item.subtitle]),
          itemStyle: {
            color: (params: { data?: [number, number] }) => {
              const data = params.data;
              if (!data) return "var(--blue)";
              if (data[0] >= 70 && data[1] < 55) return "var(--red)";
              if (data[1] >= 70) return "#7b4ea3";
              if (data[0] >= 60) return "var(--amber)";
              return "var(--blue)";
            },
            opacity: 0.82,
          },
        }],
      });
      chart.on("click", (params: { dataIndex?: number }) => {
        const item = typeof params.dataIndex === "number" ? items[params.dataIndex] : undefined;
        if (item) onSelect(item);
      });
    });
    const resize = () => chart?.resize();
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      chart?.dispose();
    };
  }, [items, onSelect]);

  if (!items.length) return <div className="workbench-empty compact">暂无机会数据。</div>;
  return <div ref={ref} className="opportunity-matrix" aria-label="机会与风险矩阵" />;
}

function OpportunityList({ title, items, tone = "default", actionLabel, onAction }: { title: string; items: ResearchOpportunitySignal[]; tone?: "default" | "risk" | "catalyst"; actionLabel: string; onAction: (item: ResearchOpportunitySignal) => void }) {
  return (
    <div className={`terminal-panel opportunity-list ${tone}`}>
      <PanelHeader title={title} subtitle="" />
      {items.length ? items.map((item, index) => (
        <article key={item.id} className="opportunity-row">
          <span className="rank">{index + 1}</span>
          <div className="opportunity-row-main">
            <strong>{item.title}</strong>
            <p>{item.subtitle}</p>
            <small>{item.reasons.slice(0, 2).join(" / ")}</small>
          </div>
          <div className="score-stack">
            <b>{item.opportunityScore}</b>
            <span>价值</span>
          </div>
          <button type="button" className="ghost-action" onClick={() => onAction(item)}>{actionLabel}</button>
        </article>
      )) : <div className="workbench-empty compact">暂无数据。</div>}
    </div>
  );
}

function ResearchFunnel({ funnel }: { funnel: Array<{ stage: string; count: number }> }) {
  const max = Math.max(...funnel.map((item) => item.count), 1);
  return (
    <div className="research-funnel">
      {funnel.map((item) => (
        <div className="funnel-row" key={item.stage}>
          <span>{stageLabel(item.stage)}</span>
          <div><i style={{ width: `${Math.max(8, (item.count / max) * 100)}%` }} /></div>
          <b>{item.count}</b>
        </div>
      ))}
    </div>
  );
}

function stageLabel(stage: string) {
  const legacy: Record<string, string> = {
    waitingCatalyst: RESEARCH_STAGE_LABELS.awaitingCatalyst,
    thesisFormed: RESEARCH_STAGE_LABELS.opinionFormed,
  };
  return RESEARCH_STAGE_LABELS[stage as keyof typeof RESEARCH_STAGE_LABELS] ?? legacy[stage] ?? stage;
}

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="panel-header">
      <h2>{title}</h2>
      {subtitle ? <p>{subtitle}</p> : null}
    </header>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="hero-kpi">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("zh-CN") : value;
}

export default OpportunityDashboard;
