import { useEffect, useMemo, useState } from "react";
import { fetchWatchlistRanking, refreshWatchlistRanking } from "./api";
import type { WatchlistRankingEntry, WatchlistRankingStatus } from "./shared/user-research";

type Props = {
  onOpenEntry: (entry: WatchlistRankingEntry) => void;
};

export function WatchlistRankingView({ onOpenEntry }: Props) {
  const [entries, setEntries] = useState<WatchlistRankingEntry[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "refreshing" | "error">("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void reload();
  }, []);

  async function reload() {
    setPhase("loading");
    setError("");
    try {
      const data = await fetchWatchlistRanking();
      setEntries(data.entries);
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "自选股排行读取失败。");
      setPhase("error");
    }
  }

  async function refreshAll(forceRefresh = false) {
    setPhase("refreshing");
    setError("");
    setNotice("");
    try {
      const data = await refreshWatchlistRanking({ forceRefresh, limit: 80 });
      setEntries((current) => mergeEntries(current, data.entries));
      setNotice(data.queued.length ? `已提交 ${data.queued.length} 个自选股重新评分任务。` : `已复用 ${data.reused.length} 个证据指纹未变的评分。`);
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "自选股排行刷新失败。");
      setPhase("error");
    }
  }

  async function refreshOne(entry: WatchlistRankingEntry, forceRefresh = true) {
    setPhase("refreshing");
    setError("");
    try {
      const data = await refreshWatchlistRanking({ watchlistId: entry.watchlistId, forceRefresh, limit: 1 });
      setEntries((current) => mergeEntries(current, data.entries));
      setNotice(`${entry.companyName} 已提交重新评分。`);
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "自选股评分刷新失败。");
      setPhase("error");
    }
  }

  const ranked = useMemo(() => [...entries].sort(compareWatchlistRanking), [entries]);
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const running = entries.filter((entry) => entry.status === "running").length;
  const top = ranked.find((entry) => entry.status === "completed");

  return (
    <section className="ranking-workspace" aria-labelledby="watchlist-ranking-title">
      <header className="ranking-header">
        <div>
          <p className="eyebrow">自选评分池</p>
          <h2 id="watchlist-ranking-title">自选股排行</h2>
          <p className="muted">不复用旧报告库分数；每家公司基于当前证据包和独立 DeepSeek 评分约束重新计算公司质量分与投资吸引力分。</p>
        </div>
        <div className="ranking-summary">
          <MetricTile label="自选股" value={`${entries.length}`} />
          <MetricTile label="已评分" value={`${completed}`} />
          <MetricTile label="评分中" value={`${running}`} />
          <MetricTile label="当前第一" value={top?.companyName || "待评分"} />
        </div>
      </header>

      <div className="ranking-tools watchlist-ranking-tools">
        <button type="button" onClick={() => void refreshAll(false)} disabled={phase === "refreshing" || !entries.length}>
          {phase === "refreshing" ? "提交中..." : "补齐缺失评分"}
        </button>
        <button type="button" className="secondary-button" onClick={() => void refreshAll(true)} disabled={phase === "refreshing" || !entries.length}>
          强制重评全部
        </button>
        <button type="button" className="ghost-button" onClick={() => void reload()} disabled={phase === "loading"}>
          刷新状态
        </button>
      </div>
      {notice ? <p className="cache-notice">{notice}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      <div className="ranking-table" role="table" aria-label="自选股评分排行">
        <div className="ranking-row watchlist-ranking-row ranking-row-head" role="row">
          <span>排名</span>
          <span>公司</span>
          <span>综合分</span>
          <span>公司质量</span>
          <span>投资吸引力</span>
          <span>状态</span>
          <span>结论</span>
          <span>操作</span>
        </div>
        {phase === "loading" ? (
          <div className="ranking-row watchlist-ranking-row ranking-row-loading" role="row">
            <span>读取中</span>
            <span>正在读取自选股评分...</span>
            <span>--</span>
            <span>--</span>
            <span>--</span>
            <span>--</span>
            <span>--</span>
            <span>--</span>
          </div>
        ) : null}
        {ranked.map((entry, index) => (
          <div key={entry.watchlistId} className="ranking-row watchlist-ranking-row is-report" role="row">
            <span>{entry.status === "completed" ? `#${index + 1}` : "--"}</span>
            <button type="button" className="ranking-company" onClick={() => onOpenEntry(entry)}>
              <strong>{entry.companyName}</strong>
              <small>
                {entry.ticker} / {entry.listingPlace || entry.market}
              </small>
            </button>
            <span>{formatScore(entry.overallScore)}</span>
            <span>{formatScore(entry.companyQualityScore)}</span>
            <span>{formatScore(entry.investmentAttractivenessScore)}</span>
            <span>{statusLabel(entry.status)}</span>
            <span>{entry.verdict || entry.summary || "待评分"}</span>
            <span className="ranking-actions">
              <button type="button" className="secondary-button" onClick={() => onOpenEntry(entry)}>
                查看
              </button>
              <button type="button" className="ghost-button" onClick={() => void refreshOne(entry)} disabled={phase === "refreshing"}>
                重评
              </button>
            </span>
          </div>
        ))}
        {!ranked.length && phase !== "loading" ? <p className="muted ranking-empty-note">还没有自选股，先到“我的”里添加公司。</p> : null}
      </div>
    </section>
  );
}

function compareWatchlistRanking(left: WatchlistRankingEntry, right: WatchlistRankingEntry) {
  return (right.overallScore ?? -1) - (left.overallScore ?? -1) || left.companyName.localeCompare(right.companyName, "zh-CN");
}

function mergeEntries(current: WatchlistRankingEntry[], incoming: WatchlistRankingEntry[]) {
  const byId = new Map(current.map((entry) => [entry.watchlistId, entry]));
  for (const entry of incoming) byId.set(entry.watchlistId, entry);
  return Array.from(byId.values());
}

function formatScore(value: number | undefined) {
  return Number.isFinite(value) ? Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1) : "待评分";
}

function statusLabel(status: WatchlistRankingStatus) {
  if (status === "completed") return "已完成";
  if (status === "running") return "评分中";
  if (status === "failed_retryable") return "可重试";
  if (status === "failed") return "失败";
  return "待评分";
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="ranking-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default WatchlistRankingView;
