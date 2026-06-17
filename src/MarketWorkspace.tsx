import { useEffect, useState } from "react";
import { fetchRadarScan, fetchWatchlistRanking } from "./api";
import type { RadarScan } from "./shared/radar";
import type { WatchlistRankingEntry } from "./shared/user-research";

type MarketWorkspaceProps = {
  onOpenRanking: (market: "A股" | "美股" | "港股") => void;
  onOpenWatchlistRanking: () => void;
  onOpenRadar: () => void;
};

export function MarketWorkspace({ onOpenRanking, onOpenWatchlistRanking, onOpenRadar }: MarketWorkspaceProps) {
  const [radar, setRadar] = useState<RadarScan | null>(null);
  const [rankingEntries, setRankingEntries] = useState<WatchlistRankingEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([fetchRadarScan(), fetchWatchlistRanking()])
      .then(([radarResult, rankingResult]) => {
        if (cancelled) return;
        if (radarResult.status === "fulfilled" && radarResult.value.radar) setRadar(radarResult.value.radar);
        if (rankingResult.status === "fulfilled") setRankingEntries(rankingResult.value.entries);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const radarStats = radar ? {
    total: (radar.solidGrowth?.length ?? 0) + (radar.sustainability?.length ?? 0) + (radar.bubbleRisks?.length ?? 0) + (radar.upcomingGrowth?.length ?? 0) + (radar.decliningIndustries?.length ?? 0),
    growth: radar.solidGrowth?.length ?? 0,
    bubble: radar.bubbleRisks?.length ?? 0,
    decline: radar.decliningIndustries?.length ?? 0,
  } : null;

  const hotTopics = radar ? [
    ...radar.solidGrowth?.slice(0, 3).map((item) => ({ title: item.title, type: "增长", color: "growth" as const })) ?? [],
    ...radar.bubbleRisks?.slice(0, 2).map((item) => ({ title: item.title, type: "泡沫", color: "bubble" as const })) ?? [],
    ...radar.upcomingGrowth?.slice(0, 2).map((item) => ({ title: item.title, type: "即将增长", color: "upcoming" as const })) ?? [],
  ].slice(0, 7) : [];

  const topRanked = [...rankingEntries]
    .filter((e) => e.status === "completed")
    .sort((a, b) => (b.overallScore ?? -1) - (a.overallScore ?? -1))
    .slice(0, 5);

  return (
    <section className="workbench-page market-page">
      <div className="workbench-hero compact">
        <div>
          <p className="eyebrow">市场工作区</p>
          <h1>排行、雷达和自选股评分入口</h1>
          <p className="hero-copy">从市场数据中发现机会，用雷达扫描行业趋势。</p>
        </div>
      </div>

      {radarStats ? (
        <div className="terminal-panel market-overview">
          <header className="panel-header">
            <h2>市场概览</h2>
            <p>最近一次雷达扫描的关键数据。</p>
          </header>
          <div className="market-stats">
            <div className="market-stat"><strong>{radarStats.total}</strong><span>扫描行业</span></div>
            <div className="market-stat growth"><strong>{radarStats.growth}</strong><span>扎实增长</span></div>
            <div className="market-stat bubble"><strong>{radarStats.bubble}</strong><span>泡沫风险</span></div>
            <div className="market-stat decline"><strong>{radarStats.decline}</strong><span>衰退</span></div>
          </div>
        </div>
      ) : null}

      {hotTopics.length > 0 ? (
        <div className="terminal-panel market-overview">
          <header className="panel-header">
            <h2>今日热点</h2>
            <p>雷达扫描发现的关键行业动态。</p>
          </header>
          <div className="hot-topics-grid">
            {hotTopics.map((topic, index) => (
              <div key={index} className={`hot-topic-item ${topic.color}`}>
                <span className="hot-topic-type">{topic.type}</span>
                <strong>{topic.title}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {topRanked.length > 0 ? (
        <div className="terminal-panel market-overview">
          <header className="panel-header">
            <h2>自选股排行前列</h2>
            <p>综合评分最高的自选股。</p>
          </header>
          <div className="market-ranked-list">
            {topRanked.map((entry, index) => (
              <div key={entry.watchlistId} className="market-ranked-item">
                <span className="rank">#{index + 1}</span>
                <div className="market-ranked-info">
                  <strong>{entry.companyName}</strong>
                  <span>{entry.ticker} / {entry.market}</span>
                </div>
                <div className="market-ranked-score">
                  <strong>{entry.overallScore ?? "—"}</strong>
                  <span>综合分</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="market-launch-grid">
        <MarketLauncher title="A 股排行" description="查看 A 股评分库、行业筛选和完整报告。" onClick={() => onOpenRanking("A股")} />
        <MarketLauncher title="美股排行" description="查看美股评分库和全球科技龙头。" onClick={() => onOpenRanking("美股")} />
        <MarketLauncher title="港股排行" description="查看港股互联网、金融和高股息标的。" onClick={() => onOpenRanking("港股")} />
        <MarketLauncher title="自选股排行" description="对我的自选股做质量和吸引力排序。" onClick={onOpenWatchlistRanking} />
        <MarketLauncher title="全行业雷达" description="查看行业增长、泡沫和衰退扫描。" onClick={onOpenRadar} />
      </div>
    </section>
  );
}

function MarketLauncher({ title, description, onClick }: { title: string; description: string; onClick: () => void }) {
  return (
    <button type="button" className="terminal-panel market-launcher" onClick={onClick}>
      <strong>{title}</strong>
      <span>{description}</span>
    </button>
  );
}
