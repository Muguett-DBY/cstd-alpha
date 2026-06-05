type MarketWorkspaceProps = {
  onOpenRanking: (market: "A股" | "美股" | "港股") => void;
  onOpenWatchlistRanking: () => void;
  onOpenRadar: () => void;
};

export function MarketWorkspace({ onOpenRanking, onOpenWatchlistRanking, onOpenRadar }: MarketWorkspaceProps) {
  return (
    <section className="workbench-page market-page">
      <div className="workbench-hero compact">
        <div>
          <p className="eyebrow">市场工作区</p>
          <h1>排行、雷达和自选股评分入口</h1>
          <p className="hero-copy">旧功能保持兼容，未来逐步整合进机会台和研究工作区。</p>
        </div>
      </div>
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
